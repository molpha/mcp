# Security Policy

## Supported versions

This project currently targets Solana Devnet and Sepolia verifier networks. Treat it as testnet software, not a production security boundary.

| Version | Supported |
| --- | --- |
| `0.1.x` | Yes |

## Reporting a vulnerability

Do **not** open a public GitHub issue for security reports.

Please use [GitHub's private vulnerability reporting](https://github.com/molpha/mcp/security/advisories/new).

Include as much of the following as you can:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- Affected versions, commits, or configuration (signer backend, MCP client, network)
- Whether private keys, funds, or credentials were put at risk

We will acknowledge receipt as soon as we can and follow up with next steps. Please give us a reasonable window to investigate and fix before any public disclosure.

## Scope

In scope for this repository:

- The Molpha MCP server and CLI tools in this repo
- Handling of local keypairs, Privy, and Turnkey credentials
- Write-path guardrails (`MOLPHA_DRY_RUN`, daily caps)
- Leakage or misuse of wallet signing through MCP tools

Out of scope / report elsewhere when possible:

- Molpha protocol, gateway, or on-chain program bugs — see [Molpha docs](https://docs.molpha.io/)
- Third-party services (Privy, Turnkey, RPC providers, MCP clients)
- Issues that only affect misconfigured local environments without a security impact on others

## Safe configuration

- Never commit `.env`, wallet JSON keypairs, Privy secrets, or Turnkey API keys
- Prefer dry-run mode (`MOLPHA_DRY_RUN=true` or per-tool `dryRun`) when experimenting with write tools
- Keep daily write caps enabled; treat them as safety rails, not durable rate limits
- Use funded Devnet wallets only for local testing; do not point this software at mainnet keys unless you fully understand the risk
