# Agent integration plan

Status: in-repo work implemented on branch `integration-flow`, 2026-10-08. Internal. Covers how developers and their agents get from "heard of Molpha" to "signed data in my agent or contract". The user-facing result is [integration.md](integration.md).

## Implementation status

Done in this repository: everything marked `[x]` below. **Not done, because it is outside this repo or is a release action:** a stable `@molpha/sdk` and the re-pin, merging to `main` and releasing `0.2.0`, publishing to npm and the MCP registry, deploying the hosted server, the docs.molpha.io page, the llms.txt check, and the molpha.io button.

**Not run locally:** the packed-tarball smoke test (`scripts/smoke-pack.mjs`) needs to install `@molpha/sdk@0.2.0-dev-20261008064918`, published the day it was written, which a 3-day npm `min-release-age` setting refuses until about 2026-10-11. Its `--dist` mode passes locally; the full run is a CI job. The Docker and container checks were not run (Docker was not running). The skill evals (W3) are deferred.

Deviations from the plan as first drafted, with reasons:

- **One bin through `src/cli.ts`, not subcommands in `src/server.ts`.** `server.ts` is the Vercel entry and must not gain a top-level await.
- **Privy and Turnkey are `optionalDependencies`**, not `dependencies`: npx installs them and the hosted image can still prune them. The smoke test asserts they install.
- **The skill and plugin live in `plugins/molpha/`**, not `skills/molpha/`. A plugin whose `source` is the repo root copies the whole repository into every user's plugin cache.
- **The plugin declares its server inline, with `userConfig`**, instead of a `.mcp.json` with `MOLPHA_DRY_RUN=true` hard-coded: that plus the dry-run lock would make level 2 unreachable from the plugin.
- **`MOLPHA_DRY_RUN=true` is a lock** and fails safe on unrecognised values (decided with the owner). Unset still means live.
- **The Desktop bundle is packed from an allowlist** (`scripts/pack-mcpb.mjs`), because `mcpb pack .` ignores `.gitignore` and the previous local bundle contained `privy-test.json` and local settings.

## Goal

One integration flow that:

- lets an agent explore Molpha with **no wallet and no spend**;
- moves to a funded wallet only as a deliberate second step, with dry-run and caps on;
- ships **two things together**: the MCP server (what the agent can do) and a skill (how to do it correctly, plus how to write Solana/EVM/Starknet code against Molpha);
- installs through each client's native path, with a copy-paste prompt as the catch-all.

## What's true today (checked 2026-10-08)

| # | Finding | Impact |
|---|---|---|
| 1 | npm `latest` is `0.1.2` (from `main`; `0.1.1` was never published). It ships the **old tool surface**: 8 tools named `molpha_*` (`molpha_fetch_verified`, `molpha_execute`, …). The 13-tool surface in the README (`get_capabilities`, `execute_x402_round`, …) exists only on `provider-tools`, where `package.json` still says `0.1.1`. | Any public install doc right now points people at tools the README doesn't describe. Nothing should be promoted until the current surface is released. |
| 2 | `npx @molpha/mcp` fails: `could not determine executable to run`. The package has three bins (`molpha-mcp`, `molpha-provision`, `molpha-doctor`) and none matches the unscoped package name. `npx -y -p @molpha/mcp molpha-mcp` works. | Breaks the one-liner, the sentence in `docs/hosted-http.md` ("Use `npx @molpha/mcp` locally"), and likely installs from the MCP registry, since registry clients run the package identifier. |
| 3 | `initialize` returns no `instructions`. | Clients that never load a skill get no guidance on spend safety or verification. |
| 4 | `server.json` has no `remotes` entry. `https://mcp.molpha.io/healthz` did not answer, which matches `docs/hosted-http.md` (not deployed). | There is no wallet-free entry point today. |
| 5 | ~~The local server refuses to start without a signer.~~ **Corrected:** it starts and lists all 13 tools, and 11 of them fail on first call with `missing_config` (`src/config.ts:117`, raised lazily; a rejected context stayed cached for the process). | Locally, a bare install advertised tools that could only fail. Fixed by read-only mode. |
| 6 | `@molpha/mcp` on the branch pins `@molpha/sdk@0.2.0-dev-20261008064918`; the SDK's npm `latest` is `0.1.0`. | A stable MCP release needs a stable SDK release first. |
| 7 | `molpha-doctor` prints client snippets as `node /abs/path/dist/src/server.js`. | Wrong for anyone who installed with npx: that path is npm's cache. |
| 8 | README quick start is clone → `npm ci` → build. `MOLPHA_DRY_RUN` defaults to `false`. | Higher friction than needed, and a new install can spend on its first write. |
| 9 | No skill and no Claude Code plugin manifest. A 50 MB `molpha-mcp.mcpb` sits untracked in the repo root. | The `.mcpb` belongs in GitHub Releases, built by CI. |

