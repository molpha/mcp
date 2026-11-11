# Describing a data source: the source document

A **source** says what a feed reads, how the reads become one value, and how that value becomes the 32 bytes that are signed. Its `sourceId` is the keccak256 of its canonical bytes, so identity is a pure derivation: no registry, no creation step, no owner. Derive it with the `derive_source_id` tool, never by hand. The authority is the source format spec in the node client (`docs/source-format.md`); this page is the working summary.

Only nodes evaluate a source. This server, the gateway and the SDK parse, validate, canonicalize and hash it.

## Shape

```json
{
  "v": "1",
  "inputs":    { "<name>": { "kind": "http | evm | starknet | svm", "read": {}, "decode": {} } },
  "transform": { "op": "rescale", "args": [{ "ref": "<name>.<field>" }], "scale": "8", "round": "halfEven" },
  "assert":    [],
  "output":    { "type": "int256", "decimals": "8" },
  "aggregation": null
}
```

- **Every key of every object is present.** An absent optional is `null` (or `[]` / `{}` where the key holds a list or a map). A missing key, an unknown key or a wrong type is rejected with the **path** of the offending field (`invalid_source`, with `details.path`).
- **Every number is a string.** `"8"`, never `8`. JSON numbers are rejected everywhere in the document. This is the most common mistake.
- A string that is not exactly in its grammar is rejected, not normalized, because two spellings of one quantity would be two `sourceId`s: `"0.5"` not `".5"` or `"0.50"`; `"8"` not `"08"`; no `+`; no `-0`.
- 1 to 4 inputs (named `[A-Za-z_][A-Za-z0-9_]{0,31}`), one transform, up to 8 assertions, at most 16 fields per input, at most 64 expression nodes in total and 12 deep, and a canonical size of at most 8 KB.
- Key order and whitespace in what you send are free; they are re-sorted. The canonical bytes are what is hashed.

## Inputs: what is read

Each input is a fetch plus an explicit decoder that yields **named, typed fields** the transform refers to as `input.field`.

| `kind` | Extra keys | `read` |
|---|---|---|
| `http` | | `{method: GET\|POST, url, headers, body}`; `body` is `null` or `{contentType, text}` |
| `evm` | `chain`, `finality` | `{method: "call", to, sig, args, data}`, `{method: "storage", address, slot}`, `{method: "balance", address}` |
| `starknet` | `chain`, `finality` | `{method: "call", contract, selector, calldata}`, `{method: "storage", contract, key}` |
| `svm` | `chain`, `commitment`, `maxAgeMs` | `{method: "account", address, dataSlice}`, `{method: "tokenSupply", mint}` |

- **A chain input names the chain (CAIP-2: `eip155:1`, `starknet:SN_MAIN`, `solana:<32 chars>`), never an RPC endpoint.** Each node reads through its own endpoints. A gateway enables only some chains and checks the chain list's bounds, so a source can be well formed and still refused for an unsupported chain or an out-of-range `lagMs`; the error names the path.
- **http:** the URL is committed and sent verbatim (printable ASCII, no space, no fragment, no userinfo, lowercase host). Header names are lowercase; `host`, `content-length`, `content-type`, `connection`, `transfer-encoding`, `te`, `upgrade` and `expect` cannot be set (`body.contentType` sets the content type). Responses are read up to 1 MB. A node refuses to connect to non-public addresses.
- **evm / starknet** reads are **pinned to a block** derived from the round's timestamp (`finality: {mode, lagMs, n}`; `lagMs` is a multiple of 1000, `n` is a string for `confirmations` and `null` otherwise). Every node reads the same block, so exact mode works on chain state. Starknet offers `finalized` and `confirmations` only.
- **svm** reads at `commitment` and is refused if the slot is more than `maxAgeMs` older than the round. An account owned by the Molpha program is refused.

Decoders (`decode.format`), declared and never inferred:

