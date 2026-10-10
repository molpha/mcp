# Reference

Details behind the tools in the [README](../README.md). For setup see [integration.md](integration.md); for the hosted server see [hosted-http.md](hosted-http.md).

- [Structured output and annotations](#structured-output-and-annotations)
- [Round timing](#round-timing)
- [How sourceId is derived](#how-sourceid-is-derived)
- [Tolerance mode](#tolerance-mode)
- [x402 pay-per-request](#x402-pay-per-request)
- [Integrated providers](#integrated-providers)
- [Configuration](#configuration)
- [Signers](#signers)

## Structured output and annotations

Every tool declares an `outputSchema` and returns its result as `structuredContent`, with the same JSON in a text block for clients that do not read structured content. The round tools' `value`, `fresh`, `dataUpdate`, and `signature` fields follow one canonical signed-artifact schema — the same shape `submit_attestation` and `build_verifier_calldata` accept — so a round's output passes to either without remapping. If a result ever fails to match its schema, the tool still returns it in full, flagged as an error, rather than dropping it — so a schema mismatch cannot discard a paid round's signed artifact.

Each tool also carries MCP annotations, so clients can decide what needs confirmation:

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- |
| `get_capabilities`, `describe_feed`, `get_latest_value`, `describe_access`, `get_x402_status`, `list_providers`, `get_provider`, `quote_source_payment` | `true` | — | — | `true` |
| `derive_source_id`, `build_verifier_calldata` | `true` | — | — | `false` |
| `execute_subscription_round`, `execute_x402_round` | `false` | `true` | `false` | `true` |
| `submit_attestation` | `false` | `false` | `true` | `true` |

The round tools are marked destructive because each call irreversibly spends subscription quota or USDC, and a repeated call pays for another round. There is no idempotency key: a call repeated after a failure is a new round that uses another unit of quota or needs another payment. `submit_attestation` only ever advances the signer's own feed: the program accepts an attestation only if it is newer than the one the feed holds, so resubmitting the same payload changes nothing.

`submit_attestation` and `build_verifier_calldata` take a round tool's response as-is: no field remapping between calls, and short hex fields (the gateway emits a one-signer `signersBitmap` as `"4"`) are zero-padded to their canonical widths server-side.

`build_verifier_calldata` stops at calldata **by design**: the Molpha verifier is stateless, so the agent executes `verify()` itself and the server never submits an EVM/Starknet transaction or vouches for a result it did not verify on-chain. Solana is the one leg this server settles — via `submit_attestation` or a round tool's `autoSubmit` — and there is no standalone Solana verify-simulation path; submit, then read the result back with `get_latest_value`.

Solana feed accounts are keyed by `(sourceId, signaturesRequired, submitter)`: every wallet that submits a source maintains its own feed for it, created by that wallet's first `submit_attestation`. `describe_feed` and `get_latest_value` default `submitter` to this server's signer; pass another wallet's address to read the feed it maintains.

## Round timing

Rounds run on a fixed 100 ms tick. It is a protocol constant, not a setting: the gateway stamps each round with its own clock rounded down to a multiple of 100 ms (the attestation's `timestamp`, in unix milliseconds), and nodes reject a round that is off that grid. The caller never supplies the timestamp. It follows that:

- Requests for one feed (the same source, quorum and registry version) inside one tick share a round: the nodes run it once and every caller gets the result.
- One feed runs at most 10 rounds per second, whatever the request rate.
- One wallet gets at most one round per tick for a feed. A second request from the same consumer or payer inside the same tick is answered with HTTP 409 before anything is reserved.

`execute_x402_round` and the hosted `execute_subscription_round` repeat a request answered with 409 once, after one full tick plus a small jitter (100 to 120 ms), which lands it in a later tick whatever the offset between the two clocks. A request refused again fails with `round_conflict`: wait at least 100 ms and call again. The local `execute_subscription_round` goes through `@molpha/sdk`, which retries a 409 on its own schedule.

HTTP 503 is reported as `round_timeout` (after an x402 payment was sent, as `payment_outcome_unknown`: see [x402 pay-per-request](#x402-pay-per-request)). The usual cause is the gateway's own capacity limit (`gateway at capacity`): the gateway refuses the request before reading it, so nothing was reserved or spent. Otherwise too few nodes accepted or finished the round, or it timed out; a node refuses a gateway only as a safety limit against one that floods it. The tools do not repeat a request after a 503: wait, read state (`describe_feed`, `get_x402_status`), then call again.

## How sourceId is derived

A source is identified by its API config alone — not by the quorum or the signer — and the same `sourceId` identifies it on Solana, EVM, and Starknet:

```text
sourceId      = keccak256(canonicalJson)
canonicalJson = compact JSON of { url, method, headers, responseParser, valueTransform },
                keys in exactly that order, with defaults method = "GET", headers = {},
                valueTransform = "", and header names sorted
```

Median tolerance mode adds a final `aggregation` key (see [Tolerance mode](#tolerance-mode)); exact-mode configs omit it and keep their existing `sourceId`s.

The SDK, gateway, and nodes all derive it this way. It is **not** RFC 8785 (JCS): JCS sorts the top-level keys, which hashes to a different id. Call `derive_source_id` rather than hashing client-side — one differing byte (key order, whitespace, a missing default, header order) produces a `sourceId` that points at the wrong feed and fails verification. The tool returns `canonicalJson` so the preimage can be audited.

## Tolerance mode

By default nodes must fetch a byte-identical value to co-sign. For a live-drifting source, set `apiConfig.aggregation` to let the nodes sign the **median** of their fresh observations instead:

```json
"aggregation": {
  "mode": "tolerance",
  "rule": "median",
  "maxDeviationBps": 50,
  "maxAgeMs": 2000,
  "numeric": { "type": "int256", "decimals": 8 }
}
```

- `aggregation` is part of the `sourceId`, so a source's tolerance settings cannot change without changing its identity. Omit it for exact mode; `"mode": "exact"` is rejected because writing it would change the identity.
- The round needs `signaturesRequired >= 3`; the tools refuse fewer before contacting a gateway or paying.
- The transformed value is parsed as a decimal, scaled by `10^decimals` (round half to even) and signed as a **signed int256**: a two's-complement `bytes32`. Decode it with the same `decimals`; the feed account stores those 32 bytes verbatim. Leave `valueTransform` empty in this mode: it runs on each node before scaling, and a `multiply:` transform truncates to an integer first (`100.125` would sign as `100`).
- Nodes exchange signed round-1 observations (up to about 5 seconds), drop values more than `maxDeviationBps` from the lower median, rank the survivors, and the first `signaturesRequired` of them sign. A round fails when too few survivors remain.

## x402 pay-per-request

Each way of paying for a round has its own tool:

- `execute_subscription_round` — use the signer's active USDC subscription (see [Turn on spending](integration.md#3-turn-on-spending)). Fails if the subscription is inactive or out of quota.
- `execute_x402_round` — pay for the round itself with an [x402](https://github.com/x402-foundation/x402) `exact` payment on Solana, with no subscription required. The signer transfers the round price in USDC to the protocol treasury (the USDC account of the `ProtocolConfig` PDA); the gateway's facilitator pays the network fee.

A paid round works like this:

1. The server requests the round without payment. The gateway answers `402 Payment Required` with its payment requirements.
2. The server treats those requirements as untrusted and signs nothing unless every one matches what it derives itself:
   - `payTo` is the protocol treasury: the `ProtocolConfig` PDA derived from the program id, never the gateway. The round's gateway is the `GATEWAY_AUTHORITIES` entry for that endpoint, or the authority from `GET /v1/info`, which must own an Active on-chain `Gateway` account.
   - `asset` is the USDC mint in the on-chain `ProtocolConfig`.
   - `amount` is the protocol price, `x402_round_base + (signaturesRequired + redundancy_buffer) × reward_per_signature`, within `MOLPHA_X402_MAX_PRICE_USDC` and the rest of today's `MOLPHA_X402_MAX_SPEND_PER_DAY_USDC`.
   - `network` is the cluster `SOLANA_RPC` points at.
   - `extra.memo` is this request's commitment to the program, gateway, source, quorum, and registry version. It does not name a round: the gateway assigns the round's timestamp after it has verified the payment.
   - `extra.feePayer` is an account other than the signer.
3. The server signs a USDC `TransferChecked` from the signer's token account and repeats the request with the payment in the `PAYMENT-SIGNATURE` header. The gateway verifies the payment before it dispatches the round and settles it before it returns data. The tool result includes a `paymentReceipt` with the settlement transaction.

The daily cap counts every payment the server signs, whether or not its round completes, because a signed transfer can settle until its blockhash expires. When the gateway rejects a payment, the tool fails without paying again. When the gateway's answer leaves the outcome unknown (a 5xx, or a dropped connection after the payment was sent), the tool fails with `payment_outcome_unknown` and the payment's memo; look for that memo in the signer's USDC account before paying for the round again.

What a failed paid request means for its payment:

- **`409`** is raised before anything is reserved, so the payment is unspent. It means this payer already has a round for the feed in the current 100 ms tick (see [Round timing](#round-timing)), or that this payment already reserved a round. The server resends the same payment once, one full tick later, without quoting or signing again. A second 409 fails the tool with `round_conflict`.
- **Anything else** is never resent. Once the gateway has asked the nodes to work, the payment is spent even if the round fails: it is not settled, but the gateway will not accept it again. That includes a `503` because too few nodes accepted the round. A `503` from the gateway's own capacity limit (`gateway at capacity`) is answered before the request is read and spends nothing, but the server does not tell the two apart by status, so it resends neither and reports `payment_outcome_unknown` with the gateway's message in `details.gatewayMessage`. To run the round again, wait, then call the tool again: it signs a new payment.

Call `get_x402_status` before spending. It returns the quoted price for a quorum, where payment goes (the protocol treasury) and the gateway's pending tickets, the signer's USDC balance, and the remaining daily budget. With `dryRun: true`, `execute_x402_round` quotes and verifies the payment and reports the signer's balance without signing anything. Private API secrets (`encryptSecrets`) are only supported by `execute_subscription_round`.

The hosted server splits this into `prepare_x402_round` and `execute_x402_round`; see [hosted-http.md](hosted-http.md#x402-rounds-prepare-sign-execute).

## Integrated providers

A gateway can integrate data providers; [TickerLayer](https://tickerlayer.com) market data is the first. A provider is a descriptor on the gateway (not on-chain state): it lists the access flows the gateway can serve and **ready-made feeds**, each with a complete `apiConfig` and its `sourceId`. Three tools expose it:

| Tool | What it does |
| --- | --- |
| `list_providers` | The providers the gateway integrates and the flows it serves for each now. |
| `get_provider` | One provider's flows, required aggregation, disclosure and feeds. Narrow with `flow` and `feed`. |
| `quote_source_payment` | One unpaid request to a paywalled source: price per fetch, network, payee, the nodes that will fetch, and the **worst case**, plus whether this server would pay it. |

There are two ways to get a provider's data, and an agent chooses by what `get_provider` says each flow is:

- **`api_key` — you pay nothing and send nothing.** The gateway operator holds the provider key. Pass the feed's `apiConfig`, unchanged, to `execute_subscription_round` with `signaturesRequired` of at least 3 (provider feeds use median tolerance aggregation). Do not add headers or a key to it: any change moves the `sourceId` and, on the provider's host, is refused by the gateway.
- **`x402` — you pay the provider, per node fetch.** Every node that fetches is paid for, so a round costs price × the nodes that may fetch. Call `quote_source_payment`, then run the feed with `sourcePayment: { maxSpendUsdc }` on `execute_subscription_round`.

The credential or payment never enters the `apiConfig`, so the `sourceId` — the feed's identity — is the same whoever pays. Describe a provider's values as **attested provider quotes**: Molpha attests what the endpoint returned by threshold signature, not that the price is correct (`get_provider` returns the provider's own `disclosure`).

### Paying a source

Paying is **off by default**. It needs both a payer wallet and an explicit network allowlist on the server:

```dotenv
MOLPHA_SOURCE_PAYER_KEY=0x…                     # an EVM key; never printed or returned
MOLPHA_SOURCE_PAYMENT_NETWORKS=eip155:84532     # Base Sepolia; add eip155:8453 only deliberately
MOLPHA_SOURCE_MAX_PER_ROUND_USDC=0.25
MOLPHA_SOURCE_MAX_SPEND_PER_DAY_USDC=1
```

What stops an agent paying more than it meant to:

1. **Opt-in per call.** A paywalled source called without `sourcePayment` is never paid: the call fails with `source_payment_required` and the quote.
2. **The price is read first, from the source itself,** and the worst case is checked against what you authorized in `sourcePayment.maxSpendUsdc`, the per-round cap and the daily cap **before anything is signed**. A refusal (`source_payment_refused`) signs and pays nothing.
3. **The vetted terms are what gets signed,** so the price cannot move between the check and the payment.
4. **The network must be allowlisted.** A source asking to be paid elsewhere is refused.
5. **No automatic retry once signing starts.** A retry would sign a fresh set of authorizations, and the caps cover exactly one.
6. **The spend is counted when committed,** not when it settles: a signed authorization can settle whether or not the round completes. Concurrent calls cannot all pass a cap that only one fits under.
7. **The key stays in the server.** It is not in any output, error or log, and the hosted HTTP server never loads one (it holds no wallet).

The payer pays the source directly; Molpha never receives it. Only authorizations the nodes actually spend settle, so the exact charge is visible in the payer's balance. Source payment is for public sources: it cannot be combined with `encryptSecrets`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIGNER_BACKEND` | `memory` | `memory` or `keychain` |
| `KEYCHAIN_BACKEND` | — | `privy` or `turnkey` for a keychain signer |
| `OWNER_KEYPAIR` | — | Local Solana JSON keypair path |
| `SOLANA_RPC` | `https://api.devnet.solana.com` | Solana RPC endpoint |
| `GATEWAY_ENDPOINTS` | `https://dev-gateway.molpha.io` | Comma-separated **Molpha gateway** base URLs (not your Solana RPC). Must expose `/v1/nodes` and signing routes (`/v1/x402/execute` for x402, `/v1/round/execute` for subscription). Run `molpha-mcp doctor` to verify. |
| `GATEWAY_AUTHORITIES` | — | Comma-separated base58 gateway authorities, one per `GATEWAY_ENDPOINTS` entry in the same order. Bound into request signatures; required for gateways that do not serve `GET /v1/info`. |
| `MOLPHA_EVM_NETWORKS` | `evm-sepolia` | Comma-separated EVM verifier networks |
| `MOLPHA_STARKNET_NETWORKS` | `starknet-sepolia` | Comma-separated Starknet verifier networks |
| `MOLPHA_MAX_EXECUTES_PER_DAY` | `100` | Process-local daily Solana-submit cap |
| `MOLPHA_DRY_RUN` | `false` | Lock all writes to previews when set to `true` |
| `MOLPHA_X402_MAX_PRICE_USDC` | `1` | Refuse to pay for an x402 round priced above this (decimal USDC) |
| `MOLPHA_X402_MAX_SPEND_PER_DAY_USDC` | `10` | Process-local daily cap on USDC signed for x402 rounds (decimal USDC) |
| `MOLPHA_SOURCE_PAYER_KEY` | — | Hex private key of the **EVM** wallet that pays paywalled sources. Never printed or returned by a tool. Source payment stays off without it. See [Paying a source](#paying-a-source). |
| `MOLPHA_SOURCE_PAYMENT_NETWORKS` | — | Comma-separated CAIP-2 networks a source may be paid on, e.g. `eip155:84532` (Base Sepolia). Empty keeps source payment off, even with a key. |
| `MOLPHA_SOURCE_MAX_PER_ROUND_USDC` | `0.25` | Refuse a round whose worst case (price per fetch × the nodes that may fetch) exceeds this (decimal USDC) |
| `MOLPHA_SOURCE_MAX_SPEND_PER_DAY_USDC` | `1` | Process-local daily cap on USDC committed to paying sources (decimal USDC) |

The daily counters are process-local and reset when the server restarts. They are safety rails, not durable rate limits. The hosted server's own variables are in [hosted-http.md](hosted-http.md#configuration-and-operations).

## Signers

| Backend | Required configuration |
| --- | --- |
| Local keypair | `SIGNER_BACKEND=memory`, `OWNER_KEYPAIR` |
| Privy | `SIGNER_BACKEND=keychain`, `KEYCHAIN_BACKEND=privy`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WALLET_ID`, `PRIVY_WALLET_ADDRESS` |
| Turnkey | `SIGNER_BACKEND=keychain`, `KEYCHAIN_BACKEND=turnkey`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, `TURNKEY_ORGANIZATION_ID`, `TURNKEY_WALLET_ADDRESS` |
| None (read-only) | `SIGNER_BACKEND=none`, or no signer settings at all |

For local development, point `OWNER_KEYPAIR` at a Solana JSON keypair, as an absolute path when an MCP client launches the server, and use a dedicated testnet wallet. The same wallet owns feeds, pays for x402 rounds from its USDC account, authenticates gateway requests, and signs Solana transactions. Do not commit `.env`, wallet files, or credentials.

Gateway request signatures bind the gateway's on-chain PDA, so the server needs each gateway's authority. Set `GATEWAY_AUTHORITIES` to the base58 authority of each `GATEWAY_ENDPOINTS` entry, in the same order. An empty entry makes the SDK discover the authority from the gateway's `GET /v1/info`, which not every gateway serves. The authority must also own an Active on-chain `Gateway` account before this server pays for an x402 round.

The Privy and Turnkey SDKs are optional dependencies of `@molpha/mcp`, installed with it by default. If you installed with `--omit=optional`, add the provider you use next to the server:

```bash
npm install @privy-io/node          # KEYCHAIN_BACKEND=privy
npm install @turnkey/sdk-server @turnkey/solana   # KEYCHAIN_BACKEND=turnkey
```

See [.env.example](../.env.example) and the ready-to-edit files in [examples](../examples) for every backend.
