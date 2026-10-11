# @molpha/mcp

## 0.2.0

### Minor Changes

- [#25](https://github.com/molpha/mcp/pull/25) [`778f50f`](https://github.com/molpha/mcp/commit/778f50fd375201f5adf7af1cec545bb1b29adcf8) Thanks [@vito-kovalione](https://github.com/vito-kovalione)! - One install path for agents: explore with no wallet, build with dry-run on, spend as a deliberate step. Ships with a Claude Code plugin that bundles the server and a Molpha skill.

  **Breaking**

  - The package has a single bin, `molpha-mcp`, so `npx -y @molpha/mcp` resolves. `molpha-doctor` and `molpha-provision` are gone: use `molpha-mcp doctor` and `molpha-mcp provision <subscribe|extend>`. An unknown command exits with an error instead of starting a server that waits on stdin.
  - `MOLPHA_DRY_RUN=true` is now a lock. A write call (`execute_subscription_round`, `execute_x402_round`, `submit_attestation`) that passes `dryRun: false` is refused with `dry_run_locked`; going live means changing the server's config. Unset still means live. The value fails safe: only `0`, `false`, `no` or `off` turn the lock off, and any other non-empty value (a typo, `True`, `yes`) locks to dry-run instead of silently going live.
  - A local server with no signer configured now starts **read-only**: it offers only the ten read tools instead of thirteen tools that fail on first use. Pass `--read-only`, or set `SIGNER_BACKEND=none`, to force it when a signer is configured. An explicit signer backend with missing credentials is still an error, never a downgrade. An unknown `SIGNER_BACKEND` is now rejected instead of falling back to the local keypair.
  - The Privy and Turnkey SDKs are `optionalDependencies`, not optional peers, so `npx` installs them.

  **Added**

  - `get_capabilities` reports `runLevel` (`read-only`, `dry-run` or `live`) and `runLevelReason`. `payment.signing` can be `none`, and `payment.subscription` / `payment.x402` are absent on a read-only server.
  - The server sends MCP `instructions` on `initialize` (local, read-only and hosted variants): spend safety, verification, and the run level.
  - Provider discovery and source payment: `list_providers`, `get_provider`, `quote_source_payment`, and `sourcePayment` on `execute_subscription_round`.
  - `molpha-mcp doctor` prints `npx` configs for Claude Code, Cursor, VS Code and Codex, never prints a secret, always sets `MOLPHA_DRY_RUN`, and points at your env file instead of copying its values.
  - A Claude Code plugin (`/plugin marketplace add molpha/mcp`, `/plugin install molpha@molpha`) and a Molpha skill with references for the MCP tools, `apiConfig`, and Solana, EVM and Starknet consumers.
  - Install snippets in the README, the integration guide and `examples/` are generated from one source and checked in CI. The Claude Desktop bundle (`manifest.json`) and `server.json` default to dry-run, with the signer optional.
  - CI smoke-tests the packed tarball with `npx`, and releases build the Desktop bundle from an allowlist and attach it to the GitHub release.

  **Fixed**

  - `dist/` is cleaned before each build, so stale compiled files no longer ship in the package.

- [#27](https://github.com/molpha/mcp/pull/27) [`3716fd9`](https://github.com/molpha/mcp/commit/3716fd9f2ed2d56725089208c1cd7914596a20c3) Thanks [@vito-kovalione](https://github.com/vito-kovalione)! - The round tools return the signed result as an `attestation`, the name and shape the gateway, the SDK and the verifiers use. The `dataUpdate` name is gone from the tool surface.

  **Breaking**

  - `execute_subscription_round` and `execute_x402_round` return `attestation: { payload, signature }` in place of the top-level `dataUpdate` and `signature`. This is the gateway's round body: `payload` is `{ value, sourceId, registryVersion, signaturesRequired, timestamp }` and `signature` is `{ signature, commitment, signersBitmap }`.
  - `attestation.payload.value` is the 32-byte packed value the signature covers (was `dataUpdate.valuePacked`). The decimal rendering is the top-level `value` only (was also `dataUpdate.value`).
  - `build_verifier_calldata` takes `attestation` in place of `dataUpdate` and `signature`.
  - `submit_attestation` and `prepare_submit_attestation` accept `{ attestation: { payload, signature } }` (a round's output, unmodified) or the flat shape. The `{ dataUpdate, signature }` shape is refused.

- [#20](https://github.com/molpha/mcp/pull/20) [`cf01049`](https://github.com/molpha/mcp/commit/cf010492b73fb86cde9218671fb71a6d3fb42a55) Thanks [@vito-kovalione](https://github.com/vito-kovalione)! - Add stateless Streamable HTTP mode with `molpha-mcp --http`, per-request Privy/Turnkey signing headers, and unsigned discovery, reads, and x402 quotes. Hosted defaults reject plaintext encryption inputs, retain per-round price limits, disable shared daily budgets, enforce IP rate limits, and sanitize errors and logs. Include a container and deployment runbook; stdio remains the default.

- [#23](https://github.com/molpha/mcp/pull/23) [`18fa5e4`](https://github.com/molpha/mcp/commit/18fa5e49448d4e91ff704db3dc70ae303219954f) Thanks [@vito-kovalione](https://github.com/vito-kovalione)! - Hosted HTTP mode is now keyless. **Breaking for hosted clients:** the per-request `X-Molpha-*` Privy/Turnkey signer headers are removed (requests carrying them are refused with 400), and the hosted server no longer signs anything. Anything that needs a signature is returned for the caller's own wallet to sign:

  - x402: `prepare_x402_round` returns an unsigned USDC transfer and a server-authenticated `challenge`; `execute_x402_round` now takes `{ challenge, signedTransaction }` and accepts only the prepared transaction carrying the payer's valid signature. Requires `MOLPHA_HTTP_CHALLENGE_SECRET` (rotate with `MOLPHA_HTTP_CHALLENGE_SECRET_PREVIOUS`).
  - Subscription rounds: `begin_session` / `complete_session` sign in to the gateway with one Sign-In-With-Solana text message (x402 `sign-in-with-x`), and `execute_subscription_round` takes the resulting `sessionToken`. Needs a gateway with sign-in sessions enabled.
  - Solana submit: `prepare_submit_attestation` and `send_signed_transaction` replace `submit_attestation` over HTTP.
  - `autoSubmit`, `dryRun` and `encryptSecrets` are not offered over HTTP; `MOLPHA_HTTP_ALLOW_ENCRYPT_SECRETS=true` now fails startup.

  Both modes gain `describe_access` (is a wallet a subscription owner or delegate, and under what limits) and an optional `payer` on `get_x402_status`.

  The x402 client follows the gateway's current protocol: the payment memo commits to the deployment, gateway, source, quorum and registry version rather than to a round; requests carry no timestamp (the gateway assigns it, in unix milliseconds); and a 409 resends the same payment once instead of paying again. The payer's signature on a payment is now verified, not merely checked for presence.

  Stdio mode keeps its local keypair, Privy and Turnkey signers and its one-call tools.

- [#26](https://github.com/molpha/mcp/pull/26) [`7cf0dd3`](https://github.com/molpha/mcp/commit/7cf0dd32c19f81bdce5fbbe7a5ae43ce2859f61e) Thanks [@vito-kovalione](https://github.com/vito-kovalione)! - Follow the protocol's fixed 100 ms round tick (`ROUND_TICK_MS = 100`, a protocol constant the server hardcodes).

  The gateway stamps each round with its own clock rounded down to the tick. Requests for one feed (the same source, quorum and registry version) inside one tick share a round, a feed runs at most 10 rounds per second, and one wallet gets at most one round per tick for a feed.

  - HTTP 409 means the consumer or payer already has a round for the feed in the current tick (or an x402 payment already reserved a round). `execute_x402_round` and the hosted `execute_subscription_round` repeat the request once, after one full tick plus a small jitter (100 to 120 ms); an x402 round resends the same payment, which a 409 leaves unspent. The stdio `execute_subscription_round` retries inside `@molpha/sdk`, on that package's own schedule.
  - A request still refused with 409 fails with the error code `round_conflict`.
  - HTTP 503 keeps the code `round_timeout`, and its remediation names the usual cause: the gateway's own capacity limit (`gateway at capacity`), which refuses a request before reading it, so nothing is reserved or spent. Otherwise too few nodes accepted or finished the round; a node refuses a gateway only as a safety limit. A paid x402 request is never resent after a 503: once the gateway has asked the nodes to work, its payment is spent even if the round fails, so a retry signs a new payment.

- [#20](https://github.com/molpha/mcp/pull/20) [`cf01049`](https://github.com/molpha/mcp/commit/cf010492b73fb86cde9218671fb71a6d3fb42a55) Thanks [@vito-kovalione](https://github.com/vito-kovalione)! - Move to the current `@molpha/sdk` protocol (`sourceId` replaces `feedId`) and name every tool verb-first, without the `molpha_` prefix.

  **Breaking**

  - Tools renamed: `molpha_get_capabilities` → `get_capabilities`, `molpha_derive_feed` → `derive_source_id`, `molpha_describe_feed` → `describe_feed`, `molpha_get_latest` → `get_latest_value`, `molpha_agent_status` → `get_x402_status`, `molpha_verify` → `build_verifier_calldata`, `molpha_execute` → `submit_attestation`. `build_verifier_calldata` is named for what it does: it builds calldata and verifies nothing, so no tool name promises a verification the server does not perform.
  - `molpha_fetch_verified` is split by payment path into `execute_subscription_round` and `execute_x402_round`; the `payment` argument and its `"auto"` fallback are gone.
  - `feedId` is replaced by `sourceId` in every input and output. `sourceId` depends on `apiConfig` alone, so `derive_source_id` no longer takes `signaturesRequired` and needs no wallet.
  - `describe_feed` and `get_latest_value` take `sourceId` + `signaturesRequired` and an optional `submitter`, because Solana feeds are keyed per submitter.

  **Added**

  - `GATEWAY_AUTHORITIES`: the base58 authority of each gateway endpoint, bound into request signatures. Required for gateways that do not serve `GET /v1/info`.

- [#22](https://github.com/molpha/mcp/pull/22) [`f1fda9a`](https://github.com/molpha/mcp/commit/f1fda9aecfb243c5382876db662d71d3e31ad9f7) Thanks [@vito-kovalione](https://github.com/vito-kovalione)! - Median tolerance mode, and the epoch-settlement Solana program.

  - `apiConfig.aggregation` (`mode: "tolerance"`, `rule: "median"`, `maxDeviationBps`, `maxAgeMs`, `numeric: { type: "int256", decimals }`) is accepted by every tool that takes an `apiConfig`. It is part of the `sourceId` (`derive_source_id` returns it in `canonicalApiConfig` and `canonicalJson`), needs `signaturesRequired >= 3` (checked before any gateway call or payment), and makes the signed value a signed int256 scaled by `10^decimals`. Live-drifting URLs no longer draw a determinism warning in tolerance mode.
  - x402 payments now go to the protocol treasury, the USDC account of the `ProtocolConfig` PDA, instead of the gateway authority; the 402's `payTo` must equal it. The gateway authority must still own an Active `Gateway` account.
  - `get_x402_status` follows the gateway's new `GET /v1/x402/status` (`payTo`, `treasuryAta`, `pendingTickets`): the `gatewayFloat` object is replaced by `gateway`.
  - `describe_feed` no longer reports `subscription.usedRounds`: the program does not count rounds any more, so a subscription is `active` while it has not expired and the gateway enforces the quota.

  - The server follows the SDK's `Attestation` and the gateway's nested `attestation` response; `submit_attestation` and the verifier-arg builders now receive the SDK's `Attestation`.
  - `build_verifier_calldata` and the round tools take `maxAge` for **EVM as well as Starknet** (the SDK builders require it). Omitted or `0` means no freshness check, and the tool says so.

  **Breaking**

  - `get_x402_status` output: `gatewayFloat` is removed in favor of `gateway` (`gateway`, `authority`, `payTo`, `treasuryAta`, `pendingTickets`).
  - `describe_feed` output: `subscription.usedRounds` is removed.
  - Requires an `@molpha/sdk` release that vendors the epoch-settlement IDL and exports the tolerance-mode config.
  - `verifierArgs.evm.args` is now `{ attestation: { payload, signature }, maxAge }` (was a `dataUpdate` / `signature` tuple pair), matching the `verify(Attestation, uint64)` ABI.

- [#20](https://github.com/molpha/mcp/pull/20) [`cf01049`](https://github.com/molpha/mcp/commit/cf010492b73fb86cde9218671fb71a6d3fb42a55) Thanks [@vito-kovalione](https://github.com/vito-kovalione)! - Port `execute_x402_round` and `get_x402_status` to the gateway's x402 protocol, served at `POST /v1/x402/execute` and `GET /v1/x402/status` (the gateway's former `/v1/agent/*` routes, named for the retired escrow flow).

  **Breaking**

  - `execute_x402_round` pays each round with an x402 `exact` Solana payment in the `PAYMENT-SIGNATURE` header: a USDC transfer from the signer to the gateway authority, with the network fee paid by the gateway's facilitator. This replaces the retired escrow flow (escrow funding plus a signed `AgentRequestAuth`). Before signing, the server checks the gateway's 402 requirements against its own reads: `payTo` against the configured or registered gateway authority, `asset` against the `ProtocolConfig` USDC mint, `amount` against the protocol price and the caps, `network` against the `SOLANA_RPC` cluster, and `extra.memo` against the round commitment. Live results include a `paymentReceipt`.
  - `get_x402_status` reads the gateway's USDC float from `GET /v1/x402/status` instead of a per-payer escrow, and adds the signer's USDC balance and the remaining daily budget. `signaturesRequired` is now optional and defaults to the protocol minimum.
  - `MOLPHA_X402_GATEWAY_PDA` is removed.
  - `MOLPHA_X402_MAX_SPEND_PER_DAY_USDC` counts every payment the server signs, whether or not its round completes.

### Patch Changes

- [#20](https://github.com/molpha/mcp/pull/20) [`cf01049`](https://github.com/molpha/mcp/commit/cf010492b73fb86cde9218671fb71a6d3fb42a55) Thanks [@vito-kovalione](https://github.com/vito-kovalione)! - Start hosted HTTP automatically on Vercel, honor `PORT`, allow Vercel deployment hostnames, and document the public Vercel runbook.
