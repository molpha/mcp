---
"@molpha/mcp": minor
---

One install path for agents: explore with no wallet, build with dry-run on, spend as a deliberate step. Ships with a Claude Code plugin that bundles the server and a Molpha skill.

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
