# MCP workflows

Tool sequences for each level, spend safety, and error recovery. Tools are referred to by name only: read the schema the server advertises for arguments. Run `get_capabilities` first and obey its `runLevel`.

## Which tools exist where

| Server | Tools |
|---|---|
| Read-only (no signer) | `get_capabilities`, `derive_source_id`, `describe_feed`, `get_latest_value`, `describe_access`, `get_x402_status`, `list_providers`, `get_provider`, `quote_source_payment`, `build_verifier_calldata` |
| Local, with a signer | The read tools above, plus `execute_subscription_round`, `execute_x402_round`, `submit_attestation` |
| Hosted (holds no key) | The read tools, plus the split flows below. The caller's own wallet signs |

On a read-only server, `describe_feed` and `get_latest_value` need an explicit `submitter` because there is no signer to default to.

## Level 0: explore, no wallet

1. `get_capabilities`: program id, registry version, node set, chains, verifier addresses, x402 caps. Read `runLevel`.
2. `list_providers`, then `get_provider` for one provider: its flows, whether a flow is free (the gateway holds the key) or paid per node fetch, and ready-made feeds with a complete `apiConfig` and `sourceId`.
3. `derive_source_id` for any `apiConfig` the user describes. It returns the canonical JSON so the preimage can be audited, and warnings about determinism.
4. `describe_feed` or `get_latest_value` with a `submitter` to read a feed. `describe_access` with an `owner` to see whether a wallet has a subscription or is a delegate.
5. `quote_source_payment` to price a paywalled source, and `get_x402_status` to price an x402 round.

Nothing here signs or spends.

## Get a signed value (local server, live or dry-run)

1. `derive_source_id`. Fix any determinism warning before paying for a round (see `references/apiconfig.md`).
2. Choose how the round is paid:
   - **Subscription:** `describe_access` with the signer's address shows whether a subscription is active. Use `execute_subscription_round`.
   - **x402 pay-per-request:** no setup. `get_x402_status` for the quoted price, balance and the remaining daily budget. Use `execute_x402_round`.
3. **Preview first.** Call the round tool with `dryRun: true`. Show the user the preview: source, quorum, payment path, price. For x402 the preview verifies the gateway's payment terms without signing.
4. Only if the user agrees and `runLevel` is `live`, call it again without `dryRun`. Under `dry-run` the server will not go live; tell the user instead of retrying.
5. Keep the whole result. It carries the signed attestation and prebuilt verifier arguments for each chain you asked for (`chains`).

Quorum: `signaturesRequired` must be at least the protocol minimum (currently 3). Tolerance-mode sources need at least 3.

## Settle on Solana

Either pass `autoSubmit: true` to the round tool, or call `submit_attestation` with the round's output **unmodified**. Both accept the round's shape as-is. The program only accepts an attestation strictly newer than the feed's current one, so resubmitting the same payload changes nothing. Then read it back with `get_latest_value`, passing the submitter you used.

If `autoSubmit` fails, the round result is still returned in full. Keep it and call `submit_attestation`; do not run a new round.

## Verify on EVM or Starknet

1. `build_verifier_calldata` with the round's attestation and `chain`. It returns the verifier address and `verify()` arguments. It does not send anything.
2. The caller (you, in code, or the user's contract) calls `verify(attestation, maxAge)` and reads `(success, code)`. Choose `maxAge` deliberately in seconds; `0` disables freshness.
3. Report `success` and the code name, not "verified" alone. See the chain references for the codes and the consumer-side checks that `verify` does not do.

## Provider feeds

`get_provider` tells you each flow's access mode:

- **Key held by the gateway (free to you).** Pass the feed's `apiConfig` to `execute_subscription_round` **unchanged**, with `signaturesRequired` of at least 3. Adding a header or key changes the `sourceId` and is refused.
- **Paid per node fetch.** Every node that fetches is paid. Call `quote_source_payment` for price and worst case, then `execute_subscription_round` with `sourcePayment: { maxSpendUsdc }` set to a value that covers the worst case. Paying is off unless the server has a payer wallet and an allowed network, and a paywalled source called without `sourcePayment` is never paid. There is no automatic retry once payment is signed.

Describe provider values as attested provider quotes: Molpha attests what the endpoint returned, not that the price is right. `get_provider` returns the provider's own disclosure.

## Hosted server flows

The hosted server holds no key. Each operation is two or three calls around one signature by the caller's wallet:

| Operation | Calls | The wallet signs |
|---|---|---|
| Subscription round | `begin_session`, `complete_session`, `execute_subscription_round` | A text message, once per session |
| x402 round | `prepare_x402_round`, `execute_x402_round` | A USDC transfer, not broadcast |
| Solana submit | `prepare_submit_attestation`, `send_signed_transaction` | The submit transaction |

Sign exactly what was returned, unchanged. Do not broadcast the x402 transfer yourself. If a prepared transaction or payment expires, call the prepare tool again.

## Spend safety checklist

- Read the run level. Say it.
- Quote the price. Say it.
- Preview with `dryRun: true`. Show it.
- One write call. If it fails unclearly, read state; do not repeat it.
- `payment_outcome_unknown` means a payment may have settled: do not pay again until the user has checked the transfer memo in the wallet's USDC account.
- Daily caps are per server process and reset on restart; they are a safety rail, not a durable limit.

## Error recovery

| Code | Meaning | Do |
|---|---|---|
| `dry_run_locked` | The server is locked to previews | Tell the user. Only they can unlock it in the server config. Retry with `dryRun: true` for a preview |
| `missing_config` | A required setting is absent | Say which setting; do not ask for secrets in chat |
| `authentication_required` | The operation needs a signer this server does not hold | Read-only or hosted server: explain the setup or use the split flow |
| `submitter_required` | A read needs a wallet address | Pass `submitter` |
| `subscription_inactive` | No active subscription or out of quota | Offer `execute_x402_round`, or the provisioning step in the setup docs |
| `source_payment_required` | The source is paywalled and the call did not authorize paying | `quote_source_payment`, then retry with `sourcePayment` if the user agrees |
| `source_payment_refused` | A cap or policy refused the payment; nothing was signed | Read the message; raise the authorization only if the user agrees and it is within server caps |
| `source_payment_disabled` | No payer wallet or allowed network configured | Explain the server settings; do not ask for the key in chat |
| `payment_outcome_unknown` | A payment may have settled | Stop. Do not pay again. Check the memo in the signer's USDC account |
| `guardrail_exceeded` | A configured cap was reached | Report it; wait or let the user change the cap |
| `determinism_rejected` | The source looks live-drifting | Use a settled source, or tolerance mode (`references/apiconfig.md`) |
| `round_conflict` | HTTP 409: this wallet already has a round for this feed (the same source and quorum) in the current 100 ms tick, or an x402 payment already reserved a round. Requests in one tick share a round; a feed runs at most 10 rounds per second | Wait at least 100 ms, then call again for a new round. An x402 call signs a new payment |
| `round_timeout` | HTTP 503: usually the gateway's own capacity limit (`gateway at capacity`; nothing was reserved), otherwise too few nodes completed the round. Or the upstream timed out | Wait; do not retry at once. The round may still complete: read state before any retry |
| `invalid_config` | A setting is wrong, often the gateway URL or authority | Report the message |
| `session_invalid`, `sign_in_rejected` | Hosted sign-in expired or was refused | Call `begin_session` again |
| `invalid_challenge`, `payment_expired`, `transaction_expired` | Hosted prepare output is stale or altered | Call the prepare tool again |
