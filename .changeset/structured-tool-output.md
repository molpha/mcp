---
"@molpha/mcp": minor
---

Every tool declares an `outputSchema`, returns `structuredContent`, and carries MCP tool annotations.

- Results arrive as `structuredContent` validated against the tool's `outputSchema`, with the same JSON kept in a text block for clients without structured-content support. A result that does not match its schema is still returned in full, flagged `isError` with an `output_schema_mismatch` note, rather than replaced by a bare error — a paid round's signed artifact is never lost to a schema mismatch.
- The signed artifact (`value`, `fresh`, `dataUpdate`, `signature`) has one canonical schema, exported from `src/artifacts.ts`. The round tools advertise it, and `submit_attestation` and `build_verifier_calldata` take it as input.
- Annotations: `readOnlyHint` on `get_capabilities`, `derive_source_id`, `describe_feed`, `get_latest_value`, `get_x402_status`, and `build_verifier_calldata`. The round tools are `destructiveHint: true, idempotentHint: false` (each call spends quota or USDC); `submit_attestation` is `destructiveHint: false, idempotentHint: true` (the program only accepts an attestation newer than the feed's). `openWorldHint` is `false` for the two local tools, `derive_source_id` and `build_verifier_calldata`.
- `build_verifier_calldata` needs no signer: it reads config only, so it works without a wallet configured.

**Breaking**

- `build_verifier_calldata` validates `dataUpdate` and `signature` against the artifact schema instead of accepting any object, and `submit_attestation`'s artifact form requires `dataUpdate.value`. Round-tool output passes unchanged.
- The `execute_x402_round` dry-run preview returns `sourceId` `0x`-prefixed, like every other tool, and reports `action: "execute_x402_round"`.
