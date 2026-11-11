---
"@molpha/mcp": minor
---

Move to Molpha's source format. `apiConfig` (one HTTP GET, a JSONPath and a `multiply:` transform) is gone from every tool; a feed is now a **source**: a JSON document with 1 to 4 inputs (`http`, `evm`, `starknet`, `svm`), explicit decoders, a JSON-AST transform over exact decimals, assertions, a declared output type and an optional median-tolerance `aggregation`. `sourceId` is the keccak256 of the source's canonical bytes (a JCS subset: sorted keys, no whitespace, every number a string).

**Breaking**

- Every tool input and output named `apiConfig` is now `source`: `derive_source_id`, `execute_subscription_round`, `execute_x402_round`, `quote_source_payment`, `describe_feed`, and the hosted `execute_subscription_round` and `prepare_x402_round`. The schema is a plain object; the SDK's `parseSource` validates it, and a rejected source fails with the new `invalid_source` error whose `details.path` names the offending field. Every key of a source must be present and every number must be a string (`"8"`, never `8`).
- `derive_source_id` returns `canonicalSource` (was `canonicalApiConfig`), `canonicalJson` (the exact preimage), the declared `output` (`type`, `decimals`) and `determinismWarnings`. Every `sourceId` changed: none derived from an `apiConfig` is valid, and the x402 payment memo of any given source changed with it.
- `aggregation.numeric` is gone. The scale is `output.decimals` of the source, in exact mode as well as tolerance mode. Tolerance mode needs `output.type` `int256` and `signaturesRequired >= 3`.
- Round responses no longer carry `configHash` or `aggregation`. `value` is rendered from the source's declared output (a scaled decimal, `true`/`false`, text or hex) rather than taken from the gateway.
- `get_provider` feeds carry `source` instead of `apiConfig`; pass it to `execute_subscription_round` unchanged.
- `quote_source_payment` returns `sourceId` and `url` (the probed http input's URL) instead of `source` (a URL). A paid (x402) source, a source payment or a provider credential needs a source with exactly one http input; any other source is refused before a request is made.
- `describe_feed`'s `valueEncoding` now always reports the declared output as attested (`encoding`, `decimals`, `decodedValue`); the `valueTransform` field is gone. Without a `source` there is no `valueEncoding`.
- The live-drifting URL heuristic of `derive_source_id` checks every http input, in exact mode only. An svm account read in exact mode also draws a warning (the SDK's lint); pinned EVM and Starknet reads draw none.
- `@molpha/sdk` is pinned to `0.3.0-dev-20261106163242` (registry-held signer keys: `submit_attestation` names no node accounts), a release with the source format (`parseSource`, `jsonPriceSource`, `formatValue`, `verifyPreimage`, `lintSource`, `asParsedSource`, `assertToleranceQuorum`); the 0.2.0 pin does not export them. It is a dev-tag build: a stable MCP release needs a stable SDK release first. The SDK's peer `@anchor-lang/core` is `^1.2.1`, so the server's own range moved with it.
- Hosted mode: `MOLPHA_HTTP_TEST_API_CONFIG` (the opt-in devnet test) is now `MOLPHA_HTTP_TEST_SOURCE`.

**Added**

- `get_latest_value` takes an optional `source` (alongside `sourceId`) and then reports `valueEncoding`, so a stored value can be read by its attested scale. `describe_feed` and `get_latest_value` accept either `sourceId` or `source`.
- A `keccak256` output's signed value is a hash: rounds return its preimage as `valuePreimage`, and `submit_attestation` / `autoSubmit` hand it to the Solana program as the raw value. Keep it: the gateway keeps no copy.
- A source the nodes ran and could not evaluate (a 401 from the upstream, a missing field, a false assertion) now returns `source_failed` with the node's stage and reason. It was reported as `round_timeout` with advice about the gateway's capacity limit.
- Every request carries the optional `sourceId` guard, so the gateway refuses a request whose canonical form differs from the one this server derived (`400`, canonicalization mismatch) before any payment is bound to it.
- The skill's `references/apiconfig.md` is now `references/source.md`: the format, the determinism rules, and worked examples (a JSON price feed, a tolerance feed, an EVM pinned read, a keccak256 output).
