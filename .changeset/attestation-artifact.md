---
"@molpha/mcp": minor
---

The round tools return the signed result as an `attestation`, the name and shape the gateway, the SDK and the verifiers use. The `dataUpdate` name is gone from the tool surface.

**Breaking**

- `execute_subscription_round` and `execute_x402_round` return `attestation: { payload, signature }` in place of the top-level `dataUpdate` and `signature`. This is the gateway's round body: `payload` is `{ value, sourceId, registryVersion, signaturesRequired, timestamp }` and `signature` is `{ signature, commitment, signersBitmap }`.
- `attestation.payload.value` is the 32-byte packed value the signature covers (was `dataUpdate.valuePacked`). The decimal rendering is the top-level `value` only (was also `dataUpdate.value`).
- `build_verifier_calldata` takes `attestation` in place of `dataUpdate` and `signature`.
- `submit_attestation` and `prepare_submit_attestation` accept `{ attestation: { payload, signature } }` (a round's output, unmodified) or the flat shape. The `{ dataUpdate, signature }` shape is refused.