| `format` | For | Fields |
|---|---|---|
| `json` | http | `{name: {path}}`, a path like `$.data[0].price` or `$.items[?(@.sym=='BTC')].px`. Numbers decode exactly (every digit of a big integer is kept) |
| `csv` / `xml` / `text` | http | `{name: {col,row}}` (RFC 4180), `{name: {path}}` ending in `/text()` or `/@attr`, `{name: {regex}}` with exactly one capture group |
| `abi` | evm | `{types: [...], fields: {name: {pick}}}`, strict decoding of return data |
| `felts` | starknet | `{name: {at, view}}` with view `felt`, `u256`, `bool`, `shortString`, `i128` |
| `layout` | svm | `{discriminator, fields: {name: {offset, type}}}` at fixed offsets |
| `raw` | any | one field, `raw`, as bytes |

A JSON string is **not** a number: `"65000.12"` becomes a decimal only through an explicit `{op:"num", args:[...], mode:"dec"}`. A JSON number needs no `num`.

## Transform: how the reads become one value

An expression is `{ref}`, `{const}`, `{str}`, `{bytes}`, `{bool}` or `{op, args, ...params}`. It is evaluated over **exact decimals** (an integer mantissa and a scale up to 36); overflow is an error, never a wrap. There is no implicit coercion.

| Group | Operators |
|---|---|
| Parse | `num` (`mode` dec/hex/sci), `int`, `str`, `hexBytes` |
| Arithmetic | `add sub mul min max neg abs` (`mul` adds scales and must stay within 36) |
| Division, scale | `div` and `rescale` (both need `scale` and `round`), `shift` (`n`, multiply by 10^n) |
| Compare, select | `eq ne lt lte gt gte`, `if(cond,a,b)`, `coalesce(a,b)` |
| Bytes, string | `keccak256`, `concat`, `slice(off,len)`, `lower`, `upper` |

`round` is `halfEven`, `down`, `up` or `halfUp`. `{const:"0.5"}` is a decimal literal. References are `input.field`, `$ts` (the round time in whole seconds), `$block` (only with exactly one chain input) and `$out` (assertions only). An **assertion** is an expression over fields and `$out` that must be true; if one is false the nodes refuse to sign.

Validation checks the document's structure, not its types or what the endpoint returns. A string used as a number without `num`, or a path the response does not have, fails **on the nodes** at run time, not in `derive_source_id`. Look at the real response before the first paid round.

## Output: the 32 signed bytes

`output.type` declares how the transform result becomes 32 bytes; it is part of the `sourceId`.

| `type` | `decimals` | Encoding |
|---|---|---|
| `int256`, `uint256` | `"0"` to `"36"` | rescaled half-even to `decimals`; two's complement for int256 |
| `bool` | `null` | `0x..00` or `0x..01` |
| `bytes32` | `null` | bytes, left-padded |
| `string32` | `null` | UTF-8, right-padded with zeros (at most 32 bytes) |
| `keccak256` | `null` | the keccak256 of the result, which must be bytes or a string |

For a `keccak256` output the signed value is only a hash. The round returns the **preimage** as `valuePreimage` (`0x` hex) beside the attestation, and the gateway keeps no copy: keep it. `submit_attestation` hands it to the Solana program as the raw value (up to 256 bytes), which checks it against the signed value and records the feed as `hash`.

## How `sourceId` is derived

```text
sourceId = keccak256(canonical bytes)          (no domain tag)
canonical = a subset of RFC 8785 (JCS): UTF-8, object keys sorted by byte order, no whitespace,
            arrays in order, strings escaped as JSON.stringify does, and no JSON numbers at all
```

- The same `sourceId` identifies the source on Solana, EVM and Starknet. The gateway and the SDKs derive it independently from the document and must agree; a node requires the canonical bytes. The verifiers and the programs do not recompute it: they check the signature over a payload that contains it.
- `signaturesRequired` is **not** part of it. The same source can be tracked at different quorums, and on Solana each `(sourceId, signaturesRequired, submitter)` is its own feed.
- Pass the identical source every time, `{{secret.*}}` placeholders included. `derive_source_id` returns `canonicalJson` (the exact preimage) and `canonicalSource`; show them when the user wants to audit the id.

## Determinism: exact mode and tolerance mode

`aggregation: null` is **exact mode**: every signer must produce the same 32 bytes, so the reads must not change between nodes.

