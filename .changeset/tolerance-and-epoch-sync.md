---
"@molpha/mcp": minor
---

Median tolerance mode, and the epoch-settlement Solana program.

- `apiConfig.aggregation` (`mode: "tolerance"`, `rule: "median"`, `maxDeviationBps`, `maxAgeMs`, `numeric: { type: "int256", decimals }`) is accepted by every tool that takes an `apiConfig`. It is part of the `sourceId` (`derive_source_id` returns it in `canonicalApiConfig` and `canonicalJson`), needs `signaturesRequired >= 3` (checked before any gateway call or payment), and makes the signed value a signed int256 scaled by `10^decimals`. Live-drifting URLs no longer draw a determinism warning in tolerance mode.
- x402 payments now go to the protocol treasury, the USDC account of the `ProtocolConfig` PDA, instead of the gateway authority; the 402's `payTo` must equal it. The gateway authority must still own an Active `Gateway` account.
- `get_x402_status` follows the gateway's new `GET /v1/x402/status` (`payTo`, `treasuryAta`, `pendingTickets`): the `gatewayFloat` object is replaced by `gateway`.
- `describe_feed` no longer reports `subscription.usedRounds`: the program does not count rounds any more, so a subscription is `active` while it has not expired and the gateway enforces the quota.

**Breaking**

- `get_x402_status` output: `gatewayFloat` is removed in favor of `gateway` (`gateway`, `authority`, `payTo`, `treasuryAta`, `pendingTickets`).
- `describe_feed` output: `subscription.usedRounds` is removed.
- Requires an `@molpha/sdk` release that vendors the epoch-settlement IDL and exports the tolerance-mode config.
