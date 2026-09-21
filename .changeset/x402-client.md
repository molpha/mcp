---
"@molpha/mcp": minor
---

Port `execute_x402_round` and `get_x402_status` to the gateway's x402 protocol, served at `POST /v1/x402/execute` and `GET /v1/x402/status` (the gateway's former `/v1/agent/*` routes, named for the retired escrow flow).

**Breaking**

- `execute_x402_round` pays each round with an x402 `exact` Solana payment in the `PAYMENT-SIGNATURE` header: a USDC transfer from the signer to the gateway authority, with the network fee paid by the gateway's facilitator. This replaces the retired escrow flow (escrow funding plus a signed `AgentRequestAuth`). Before signing, the server checks the gateway's 402 requirements against its own reads: `payTo` against the configured or registered gateway authority, `asset` against the `ProtocolConfig` USDC mint, `amount` against the protocol price and the caps, `network` against the `SOLANA_RPC` cluster, and `extra.memo` against the round commitment. Live results include a `paymentReceipt`.
- `get_x402_status` reads the gateway's USDC float from `GET /v1/x402/status` instead of a per-payer escrow, and adds the signer's USDC balance and the remaining daily budget. `signaturesRequired` is now optional and defaults to the protocol minimum.
- `MOLPHA_X402_GATEWAY_PDA` is removed.
- `MOLPHA_X402_MAX_SPEND_PER_DAY_USDC` counts every payment the server signs, whether or not its round completes.
