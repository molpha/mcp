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
| Run subscription rounds with a wallet the server never holds | [Sign in](#4-sign-in-with-your-own-wallet-siwx) | A wallet that can sign a text message, and access to a subscription |
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

## 4. Sign in with your own wallet (SIWX)

The local server in sections 2 and 3 holds a signer, so it authenticates subscription rounds itself and there is nothing to sign in to. The **hosted HTTP server holds no key**. There, your own wallet signs one text message, the gateway answers with a short-lived session token, and that token runs subscription rounds.

This is Sign-In-With-X (SIWX): the x402 `sign-in-with-x` extension, in its Solana form (Sign-In-With-Solana). The signature is over plain text. It is not a transaction and moves no funds.

x402 pay-per-request rounds need no sign-in: the payment is the authorization. See [hosted-http.md](hosted-http.md#x402-rounds-prepare-sign-execute).

### Before you start

- **A hosted server.** `https://mcp.molpha.io/mcp` is not deployed yet **(planned)**. Until it is, run the same keyless server on your machine and connect your client to `http://127.0.0.1:8402/mcp` (client snippets are in [hosted-http.md](hosted-http.md#client-configuration)):

<!-- molpha:generated:hosted-local -->
```sh
npx -y @molpha/mcp@0.2.0 --http --port 8402
```
<!-- /molpha:generated:hosted-local -->

- **A gateway with sessions enabled.** `GET <gateway>/v1/info` must report `"sessionAuth": true`. Against a gateway that reports `false`, `begin_session` answers `sessions_unavailable`: use x402 rounds, or the local server from section 2. If you run the server yourself, its `GATEWAY_ENDPOINTS` entry must be the gateway's `publicOrigin` from the same response: the message is signed for that host, and a challenge for any other is refused.
- **Access to a subscription.** The wallet is the subscription owner, or a delegate the owner added. `describe_access` tells you which, and under what limits. To create a subscription, see [Turn on spending](#3-turn-on-spending).
- **A wallet that signs a text message.** An Ed25519 signature over the message's raw UTF-8 bytes: what Solana wallets call `signMessage`.

### The flow

| Step | Call | What comes back |
|---|---|---|
| 1 | `describe_access({ address, owner? })` | The wallet's `role` (`owner`, `delegate` or `none`), its limits, and `canRequestRounds` |
| 2 | `begin_session({ address, owner? })` | The `message` to sign, an opaque `challenge`, and `expiresAt` |
| 3 | Your wallet signs `message` | A 64-byte signature |
| 4 | `complete_session({ challenge, signature })` | A `sessionToken`, the `role` it carries, and `expiresAt` |
| 5 | `execute_subscription_round({ sessionToken, apiConfig, signaturesRequired, chains })` | The signed attestation and verifier arguments |

Steps 2 to 4 happen once per session. Step 5 repeats until the token expires, and each call uses one round of the subscription's quota.

Step 1 signs and spends nothing, so run it first: a wallet with role `none` is refused at step 4, after you have already signed.

### What you sign

`begin_session` returns a message like this:

```text
gateway.example wants you to sign in with your Solana account:
<your wallet address>

Sign in to Molpha gateway <gateway PDA> as subscriber or delegate. This signature does not move funds.

URI: https://gateway.example/v1/session
Version: 1
Chain ID: EtWTRABZaYq6iMfeYKouRu166VU2xqa1
Nonce: 5f3a9c0e7b1d4a26c8e0f1a2b3c4d5e6
Issued At: 2026-10-07T12:00:00.000Z
Expiration Time: 2026-10-07T12:05:00.000Z
Resources:
- molpha:program:<program id>
- molpha:gateway:<gateway PDA>
- molpha:subscription:<subscription owner>
```

Before the server returns it, it checks the gateway's challenge against its own configuration: the domain and URI are the configured gateway's, the chain is the `SOLANA_RPC` cluster, the statement and resources name the Gateway PDA and program the server derived itself, and the message expires within five minutes. A challenge that says anything else is refused and never reaches your wallet.

Read it anyway before you sign. The first line names the gateway you expect, the second your address, and the last resource the subscription you mean to use.

### Sign the message

- Sign the `message` string exactly as returned: its UTF-8 bytes, with no prefix, no envelope and no trailing newline.
- Use the wallet's message-signing function, not transaction signing.
- Pass the signature as base58, base64 or hex. The server detects which; name it with `signatureEncoding` if you prefer.
- `solana sign-offchain-message` will **not** work: it wraps the text in an envelope, and the result is refused with `invalid_signature`.
- Sign and call `complete_session` before `expiresAt` (about five minutes). A signed message opens one session, once.

With a wallet adapter in a browser, `await wallet.signMessage(new TextEncoder().encode(message))` returns the signature bytes. In Node, with a devnet keypair file and [`@solana/kit`](https://www.npmjs.com/package/@solana/kit):

```js
import { readFileSync } from "node:fs";
import { createKeyPairFromBytes, getBase58Decoder, signBytes } from "@solana/kit";

// message: the `message` string begin_session returned
const secret = Uint8Array.from(JSON.parse(readFileSync(process.env.KEYPAIR_PATH, "utf8")));
const { privateKey } = await createKeyPairFromBytes(secret);
const signature = getBase58Decoder().decode(await signBytes(privateKey, new TextEncoder().encode(message)));
```

An agent wallet (Privy, Turnkey and others) works the same way when it exposes a raw message-signing call. Do not paste a private key into chat to get a signature.

### What a session is

- **Short-lived.** 30 minutes by default, and never past the subscription term. `expiresAt` is in the result. There is no refresh: sign in again for a new token.
- **One wallet, one gateway.** `complete_session` returns the `gatewayEndpoint` that issued the token. When the server is configured with several gateways, pass it to `execute_subscription_round`.
- **Identity only.** The gateway re-reads the subscription and the delegate account from chain for every round. Removing a delegate, or letting the subscription lapse, ends access within seconds, whatever tokens exist.
- **A credential.** The token admits rounds on the subscription until it expires, so keep it out of logs and version control. It passes through the hosted server on each `execute_subscription_round` call and is never stored, cached or logged there.
- **Bounded per wallet.** A gateway keeps a limited number of live sessions per wallet (16 by default); opening another ends the oldest.

### Delegates

A subscription owner can let another wallet, such as an agent's, request rounds without sharing the owner key. The owner sends the Molpha program's `add_delegate` instruction from their own wallet, with the delegate's address and `max_data_requests`, the rounds that delegate may request per subscription term. `remove_delegate` revokes it; there is no pause. This package has no command for either: use a client for the Molpha program.

The delegate then signs in with its own wallet as `address` and the owner's wallet as `owner`, in both `describe_access` and `begin_session`. A delegate account is keyed by owner and delegate, so the owner cannot be left out. The delegate's limit is enforced by the gateway, and rounds it runs also count against the plan's quota.

### Without the MCP server

The session routes are the gateway's own, so any HTTP client can use them. This also keeps the token off the hosted server entirely.

| Request | Purpose |
|---|---|
| `GET /v1/session/challenge?address=<wallet>[&owner=<owner>]` | The sign-in terms (`data.info`) and the exact text to sign (`data.message`) |
| `POST /v1/session` with a `SIGN-IN-WITH-X` header | Exchanges the signed message for `data.token`. Answers `201`. |
| `POST /v1/round/execute` with `Authorization: Bearer <token>` | Runs a round. Send no `authSig` or `authTimestamp`. |
| `DELETE /v1/session` with `Authorization: Bearer <token>` | Signs out. Answers `204`. |

The `SIGN-IN-WITH-X` header is base64 of a JSON object: the challenge's `info` fields, plus `address`, `chainId`, `type`, `signatureScheme` and the base58 `signature`.

```js
const gateway = "https://gateway.example";
const { data } = await (await fetch(`${gateway}/v1/session/challenge?address=${address}`)).json();

// Check data.message names the gateway, chain and subscription you expect, then sign it as above.
const payload = { ...data.info, address: data.address, chainId: data.chainId, type: "ed25519", signatureScheme: "siws", signature };
const res = await fetch(`${gateway}/v1/session`, {
  method: "POST",
  headers: { "SIGN-IN-WITH-X": Buffer.from(JSON.stringify(payload)).toString("base64") }
});
const { data: session } = await res.json(); // session.token, session.expiresAt (unix seconds)
```

Calling the gateway directly skips the checks `begin_session` makes on the challenge, so make them yourself before signing. An optional JSON body `{ "ttlSeconds": 900 }` on `POST /v1/session` asks for a shorter session, up to `sessionMaxTtlSeconds` from `GET /v1/info`.

### When it fails

| Code | Meaning | What to do |
|---|---|---|
| `sessions_unavailable` | The gateway has sessions disabled | Use x402 rounds, or a gateway with sessions |
| `invalid_signature` | Not the address's signature over the exact message | Sign `message` as returned, as raw UTF-8 |
| `invalid_challenge` | Not a `challenge` that `begin_session` returned | Call `begin_session` again |
| `sign_in_rejected` | The gateway refused the message: expired, or already used | Call `begin_session` again |
| `forbidden` | No active subscription, out of quota, or no delegate account under that owner | Check `describe_access` |
| `session_invalid` | The token is unknown, expired or revoked | Sign in again |

`execute_subscription_round` still spends on every call. After an unclear error, read state before trying again.

Try: *"Check with describe_access whether `<my wallet>` can request subscription rounds. If it can, begin a session for it and show me the message to sign. Wait for my signature before going further."*

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

See also: [README](../README.md) for the full tool reference, and [hosted-http.md](hosted-http.md) for the rest of the keyless hosted mode: x402 rounds, Solana submits, and running the server.