- Prefer settled data: a closed candle, a daily rate, a historical record, a **pinned EVM or Starknet read** (every node reads the same block).
- A live http price (`/ticker`, `/price`, `/latest`, `/stream`, `/live`, `/ws`) draws a warning from `derive_source_id`, and so does an svm account read (nodes land on slots a few hundred ms apart; an AMM pool changes every slot). Treat the warning as real: the round will likely fail or never converge.
- Do not put a timestamp, nonce or cache-busting parameter in the URL or headers: it changes the `sourceId` and the response.

**Tolerance mode** lets live-drifting numbers be attested: set `aggregation` to `{"mode":"tolerance","rule":"median","maxDeviationBps":"50","maxAgeMs":"2000"}` (all strings).

- It is part of the `sourceId`. It needs `output.type` `int256` and `signaturesRequired` of at least 3; the tools refuse fewer before contacting a gateway or paying.
- Nodes exchange signed observations (up to about 5 seconds), drop values too old, too late or more than `maxDeviationBps` from the lower median, and the first `signaturesRequired` survivors sign. The median is taken over each node's **final output**, so a ratio of two drifting inputs gets one band on the ratio. The round fails if too few survive.
- The scale comes from `output.decimals`. There is nothing to set twice: no separate numeric block.

## Value encoding the consumer must agree on

- The scale and type are **declared by the source** (`output`) and so committed by the `sourceId`, in both modes. A consumer that pins the `sourceId` knows the type and the scale.
- The feed account stores no decimals field, only whether the 32 bytes are the value itself or the hash of a preimage. To read a stored value, give `describe_feed` or `get_latest_value` the `source` (not just the `sourceId`) and read `valueEncoding`.

## Worked examples

Each `sourceId` below was derived by the SDK, and those marked "reference" are known answers from the Go reference implementation.

### 1. A JSON price feed (exact, settled endpoint)

The response is `{"rate": 1.2345}`; the value is scaled to 8 decimals as an int256.

```json
{
  "v": "1",
  "inputs": {
    "px": {
      "kind": "http",
      "read": { "method": "GET", "url": "https://api.example.com/v1/finalized/rate", "headers": {}, "body": null },
      "decode": { "format": "json", "fields": { "rate": { "path": "$.rate" } } }
    }
  },
  "transform": { "op": "rescale", "args": [{ "ref": "px.rate" }], "scale": "8", "round": "halfEven" },
  "assert": [],
  "output": { "type": "int256", "decimals": "8" },
  "aggregation": null
}
```

`sourceId` `0x321343bab9a7780a0f597b5547948da6ac41113b3864fe754a3c505373870bea`. If the API spells the price as a JSON string (`{"rate": "1.2345"}`), wrap the ref: `{"op": "num", "args": [{ "ref": "px.rate" }], "mode": "dec"}`.

### 2. A tolerance feed (live price, median)

A live price, a header, a string price and a positivity assertion. Needs `signaturesRequired` of at least 3.

```json
{
  "v": "1",
  "inputs": {
    "px": {
      "kind": "http",
      "read": { "method": "GET", "url": "https://api.example.com/v1/price?symbol=BTC", "headers": { "accept": "application/json" }, "body": null },
      "decode": { "format": "json", "fields": { "price": { "path": "$.data.price" } } }
    }
  },
  "transform": {
    "op": "rescale",
    "args": [{ "op": "num", "args": [{ "ref": "px.price" }], "mode": "dec" }],
    "scale": "8",
    "round": "halfEven"
  },
  "assert": [{ "op": "gt", "args": [{ "ref": "$out" }, { "const": "0" }] }],
  "output": { "type": "int256", "decimals": "8" },
  "aggregation": { "mode": "tolerance", "rule": "median", "maxDeviationBps": "50", "maxAgeMs": "2000" }
}
```

`sourceId` `0x82f6b8c6d3b01506ef0450dc4503d51a424f5811bc2259aff1486936426876de` (reference). The signed value is the median of the nodes' outputs times 10^8; read `100.015` as `10001500000`.

### 3. An EVM pinned read (exact, on-chain state)

wstETH's `stEthPerToken()` on Ethereum mainnet, read at the newest finalized block that is at least 20 minutes older than the round (Ethereum's finalized head is 13 to 19 minutes old, so a shorter lag can find no block old enough). Every node derives the same block from the round's timestamp, so exact mode converges.

