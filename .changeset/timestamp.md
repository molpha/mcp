---
"@molpha/mcp": minor
---

`timestamp` is unix **milliseconds**, assigned by the gateway on a tick grid; callers never choose it.

- Subscription rounds keep `RequestAuth`: the SDK `MolphaGateway` is built with the wallet signer, which
  signs each request, so only the subscription owner (or its delegate) can spend the subscription's
  rounds. The request carries `authSig` and `authTimestamp` (unix seconds, an auth freshness stamp)
  and no round timestamp.
- x402 rounds send no `timestamp`. The payment memo is
  `keccak256("MOLPHA_X402_REQUEST_V1" || programId || gatewayPda || sourceId || quorum:u8 ||
  registryVersion:u32be)`: it commits to the source and quorum, not to a round, and the server verifies
  it against the gateway's quote before signing. A 409 (this payer already has a round for this source
  and quorum in the current tick) waits for the next tick and pays again.
- Tool outputs describe `timestamp` in milliseconds. `maxAge` and verifier freshness stay in
  seconds.