## Target flow

Three levels. Each one is a separate, explicit step; the skill applies to all three.

| Level | What the agent can do | What the user needs | Entry |
|---|---|---|---|
| **0. Explore** | Capabilities, `derive_source_id`, providers, quotes, read feeds, build calldata | Nothing | Hosted URL, or local `--read-only` |
| **1. Build** | Everything, previewed (dry-run) | A testnet wallet (Privy/Turnkey preferred, keypair file for local dev) | Local npx, `MOLPHA_DRY_RUN=true` |
| **2. Spend** | Real rounds, real submits | Devnet SOL + USDC, a subscription or x402, caps set | Same install, dry-run off |

Hosted mode has its own level-2 path: the caller's wallet signs prepared transactions (`docs/hosted-http.md`). It is not covered again here.

## Workstreams

### W0 — Release hygiene (blocks everything else)

- [ ] Publish a stable `@molpha/sdk` and pin it.
- [ ] Merge `provider-tools` to `main`. Release as **`0.2.0`**, with a changeset that lists the renamed tools as breaking.
- [x] Fix npx. **Recommended:** one bin, `molpha-mcp`, with subcommands: `molpha-mcp` (server, default), `molpha-mcp doctor`, `molpha-mcp provision …`, `molpha-mcp --http`. With a single bin, `npx -y @molpha/mcp@0.2.0` resolves on its own. Keep `molpha-doctor` and `molpha-provision` out of `bin` (npm only falls back to the package name when there is exactly one bin, or one named `mcp`). The alternative, adding a bin named `mcp`, puts a generic `mcp` command on PATH for global installs, so I'd avoid it.
- [x] Make Privy and Turnkey work under npx. On the branch they are optional `peerDependencies`, which `npx` doesn't install, so `KEYCHAIN_BACKEND=privy` via npx should fail when the signer loads (inferred from the manifest, not yet tested). Options: move them back to `dependencies` (what `0.1.2` does; bigger install), or lazy-install them in `doctor`. Recommended: `dependencies`, because Privy/Turnkey is the signer we tell agents to use.
- [x] CI smoke test on the packed tarball: `npm pack`, then `npx -y ./molpha-mcp-*.tgz` with an `initialize` + `tools/list` over stdin. Assert the tool names match the README table. That catches findings 1 and 2 before they ship.
- [x] Add `*.mcpb` to `.gitignore`. Build the bundle in the release workflow and attach it to the GitHub release.

**Done when:** `npx -y @molpha/mcp@0.2.0` starts and lists the 13 documented tools on a clean machine.

### W1 — Server-side guidance

- [x] Set `instructions` on the MCP server. Keep it short, because it loads on every session in every client. Draft:

  > Molpha returns API data signed by a threshold of oracle nodes. Treat the signed attestation, not the bare value, as the trust anchor. `execute_subscription_round` and `execute_x402_round` spend on every call: never retry one after an unclear error; read state first (`describe_feed`, `get_x402_status`). Quote before paying (`get_x402_status`, `quote_source_payment`). `build_verifier_calldata` verifies nothing: the caller runs `verify()` on EVM or Starknet. Solana feeds are keyed by `(sourceId, signaturesRequired, submitter)`. Preview the first write of a session with `dryRun: true` and show the user what will be sent. This release targets Solana Devnet and Sepolia.

- [x] Report the current level (`read-only`, `dry-run`, `live`) in `get_capabilities`, so the agent and the skill can say what it's allowed to do.

### W2 — A wallet-free entry point

Do both. The first is cheap and doesn't wait on ops.

