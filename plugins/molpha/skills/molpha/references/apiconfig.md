# Describing a data source: `apiConfig`

A source is identified by its `apiConfig` alone. Derive its `sourceId` with the `derive_source_id` tool, never by hand.

## The fields

| Field | Required | Notes |
|---|---|---|
| `url` | yes | Where each node fetches. Every node fetches it independently |
| `method` | no, default `GET` | `GET`, `POST` or `PUT` are accepted by the SDK type. Prefer `GET` for public APIs |
| `headers` | no, default `{}` | Part of the identity. Header names are sorted when hashed |
| `responseParser` | yes | A dotted path into the JSON response, for example `$.price` or `$.data[0].price` |
| `valueTransform` | no, default empty | Only `multiply:<factor>` is supported by the node source, for example `multiply:1e6` |
| `aggregation` | no | Median tolerance mode. See below. Omit for exact mode |

`responseParser` takes a `$`-rooted path with `.` for fields and `[n]` for array indexes. The full grammar is not documented anywhere; the node's extractor is the authority. Keep paths simple, and check the result with a dry run rather than assuming a clever path works.

`valueTransform` multiplies the extracted number by the factor and **truncates to an integer** (`100.125` with `multiply:1` becomes `100`). A factor must be positive. Some test fixtures in this repository use a different transform syntax (`mul(...)`); the node does not accept it.

## How `sourceId` is derived

```text
sourceId      = keccak256(canonicalJson)
canonicalJson = compact JSON of { url, method, headers, responseParser, valueTransform[, aggregation] },
                keys in exactly that order, defaults filled (method "GET", headers {}, valueTransform ""),
                header names sorted by UTF-16 code units
```

- It is **not** RFC 8785 (JCS), which sorts the top-level keys and hashes to a different id.
- The same `sourceId` identifies the source on Solana, EVM and Starknet. The gateway, the programs and the contracts all recompute it from the same canonical config.
- `signaturesRequired` is **not** part of it. The same source can be tracked at different quorums, and on Solana each `(sourceId, signaturesRequired, submitter)` is its own feed.
- Pass the identical `apiConfig` every time, placeholders included. `derive_source_id` returns `canonicalJson`; show it when the user wants to audit the id.

## Determinism: every node must agree

In the default **exact mode**, each selected node fetches the URL on its own and signs only if its value matches the canonical result byte for byte. So the response must not change between nodes' fetches.

- Prefer **settled or finalized** sources: a closed candle, a finalized block, a daily rate, a historical record.
- A URL that looks live (`/ticker`, `/price`, `/latest`, `/stream`, `/live`, `/ws`) draws a warning from `derive_source_id`. Treat the warning as real: the round will likely fail or never converge.
- Do not put a timestamp, nonce or cache-busting parameter in the URL or headers. It changes the `sourceId` and the response.
- Fix the response shape. A parser that selects a field that sometimes moves or is absent fails the round.

## Tolerance mode, for live-drifting numbers

Set `aggregation` so nodes sign the **median** of their fresh observations instead of requiring identical values:

```json
"aggregation": {
  "mode": "tolerance",
  "rule": "median",
  "maxDeviationBps": 50,
  "maxAgeMs": 2000,
  "numeric": { "type": "int256", "decimals": 8 }
}
```

- `aggregation` is part of the `sourceId`. A source's tolerance settings cannot change without changing its identity.
- Only `rule: "median"` and `numeric.type: "int256"` are supported. `"mode": "exact"` is rejected; omit `aggregation` for exact mode.
- The round needs `signaturesRequired` of at least 3. The tools refuse fewer before contacting a gateway or paying.
- Nodes exchange signed observations (up to about 5 seconds), drop values too old, too late, or more than `maxDeviationBps` from the lower median, and the first `signaturesRequired` survivors sign. The round fails if too few survive.
- **Leave `valueTransform` empty.** The node scales by `10^decimals` itself, so a leftover `multiply:` transform scales twice (and truncates first).
- The signed value is a **signed int256**: the decimal result times `10^decimals`, rounded half to even, as a two's-complement 32-byte big-endian integer. Decode it with the same `decimals`.

## Value encoding the consumer must agree on

- **Tolerance mode:** the scale is committed by the `sourceId` (it is inside `aggregation`), so a consumer that pins `sourceId` knows the scale and the type.
- **Exact mode:** Molpha does not attest scale or decimals. The feed only records whether the 32 bytes are the value itself or the hash of a longer preimage. The consumer must be configured with the scale out of band. Do not infer it from the integer.

## Private API secrets

An API that needs a key can use `{{secret.NAME}}` placeholders in `url` or `headers`, with the secrets encrypted to the nodes by `execute_subscription_round`'s `encryptSecrets` argument. This works only on a **local** server with a signer, never on the hosted server and never together with `sourcePayment`. Keep the placeholders in the `apiConfig` so the `sourceId` does not depend on the secret.

Never ask the user to paste a secret into chat. Tell them which environment variable or file the value belongs in.

## Checklist before paying for a round

1. `derive_source_id` returned no determinism warning, or you chose tolerance mode on purpose.
2. The URL is a stable, public, settled endpoint, or a provider feed from `get_provider` used **unchanged**.
3. `signaturesRequired` is at least 3, and at least what the consumer's policy demands.
4. The consumer knows the value's scale and type.
5. A dry run (`dryRun: true`) was shown to the user.
