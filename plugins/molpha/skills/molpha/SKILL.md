---
name: molpha
description: Use when a task involves Molpha, the threshold-signed oracle: getting signed API data, deriving a sourceId, running or paying for a signing round, reading a Molpha feed on Solana, verifying an attestation in an EVM or Starknet contract, or using the Molpha MCP server tools (get_capabilities, derive_source_id, execute_subscription_round, execute_x402_round, build_verifier_calldata). Covers spending safely and writing code that consumes Molpha data. Testnet only.
---

# Molpha

Molpha turns an HTTP API response into a value signed by a threshold of oracle nodes. The same signed **attestation** can be verified on Solana, EVM and Starknet. You reach it through the Molpha MCP server (tools), or by writing code against the SDK and the verifier contracts. This skill is the behavior to apply either way.

Testnet only: Solana Devnet, Sepolia, Starknet Sepolia. Say so when a user talks about production.

## The attestation is the trust anchor

A round returns a `value` and a signed attestation. Pass the attestation on, not the bare value. A valid signature proves a quorum of registered nodes signed that exact payload. It does **not** prove the value is fresh, that it came from the source you meant, that the quorum is large enough for you, or that it has not been used before. Those are the consumer's checks (see `references/integrate-solana.md` and `references/integrate-evm.md`).

`build_verifier_calldata` verifies nothing. Never tell a user something is "verified" until `verify()` was actually called on a verifier and returned `success` with code 0.

## First move, every session

1. If the Molpha MCP tools are present, call `get_capabilities`. Its `runLevel` says what you may do, and `runLevelReason` says why:
   - `read-only`: no signer. Only read tools exist. Do not ask for keys; point the user to the setup docs in the server instructions if they want writes.
   - `dry-run`: writes are previews and a call cannot change that.
   - `live`: writes sign and spend. Treat every write as irreversible.
2. Tell the user the level in one line before doing anything that matters.
3. If the tools are absent, you can still help: write code and explain. Do not claim you ran anything.

## Rules that do not bend

1. **Secrets.** Never ask for a private key, API secret or seed in chat. Never create, print, copy or move a key. Use placeholders and tell the user which file to edit.
2. **Spending.** `execute_subscription_round` and `execute_x402_round` spend on every call. After an unclear error, never retry: read state first (`describe_feed`, `get_x402_status`). A second call pays for a second round.
3. **Quote, preview, then spend.** Quote before paying (`get_x402_status`, `quote_source_payment`). Preview the first write of a session with `dryRun: true` and show the user what would be sent. Only go live after they say so.
4. **The dry-run lock.** If a write is refused with `dry_run_locked`, stop and tell the user. Only they can unlock it, by changing the server's config and restarting it. Do not look for a way around it, and do not ask them to paste anything.
5. **`sourceId` comes from `derive_source_id`.** Never hash an `apiConfig` yourself: one differing byte points at a different feed. `sourceId` identifies the source, not the quorum.
6. **Times.** The attestation `timestamp` is unix **milliseconds**. `maxAge`, registry activation and every chain clock are **seconds**: compare `timestamp / 1000`.
7. **Solana feeds are per submitter.** The feed is keyed by `(sourceId, signaturesRequired, submitter)`. Another wallet's submit is a different feed. A lower quorum is a different feed.
8. **Do not trust addresses blindly.** Verifier addresses from `get_capabilities` or the SDK can be a fallback for an older interface. See "What to verify" below.

## Where to go next

| The task | Read |
|---|---|
| Use the MCP tools: explore, get a signed value, pay, settle, recover from an error | `references/mcp-workflows.md` |
| Describe a data source: `apiConfig`, `responseParser`, transforms, tolerance, determinism | `references/apiconfig.md` |
| Write a Solana program or client that reads a Molpha feed | `references/integrate-solana.md` |
| Write an EVM contract or client that verifies an attestation | `references/integrate-evm.md` |
| Write a Starknet contract or client that verifies an attestation | `references/integrate-starknet.md` |

Load only the file the task needs. Ask the user which chain if it is not clear; do not assume EVM.

## What to verify before relying on this

This skill was written from the source checkouts, not from a deployment. Before telling a user an address or interface is live:

- **EVM.** The consumer library and the `verify(Attestation, uint64)` interface exist in source, but no deployment of that interface is recorded: the library's address constant is the zero address and its deployment file is marked provisional. The address the SDK or `get_capabilities` returns may belong to an older interface (`verify(DataUpdate, ...)`). Check the contract on a block explorer, or call `verify` and see whether the selector exists, before building on it.
- **Starknet.** The recorded deployment predates the latest interface change. Whether the deployed class matches is not known from the source.
- **Solana.** The devnet program is upgradeable and changes often. Confirm the program id with `get_capabilities` and read the account owner before trusting a feed.

When a fact is unknown, say it is unknown.

## Style

Be brief. Name the run level, the tool you are about to call and why, and what it will cost, before a write. After a write, report the result and where the signed artifact is. Do not paste long JSON the user did not ask for.