```json
{
  "v": "1",
  "inputs": {
    "rate": {
      "kind": "evm",
      "chain": "eip155:1",
      "finality": { "mode": "finalized", "lagMs": "1200000", "n": null },
      "read": { "method": "call", "to": "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", "sig": "stEthPerToken()", "args": [], "data": null },
      "decode": { "format": "abi", "types": ["uint256"], "fields": { "rate": { "pick": "0" } } }
    }
  },
  "transform": { "ref": "rate.rate" },
  "assert": [],
  "output": { "type": "int256", "decimals": "0" },
  "aggregation": null
}
```

`sourceId` `0xd1dca8d1976c47d89aba10c9d5ccdfdac5deec00626e9e6cb64471656c062468` (reference). `decimals` is `"0"`: the integer is the contract's own 1e18-scaled rate, unchanged. A gateway accepts a chain input only for a chain it enables, with `lagMs` inside that chain's bounds.

### 4. A keccak256 output (a signed hash of a string)

The value that is signed is the hash of a token the endpoint returns; the token itself comes back as `valuePreimage`.

```json
{
  "v": "1",
  "inputs": {
    "t": {
      "kind": "http",
      "read": { "method": "GET", "url": "https://x.example.com/t", "headers": {}, "body": null },
      "decode": { "format": "text", "fields": { "sig": { "regex": "sig=([0-9a-f]+)" } } }
    }
  },
  "transform": { "op": "hexBytes", "args": [{ "ref": "t.sig" }] },
  "assert": [],
  "output": { "type": "keccak256", "decimals": null },
  "aggregation": null
}
```

`sourceId` `0xe120c6c6fff730a2b45872032d9ba7c5d497cb628f6ac5e12c1ac75cf9cbe2c6` (reference). `output.decimals` is `null`, because only int256 and uint256 have a scale.

## Writing sources in code

The SDK builds the same documents with defaults filled in: `jsonPriceSource({url, path, decimals, valueIs, headers, tolerance})` for the common case, `defineSource({inputs, transform, output, ...})` with the `sx` builders for the rest, and `parseSource` to validate one. They return the same canonical document and `sourceId` as `derive_source_id`.

## Private API secrets

An API that needs a key can use `{{secret.NAME}}` placeholders, only in an http input's **URL after the host**, a **header value** or `body.text`; scheme, host and port are literal. The secrets are encrypted to the nodes by `execute_subscription_round`'s `encryptSecrets` argument. This works only on a **local** server with a signer, never on the hosted server and never together with `sourcePayment`. Keep the placeholders in the `source` so the `sourceId` does not depend on the secret.

Never ask the user to paste a secret into chat. Tell them which environment variable or file the value belongs in.

## Paid sources and provider feeds

- A payment names no host. A source that is paid for (`sourcePayment`, an x402-paywalled API) or that takes a provider credential needs **exactly one http input**; chain inputs beside it are fine. `quote_source_payment` refuses any other source before making a request.
- A provider feed from `get_provider` carries a complete, canonical `source`. Use it **unchanged**: a changed byte is a different `sourceId`, and on a provider's host it is refused.

## When a round fails

A node's failure message starts with its stage:

| Prefix | Meaning |
|---|---|
| `parsing source` | The source is invalid or not canonical |
| `fetching data` | An input failed to fetch or decode (`api response status <code>` for http) |
| `evaluating source` | The transform failed (a type error, a missing key, a division by zero) |
| `source assertion` | An assertion was false |
| `encoding output` | The result does not fit the declared output |

An input's name follows as `(input px)`.

## Checklist before paying for a round

1. `derive_source_id` accepted the source and returned no determinism warning, or you chose tolerance mode on purpose.
2. The endpoint is stable, public and settled, or a pinned chain read, or a provider feed from `get_provider` used **unchanged**.
3. You looked at the endpoint's real response and the path, `num` and scale match it.
4. `signaturesRequired` is at least 3 for tolerance, and at least what the consumer's policy demands.
5. The consumer knows the value's scale and type: they are the `output`.
6. A dry run (`dryRun: true`) was shown to the user.
