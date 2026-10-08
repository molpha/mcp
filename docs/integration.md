# Connect Molpha to your agent

> [!NOTE]
> This page describes the install flow for the next release. Steps marked **(planned)** become available with that release or after it; see [integration-plan.md](integration-plan.md). Molpha currently targets **Solana Devnet** and **Sepolia** verifier networks. Treat it as testnet software.

Molpha has two parts for agents:

- **The MCP server** gives your agent Molpha tools: derive a `sourceId`, run a signing round, submit to Solana, build EVM/Starknet verifier calldata.
- **The Molpha skill** teaches your agent how to use them safely, and how to write Solana, EVM and Starknet code that consumes Molpha data. It helps even if you never install the server.

## Choose where to start

| You want to… | Start at | You need |
|---|---|---|
| Look around: capabilities, providers, `sourceId`s, prices, feed values | [Explore](#1-explore-without-a-wallet) | Nothing |
| Build an integration and preview every write | [Build](#2-build-with-a-testnet-wallet) | A testnet wallet |
| Run real rounds and publish on Solana | [Spend](#3-turn-on-spending) | Devnet SOL and USDC |
| Have your agent do the setup | [Prompt](#set-it-up-with-a-prompt) | An agent that can run commands |

All paths need **Node.js 24 or later**.

Your agent can always ask the server where it stands: `get_capabilities` returns a `runLevel` and the reason for it.

| `runLevel` | What the server does | How you get there |
|---|---|---|
| `read-only` | Offers only the read tools. No signer is loaded. | No signer configured, `SIGNER_BACKEND=none`, or `--read-only` |
| `dry-run` | Offers every tool, but writes are previews. A call cannot turn that off. | `MOLPHA_DRY_RUN=true` |
| `live` | Writes sign and spend. | A signer, and `MOLPHA_DRY_RUN` unset or `false` |

## 0. Install the skill

**Claude Code:** the plugin installs the skill and the MCP server together. It asks for your signer settings and keeps dry-run on.

```text
/plugin marketplace add molpha/mcp
/plugin install molpha@molpha
```

**Other agents:** copy the [`plugins/molpha/skills/molpha`](../plugins/molpha/skills/molpha) folder into your agent's skills directory. Agents that support skills read the same `SKILL.md` format; see your agent's docs for the folder location.

## 1. Explore without a wallet

The read tools work without a signer: `get_capabilities`, `derive_source_id`, `list_providers`, `get_provider`, `quote_source_payment`, `get_x402_status`, `describe_feed`, `get_latest_value`, `describe_access`, `build_verifier_calldata`.

**Local, read-only.** Nothing to configure. The server is also read-only whenever no signer is set.

<!-- molpha:generated:explore-local -->
```sh
claude mcp add molpha -- npx -y @molpha/mcp@0.2.0 --read-only
```
<!-- /molpha:generated:explore-local -->

One-click install of the same read-only server:

<!-- molpha:generated:explore-links -->
[Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=molpha&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtb2xwaGEvbWNwQDAuMi4wIiwiLS1yZWFkLW9ubHkiXX0%3D) · [Install in VS Code](vscode:mcp/install?%7B%22name%22%3A%22molpha%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40molpha%2Fmcp%400.2.0%22%2C%22--read-only%22%5D%7D)
<!-- /molpha:generated:explore-links -->

**Hosted (planned).** Nothing to install, and no keys involved. `https://mcp.molpha.io/mcp` is not deployed yet.

```sh
claude mcp add --transport http molpha https://mcp.molpha.io/mcp
```

```json
{ "mcpServers": { "molpha": { "url": "https://mcp.molpha.io/mcp" } } }
```

Try: *"Use Molpha to list the integrated providers and describe TickerLayer's btcusd feed. Don't make any writes."*

## 2. Build with a testnet wallet

### Pick a signer

| Signer | Use it for | Settings |
|---|---|---|
| **Privy** (recommended for agents) | Agents, shared or long-running setups. The key stays with Privy and policies apply. | `SIGNER_BACKEND=keychain`, `KEYCHAIN_BACKEND=privy`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WALLET_ID`, `PRIVY_WALLET_ADDRESS` |
| **Turnkey** | Same, on Turnkey | `SIGNER_BACKEND=keychain`, `KEYCHAIN_BACKEND=turnkey`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, `TURNKEY_ORGANIZATION_ID`, `TURNKEY_WALLET_ADDRESS` |
| **Local keypair file** | Local development only | `SIGNER_BACKEND=memory`, `OWNER_KEYPAIR=/absolute/path/to/keypair.json` |

Use a **dedicated testnet wallet** for the agent, not one you use elsewhere. Point `OWNER_KEYPAIR` at a file; don't paste the key array into a client config.

### Check the setup

Put your settings in a `.env` file, plus `MOLPHA_DRY_RUN=true`, then run the doctor from the same folder:

<!-- molpha:generated:doctor -->
```sh
npx -y @molpha/mcp@0.2.0 doctor
```
<!-- /molpha:generated:doctor -->

It checks the signer, the wallet, the Solana RPC and the gateway, then prints a config for each client. Secrets are never printed: they stay as `<placeholders>` for you to fill in your client config. If your settings came from an env file, the printed config points at that file and copies nothing from it.

### Connect your client

Every example sets `MOLPHA_DRY_RUN=true`: writes and payments are previewed, not sent. Fill in your signer settings from the table above.

**Claude Code**

<!-- molpha:generated:connect-claude-code -->
```sh
claude mcp add molpha -e SIGNER_BACKEND=keychain -e KEYCHAIN_BACKEND=privy -e PRIVY_APP_ID='<privy-app-id>' -e PRIVY_APP_SECRET='<privy-app-secret>' -e PRIVY_WALLET_ID='<privy-wallet-id>' -e PRIVY_WALLET_ADDRESS='<base58-solana-address>' -e MOLPHA_DRY_RUN=true -- npx -y @molpha/mcp@0.2.0
```
<!-- /molpha:generated:connect-claude-code -->

**Cursor**: `.cursor/mcp.json` or `~/.cursor/mcp.json`

<!-- molpha:generated:connect-cursor -->
```json
{
  "mcpServers": {
    "molpha": {
      "command": "npx",
      "args": [
        "-y",
        "@molpha/mcp@0.2.0"
      ],
      "env": {
        "SIGNER_BACKEND": "keychain",
        "KEYCHAIN_BACKEND": "privy",
        "PRIVY_APP_ID": "<privy-app-id>",
        "PRIVY_APP_SECRET": "<privy-app-secret>",
        "PRIVY_WALLET_ID": "<privy-wallet-id>",
        "PRIVY_WALLET_ADDRESS": "<base58-solana-address>",
        "MOLPHA_DRY_RUN": "true"
      }
    }
  }
}
```
<!-- /molpha:generated:connect-cursor -->

**VS Code**: `.vscode/mcp.json`

<!-- molpha:generated:connect-vscode -->
```json
{
  "servers": {
    "molpha": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@molpha/mcp@0.2.0"
      ],
      "env": {
        "SIGNER_BACKEND": "keychain",
        "KEYCHAIN_BACKEND": "privy",
        "PRIVY_APP_ID": "<privy-app-id>",
        "PRIVY_APP_SECRET": "<privy-app-secret>",
        "PRIVY_WALLET_ID": "<privy-wallet-id>",
        "PRIVY_WALLET_ADDRESS": "<base58-solana-address>",
        "MOLPHA_DRY_RUN": "true"
      }
    }
  }
}
```
<!-- /molpha:generated:connect-vscode -->

**Codex**: `~/.codex/config.toml`

<!-- molpha:generated:connect-codex -->
```toml
[mcp_servers.molpha]
command = "npx"
args = ["-y", "@molpha/mcp@0.2.0"]

[mcp_servers.molpha.env]
SIGNER_BACKEND = "memory"
OWNER_KEYPAIR = "<path-to-devnet-keypair.json>"
MOLPHA_DRY_RUN = "true"
```
<!-- /molpha:generated:connect-codex -->

**Claude Desktop (planned)**: download `molpha-mcp.mcpb` from the [latest release](https://github.com/molpha/mcp/releases/latest) once the first release that attaches it is published, double-click it, and fill in the signer fields. Leave them empty for read-only. Dry run is on by default.

Try: *"Derive a Molpha sourceId for `<your API URL>` at `$.price`, then preview a subscription round with 3 signatures for EVM. Show me what would be sent."*

## 3. Turn on spending

1. Fund the wallet with Devnet SOL, plus Devnet USDC for rounds.
2. Pick how rounds are paid. **x402 pay-per-request** needs no setup: each round is paid from the wallet's USDC. A **subscription** is bootstrapped once with the commands below.
3. Set your caps (below), then go live **in the server's config**: set `MOLPHA_DRY_RUN=false` (or remove it) and restart the server.

To bootstrap a subscription, preview it first, then run it again without `--dry-run`. `--max-price-usdc` is a cap in USDC base units (6 decimals).

<!-- molpha:generated:provision -->
```sh
npx -y @molpha/mcp@0.2.0 provision subscribe --plan Basic --max-price-usdc 20000000 --dry-run
```
<!-- /molpha:generated:provision -->

While `MOLPHA_DRY_RUN=true`, a write call that passes `dryRun: false` is refused with `dry_run_locked`. That is deliberate: the agent cannot switch spending on from inside a conversation, only you can, by editing the config. Your agent will tell you if it hits the lock.

| Setting | Default | What it limits |
|---|---|---|
| `MOLPHA_MAX_EXECUTES_PER_DAY` | 100 | Solana submits per day |
| `MOLPHA_X402_MAX_PRICE_USDC` | 1 | Price of one x402 round |
| `MOLPHA_X402_MAX_SPEND_PER_DAY_USDC` | 10 | x402 spend per day |
| `MOLPHA_SOURCE_MAX_PER_ROUND_USDC` | 0.25 | Worst-case paid-source cost per round |
| `MOLPHA_SOURCE_MAX_SPEND_PER_DAY_USDC` | 1 | Paid-source spend per day |

Daily caps are per server process and reset when it restarts. For a hard limit, also set a policy on the wallet itself (Privy and Turnkey both support this).

Round tools spend on **every** call. If one fails with an unclear error, check `describe_feed` or `get_x402_status` before trying again.

## Set it up with a prompt

Paste this into an agent that can run shell commands (Claude Code, Cursor, Codex…). It sets up the build level in dry-run mode and stops before any spending.

<!-- molpha:generated:prompt -->
```text
Set up the Molpha MCP server and skill in this agent, on Solana Devnet, in dry-run mode. Follow these steps exactly and stop if one fails.

1. Run `node --version`. If it is below 24, stop and tell me.
2. Install the Molpha skill. If you are Claude Code, run `/plugin marketplace add molpha/mcp` and `/plugin install molpha@molpha`, then skip step 4. Otherwise copy the `plugins/molpha/skills/molpha` folder from https://github.com/molpha/mcp into this agent's skills directory.
3. Ask me which signer I use: Privy, Turnkey, or a local keypair file. Ask for non-secret values (IDs, wallet address, keypair file path). For secrets (PRIVY_APP_SECRET, TURNKEY_API_PRIVATE_KEY), write a placeholder and tell me which file and line to edit. Do not ask me to paste secrets into this chat. Never create, print, copy or move a private key.
4. Add an MCP server named "molpha" to this agent's config that runs `npx -y @molpha/mcp@0.2.0`, with my signer settings and MOLPHA_DRY_RUN=true in its env.
5. Once I confirm the placeholders are filled in, run `npx -y @molpha/mcp@0.2.0 doctor` with the same settings and show me the output.
6. Reload the MCP server, call get_capabilities, and summarize the run level, network, chains and verifier addresses.

Make no writes and spend nothing.
```
<!-- /molpha:generated:prompt -->

## Safety notes

- Treat the **signed attestation** as the trust anchor, not the bare value.
- `build_verifier_calldata` doesn't verify anything. Your agent or contract calls `verify()` on EVM or Starknet.
- Solana feeds are keyed by `(sourceId, signaturesRequired, submitter)`. Each submitting wallet maintains its own feed.
- Keep secrets out of chat and out of version control. Prefer Privy or Turnkey for anything that runs unattended.
- The testnet verifier addresses may change between releases, and the EVM address the SDK reports can be a fallback for an older interface. The skill says how to check; do not treat a `get_capabilities` address as audited.

See also: [README](../README.md) for the full tool reference, and [hosted-http.md](hosted-http.md) for the keyless hosted mode.
