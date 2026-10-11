---
"@molpha/mcp": minor
---

Hosted HTTP mode is now keyless. **Breaking for hosted clients:** the per-request `X-Molpha-*` Privy/Turnkey signer headers are removed (requests carrying them are refused with 400), and the hosted server no longer signs anything. Anything that needs a signature is returned for the caller's own wallet to sign:

- x402: `prepare_x402_round` returns an unsigned USDC transfer and a server-authenticated `challenge`; `execute_x402_round` now takes `{ challenge, signedTransaction }` and accepts only the prepared transaction carrying the payer's valid signature. Requires `MOLPHA_HTTP_CHALLENGE_SECRET` (rotate with `MOLPHA_HTTP_CHALLENGE_SECRET_PREVIOUS`).
- Subscription rounds: `begin_session` / `complete_session` sign in to the gateway with one Sign-In-With-Solana text message (x402 `sign-in-with-x`), and `execute_subscription_round` takes the resulting `sessionToken`. Needs a gateway with sign-in sessions enabled.
- Solana submit: `prepare_submit_attestation` and `send_signed_transaction` replace `submit_attestation` over HTTP.
- `autoSubmit`, `dryRun` and `encryptSecrets` are not offered over HTTP; `MOLPHA_HTTP_ALLOW_ENCRYPT_SECRETS=true` now fails startup.

Both modes gain `describe_access` (is a wallet a subscription owner or delegate, and under what limits) and an optional `payer` on `get_x402_status`.

The x402 client follows the gateway's current protocol: the payment memo commits to the deployment, gateway, source, quorum and registry version rather than to a round; requests carry no timestamp (the gateway assigns it, in unix milliseconds); and a 409 resends the same payment once instead of paying again. The payer's signature on a payment is now verified, not merely checked for presence.

Stdio mode keeps its local keypair, Privy and Turnkey signers and its one-call tools.