- [x] **Local `--read-only`** (or `SIGNER_BACKEND=none`): start without a signer, register only the read tools, and point a write attempt at the setup docs. Fixes finding 5.
- [ ] **Hosted:** deploy `https://mcp.molpha.io/mcp` (needs `MOLPHA_HTTP_CHALLENGE_SECRET` shared across instances; see `docs/vercel.md`). Then add the `remotes` entry to `server.json` and publish to the registry. Fixes finding 4.

### W3 — The skill

Location: `skills/molpha/` in this repo for now. Move it out when the integration guides start following the SDK or programs more than this server (see the repo decision in the open questions).

```
skills/molpha/
  SKILL.md                  # when to use; invariants; decision tree; ≤ ~150 lines
  references/
    mcp-workflows.md        # tool sequences for each level; spend safety; error recovery
    apiconfig.md            # writing a source; determinism; tolerance; sourceId
    integrate-solana.md     # reading a feed account from a program / client
    integrate-evm.md        # verify() call shape; trust model
    integrate-starknet.md
```

- [x] `SKILL.md` describes behavior and refers to tools by name only. No argument schemas: the server owns those.
- [x] CI check: every tool name the skill mentions exists in `src/tools`. Fails the build on drift.
- [x] The integration references come from the SDK and programs docs, not from memory. They are the most valuable part, because code-writing agents need them with or without the MCP installed.
- [ ] Evaluate on real tasks before publishing: (a) "derive a sourceId for X", (b) "get a signed BTC price for EVM", (c) "write a Solana program that reads a Molpha feed", (d) "the round errored, what now". Compare with and without the skill.

### W4 — Packaging per client

- [x] **Claude Code plugin:** a `.claude-plugin/marketplace.json` at the repo root and a plugin that bundles `.mcp.json` (npx, dry-run on) plus `skills/molpha`. One install gets both.
- [x] **Claude Desktop:** the `.mcpb` from the GitHub release. Its manifest `user_config` should default `MOLPHA_DRY_RUN` to true.
- [x] **Cursor / VS Code:** "Add to Cursor" and "Install in VS Code" deeplinks, generated from one source config by a script so they can't drift. Secrets stay placeholders.
- [x] **Codex and others:** documented one-liners.
- [ ] **MCP registry:** publish `0.2.0` via the existing `mcp-publisher` step, after W0.
- [x] Rework `molpha-mcp doctor`: detect an npx install and print npx-based snippets for Claude Code, Cursor and Codex (finding 7).

### W5 — Docs

- [x] [integration.md](integration.md) is the single source; docs.molpha.io gets the same page.
- [x] README quick start becomes "npx + doctor + connect", linking to `integration.md`. Move clone-and-build to Development.
- [x] Fix the `npx @molpha/mcp` sentence in `docs/hosted-http.md` once W0 lands.
- [ ] Check docs.molpha.io serves `llms.txt`.

### W6 — Copy-paste prompt button

Last, because it points at everything above. Text lives in [integration.md](integration.md#set-it-up-with-a-prompt). Rules:

- Commands pinned to one version and run as written. Never "read our docs and configure yourself".
- Ends at level 1 (dry-run). Spending is a separate decision the user makes.
- Never asks the user to paste a secret into chat, and never has the agent create, print or move a private key.
- Ends with a check: doctor, then `get_capabilities`.
- Generated from the same version variable as the docs, so it can't point at an old release.

## Sequencing

1. **W0**: SDK release, merge, `0.2.0`, npx fix, smoke test.
2. In parallel: **W1**, **W2** read-only mode, **W3** skill draft and evals. Hosted deploy whenever ops is ready.
3. **W4** packaging, **W5** docs, published with the `0.2.0` release.
4. **W6** button on molpha.io and docs.

## Open questions

- **Default `MOLPHA_DRY_RUN` to `true`?** Recommended for every packaged config (plugin, `.mcpb`, deeplinks, prompt). Flipping the code default is a breaking change for existing users. Decide with `0.2.0`.
- **Skill repo:** keep in `mcp` now. Split to `molpha/skills` when either the integration guides follow the SDK/programs more than this server, or a second skill appears.
- **Which skill installer to document** for non-Claude agents. This area moves fast; check what's current when publishing.
- **Mainnet:** none of this changes, but caps, dry-run defaults and the prompt wording need a second review before any mainnet release.
