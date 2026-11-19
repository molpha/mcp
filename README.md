# Molpha MCP

[![CI](https://github.com/molpha/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/molpha/mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24-339933?logo=node.js&logoColor=white)](package.json)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that lets AI agents fetch signed [Molpha](https://docs.molpha.io/) oracle data, publish it on Solana, and build verifier calldata for EVM and Starknet.

Molpha turns HTTP API responses into threshold-signed payloads that can be verified on Solana, EVM, and Starknet. This server exposes that workflow as MCP tools, with signing behind a local, Privy, or Turnkey wallet, or, on `mcp.molpha.io`, behind your own wallet.

> [!WARNING]
> This release targets Solana Devnet and Sepolia verifier networks. Treat it as testnet software, not a production security boundary. Write tools spend SOL, and round tools may consume subscription quota or pay USDC for x402 rounds, unless dry-run mode is enabled.

## Quick start

Two recommended ways to connect:

| | [mcp.molpha.io](#mcpmolphaio) | [Local (stdio)](#local-stdio) |
| --- | --- | --- |
| Install | Nothing: add the URL to your client | `npx`, Node.js 24 or later |
| Signer | Your own wallet. The server holds no key. | Local keypair, Privy or Turnkey, held by the server |
| Subscription rounds | [Sign in with SIWX](#sign-in-with-your-wallet-siwx), then `execute_subscription_round` | `execute_subscription_round` |
| Spending limits | Your wallet's own policy | Dry-run lock and daily caps in the server |
| Best for | Getting started, agents that bring their own wallet | Unattended agents, private API sources |

### mcp.molpha.io

Nothing to install, and no keys to hand over. Add the URL to your client.

Claude Code:

```sh
claude mcp add --transport http molpha https://mcp.molpha.io/mcp
```

Cursor (`.cursor/mcp.json`):

```json
{ "mcpServers": { "molpha": { "url": "https://mcp.molpha.io/mcp" } } }
```

The read tools work straight away. The server has no wallet of its own, so name the one you mean: `submitter` for `describe_feed` and `get_latest_value`, `payer` for `get_x402_status`.

Anything that needs a signature is returned for your own wallet to sign, so each such operation is two or three tool calls around one signature:

| Operation | Tools, in order | The wallet signs |
| --- | --- | --- |
| Subscription round | `begin_session` → `complete_session` → `execute_subscription_round` | A text message, once per session |
| x402 round | `prepare_x402_round` → `execute_x402_round` | A USDC transfer, not broadcast |
| Solana submit | `prepare_submit_attestation` → `send_signed_transaction` | The submit transaction |

`autoSubmit`, `dryRun` and `encryptSecrets` are not offered here. Set spending limits in the wallet's own policy, and use the local server for private API work.

#### Sign in with your wallet (SIWX)

A subscription round on `mcp.molpha.io` is authorized by a **sign-in session**: the wallet signs one Sign-In-With-X text message (the x402 `sign-in-with-x` extension, in its Solana form), and the gateway issues a short-lived bearer token. The message is not a transaction and moves no funds.

| Step | Call | Result |
| --- | --- | --- |
| 1 | `describe_access({ address, owner? })` | Whether the wallet is a subscription `owner` or `delegate`, and its limits |
| 2 | `begin_session({ address, owner? })` | The `message` to sign and an opaque `challenge` |
| 3 | The wallet signs `message` | An Ed25519 signature over its exact UTF-8 bytes |
| 4 | `complete_session({ challenge, signature })` | A `sessionToken` and its `expiresAt` |
| 5 | `execute_subscription_round({ sessionToken, source, signaturesRequired, chains })` | The signed attestation and verifier arguments |

- **Who can sign in.** The subscription owner, or a delegate the owner added with `add_delegate`. A delegate passes the owner's address as `owner`.
- **How to sign.** The message as returned: raw UTF-8, no prefix, no envelope, no trailing newline. The signature may be base58, base64 or hex. `solana sign-offchain-message` wraps the text and is refused with `invalid_signature`.
- **What the token is.** A credential for one wallet and one gateway, valid 30 minutes by default and never past the subscription term. It only identifies the caller: the gateway re-reads the subscription and delegate from chain on every round, so `remove_delegate` ends access whatever tokens exist. It passes through this server and is never stored or logged.
- **What it needs.** A gateway with `sessionAuth: true` in `GET /v1/info`. Otherwise `begin_session` answers `sessions_unavailable` and x402 rounds remain available.

The full walkthrough, with a signing example, delegate setup, gateway routes and error codes, is in [docs/integration.md](docs/integration.md#4-sign-in-with-your-own-wallet-siwx).

### Local (stdio)

The server runs on your machine and holds the signer, so one tool call runs a round or submits to Solana, and `MOLPHA_DRY_RUN` keeps every write a preview until you turn it off.

<!-- molpha:generated:quick-start -->
Needs Node.js 24 or later. Nothing to clone or build.

**1. Look around, no wallet.** Read-only: capabilities, providers, `sourceId`s, prices, feed values.

```sh
claude mcp add molpha -- npx -y @molpha/mcp@0.2.0 --read-only
```

**2. Build with a testnet wallet.** Put your signer settings in a `.env` file (see [Setup](#setup)), then check them. The doctor prints a ready-to-paste config for your client, with secrets left as placeholders:

```sh
npx -y @molpha/mcp@0.2.0 doctor
```

A config like this keeps every write a preview (`MOLPHA_DRY_RUN=true`):

```sh
claude mcp add molpha -e SIGNER_BACKEND=keychain -e KEYCHAIN_BACKEND=privy -e PRIVY_APP_ID='<privy-app-id>' -e PRIVY_APP_SECRET='<privy-app-secret>' -e PRIVY_WALLET_ID='<privy-wallet-id>' -e PRIVY_WALLET_ADDRESS='<base58-solana-address>' -e MOLPHA_DRY_RUN=true -- npx -y @molpha/mcp@0.2.0
```

**3. Spend** only when you mean to: fund the wallet, then set `MOLPHA_DRY_RUN=false` in the server's config. The full guide, with Cursor, VS Code, Codex and Claude Desktop, is [docs/integration.md](docs/integration.md).
<!-- /molpha:generated:quick-start -->

With no signer configured the server starts **read-only** and offers only the read tools (`runLevel: "read-only"` in `get_capabilities`). `--read-only` or `SIGNER_BACKEND=none` forces it.

## Tools

| Tool | Access | Description |
| --- | --- | --- |
| `get_capabilities` | Read | Run level, program id, registry version, nodes, gateways, chains, verifier addresses, x402 caps and source-payment policy. |
| `derive_source_id` | Read, local | Validate a `source` document and derive its `sourceId` ([how](docs/reference.md#how-sourceid-is-derived)): the canonical JSON, the declared output, determinism warnings. No transaction, no wallet. |
| `describe_feed` | Read | Read the Solana feed for `(sourceId, signaturesRequired, submitter)` and the signer's subscription status. Pass the `source` to read the stored value by its declared output. |
| `get_latest_value` | Read | Read the latest attested value stored in a Solana feed account; with the `source`, rendered by its declared output. |
| `describe_access` | Read | Whether a wallet is a subscription owner or delegate, with the plan's and the delegate's limits. |
| `get_x402_status` | Read | Quote the next x402 round, show where payment goes, and read a payer's USDC balance and remaining daily budget. |
| `list_providers` | Read | The data providers the gateway integrates and the flows it serves ([providers](docs/reference.md#integrated-providers)). |
| `get_provider` | Read | One provider's flows, disclosure and ready-made feeds, each with a complete `source` and `sourceId`. |
| `quote_source_payment` | Read | Price a paywalled source with one unpaid request, including the worst-case total. |
| `execute_subscription_round` | Spends quota | Run a round paid from a USDC subscription; return the signed attestation plus verifier arguments. `autoSubmit: true` settles Solana in the same call. |
| `execute_x402_round` | Spends USDC | Run a round paid per request over [x402](docs/reference.md#x402-pay-per-request); same output. |
| `build_verifier_calldata` | Read, local | Build EVM/Starknet verifier address and `verify()` call arguments. Calldata only: it verifies nothing. |
| `submit_attestation` | Write | Submit a signed attestation to Solana. Accepts a round tool's output unmodified. |
| `list_data_templates` | Read | [Molpha Data](docs/reference.md#molpha-data) templates: token supply and balances, pool prices, LST rates, lending and savings rates, health factors, reference data and more, with their parameters and tools. |
| `read_data` | Read | Read a template or raw source: the Molpha Data service's unsigned read, with the source it read (re-hashed here). |
| `execute_data_round` | Spends quota or USDC | Sign a template (or raw source): the service derives the source, it is re-hashed here, and the round runs through `execute_subscription_round` / `execute_x402_round` (their dry-run lock and caps apply). |
| `get_balance` | Read | Account balance (`account.balance@1`): A wallet's native balance (EVM, Solana) or token balance (ERC-20, Starknet token, or the wallet's associated SPL token account). |
| `get_chain_head` | Read | Pinned block (`chain.head@1`): The block (EVM, Starknet) or slot (Solana) a source of this chain and finality reads at, from the source format's $block. |
| `get_curve_oracle_price` | Read | Curve EMA price oracle (`curve.priceOracle@1`): A Curve pool's exponential moving average price (price_oracle) of coin i+1 in coin 0. |
| `get_ekubo_price` | Read | Ekubo pool spot price (`dex.ekubo.price@1`): An Ekubo pool's current price from its square-root price, adjusted for both tokens' decimals. Ekubo pools have no address: the pool is named by its key. |
| `get_pool_price` | Read | Pool spot price (`dex.pool.price@2`): A pool's current price: from a concentrated-liquidity pool's square-root price (Uniswap v3 and v4, Slipstream, Whirlpool, Raydium CLMM), a Meteora DLMM pair's active bin, or a v2-style pool's reserves, adjusted for both tokens' decimals. |
| `get_pool_reserve` | Read | Pool reserve (`dex.pool.reserves@1`): One side of a pool's reserves: getReserves of a Uniswap v2-style pair, the token balance of a v3-style pool, or a Whirlpool's token vault. |
| `get_pool_snapshot` | Read | Pool state snapshot (`dex.pool.snapshot@1`): A concentrated-liquidity pool's state under one signature: square-root price, tick, active liquidity and fee (Uniswap v3 family), or the Whirlpool account up to its fee growth. |
| `get_pool_twap` | Read | Pool TWAP price (`dex.pool.twap@2`): The time-weighted average price over a window, from the pool's own oracle: 1.0001 raised to the mean tick (observe on EVM, rounded as Uniswap's OracleLibrary rounds it; a Raydium CLMM observation ring on Solana), or a Meteora DLMM pair's mean active bin, adjusted for both tokens' decimals. |
| `get_pool_twap_deviation` | Read | Pool spot against its TWAP (`dex.pool.twapDeviation@1`): How many ticks a pool's current tick is from its own mean tick over a window, both read at one block; or whether it is within a bound. |
| `get_eia_series` | Read | EIA energy series (`energy.eia@1`): One observation of an EIA series: WTI and Brent spot, Henry Hub spot, weekly U.S. crude stocks, weekly natural gas storage, weekly retail gasoline. |
| `get_vault_share_price` | Read | Vault share price (`erc4626.sharePrice@1`): Assets per vault share, from the vault's own convertToAssets. |
| `get_storage_slot` | Read | Storage slot (`evm.storage@1`): The 32 bytes of one storage slot of a contract at the pinned block. |
| `get_fx_reference_rate` | Read | Central bank reference exchange rate (`fx.reference@1`): A central bank's published exchange rate for one business day: the ECB's euro reference rates (about 16:00 CET) or the Bank of Canada's daily averages (by 16:30 ET). |
| `get_lei_status` | Read | LEI status (`lei.status@1`): Whether a Legal Entity Identifier is issued to an active entity, or its registration or entity status, from GLEIF's LEI records. |
| `get_aave_reserve` | Read | Aave v3 reserve rate or index (`lending.aave.reserve@1`): One of an Aave v3 (or Spark) reserve's current rates or indexes, from Pool.getReserveData. |
| `get_aave_totals` | Read | Aave v3 reserve totals (`lending.aave.totals@1`): An Aave v3 (or Spark) reserve's total supplied (aToken supply) or borrowed (variable debt token supply), or its utilization. |
| `get_aave4_hub` | Read | Aave v4 Hub asset totals and rates (`lending.aave4.hub@1`): An Aave v4 Liquidity Hub asset's total added (supplied through every Spoke) or owed, its utilization, its drawn (base borrow) rate or the rate its suppliers earn. |
| `get_aave4_spoke` | Read | Aave v4 Spoke reserve totals (`lending.aave4.spoke@1`): An Aave v4 Spoke reserve's total supplied or borrowed (drawn plus premium), or its utilization: the part of a Hub asset that flows through one Spoke. |
| `get_compound_market` | Read | Compound v3 market totals and rates (`lending.compound.market@1`): A Compound v3 (Comet) market's total supplied or borrowed base asset, its utilization, or its supply or borrow rate, computed from totalsBasic() as Comet computes getUtilization, getSupplyRate and getBorrowRate. |
| `get_euler_vault` | Read | Euler v2 vault totals and rates (`lending.euler.vault@1`): An Euler v2 (EVK) vault's total assets or borrows, its utilization, or its supply or borrow rate, from the vault's own views. |
| `get_fluid_token` | Read | Fluid Liquidity layer totals and rates (`lending.fluid.token@1`): A token's total supplied or borrowed on Fluid's Liquidity layer (shared by every Fluid lending, vault and DEX protocol), its utilization, or its supply or borrow rate. |
| `get_kamino_reserve` | Read | Kamino Lending reserve totals and rates (`lending.kamino.reserve@1`): A Kamino Lending reserve's total supplied or borrowed liquidity, its utilization, or its supply or borrow rate, from the reserve account and its borrow-rate curve. |
| `get_marginfi_bank` | Read | marginfi bank totals and rates (`lending.marginfi.bank@1`): A marginfi v2 bank's total deposits or borrows, its utilization, or its lending or borrowing rate, from the bank's shares, share values and rate cache. |
| `get_morpho_market` | Read | Morpho Blue market totals and rates (`lending.morpho.market@1`): A Morpho Blue market's total supplied or borrowed assets, its utilization, or its supply or borrow rate, from market(id) and the AdaptiveCurveIRM's rateAtTarget(id). |
| `get_vesu_market` | Read | Vesu market totals and rates (`lending.vesu.market@1`): A Vesu v2 pool's total supplied or borrowed amount of one asset, its utilization, or its supply or borrow rate, from asset_config(asset), utilization(asset) and interest_rate_config(asset). |
| `get_lst_market_deviation` | Read | LST market price against its exchange rate (`lst.marketDeviation@1`): How far a liquid staking token's pool price is from its own exchange rate, in basis points; negative when it trades at a discount. Or whether it is outside a band. |
| `get_lst_rate` | Read | Liquid staking token exchange rate (`lst.rate@1`): How much of the base asset one liquid staking token is worth, read from the token's own contract or stake pool. |
| `get_bea_series` | Read | BEA national accounts series (`macro.bea@1`): One period of a U.S. Bureau of Economic Analysis NIPA series as currently published: real GDP growth, final sales, PCE growth, and the PCE and core PCE price indexes and their monthly change. |
| `get_bls_series` | Read | BLS series value (`macro.bls@1`): One period of a U.S. Bureau of Labor Statistics series as currently published: CPI-U (CUUR0000SA0), the unemployment rate (LNS14000000), nonfarm payrolls (CES0000000001), or any other BLS series ID. |
| `compare_oracles` | Read | Two oracle prices compared (`oracle.compare@1`): The deviation between two prices on one chain (Chainlink, Pyth, RedStone, Chronicle or a pool's spot price on EVM; Pragma or an Ekubo pool on Starknet; Pyth or a pool on Solana), refusing a feed older than maxAge; or whether they agree within a bound. |
| `get_oracle_staleness` | Read | Price feed age (`oracle.staleness@1`): How long ago a price feed was last updated (Chainlink or Pyth on EVM, Pragma on Starknet, Pyth on Solana), at the round time; or, off Solana, whether it is within a maximum age. |
| `get_aave_health_factor` | Read | Aave v3 health factor (`position.aave.health@1`): An account's health factor on an Aave v3 (or Spark) market, from Pool.getUserAccountData. |
| `get_aave_liquidation_distance` | Read | Aave v3 distance to liquidation (`position.aave.liquidationDistance@1`): How far an account's collateral value can fall, debt unchanged, before the position can be liquidated: 1 - 1/healthFactor. |
| `get_aave4_health_factor` | Read | Aave v4 health factor (`position.aave4.health@1`): A user's health factor on an Aave v4 Spoke, from the Spoke's getUserAccountData. |
| `get_morpho_health_factor` | Read | Morpho Blue health factor (`position.morpho.health@1`): A borrower's health on a Morpho Blue market, computed as Morpho computes it: collateral at the market's oracle price times LLTV, over the borrow assets of the borrower's shares. |
| `get_median_price` | Read | Median price across pools (`price.median@1`): The median price of a token in a quote token across two to four concentrated-liquidity pools of that pair, optionally refusing pools below a liquidity floor. |
| `get_drand_randomness` | Read | drand quicknet randomness (`random.drand@1`): The randomness of one drand quicknet round (League of Entropy), delivered with a Molpha attestation on every chain Molpha verifies on. |
| `get_reference_rate` | Read | Overnight reference rate (`rates.reference@1`): An official overnight rate for one business day, from its administrator: SOFR, EFFR, OBFR, TGCR, BGCR and the SOFR Averages and Index (New York Fed), €STR (ECB), CORRA (Bank of Canada). |
| `get_sky_savings_rate` | Read | Sky savings rate (`savings.sky@1`): The Sky Savings Rate (sUSDS) or the DAI Savings Rate (sDAI): as a simple APR, as the compounded APY, or as the vault's share price. |
| `get_stablecoin_depeg` | Read | Stablecoin peg deviation (`stable.depeg@1`): How far a stablecoin's price is from its peg, from a pool's spot price, a Chainlink feed (EVM) or a Pyth feed (Solana); or, on EVM, whether it is outside a band. |
| `reconcile_supply` | Read | Bridged supply against its lockbox (`supply.reconcile@1`): A canonical token's balance locked in a bridge, less the total supply of its bridged copies on up to three other chains. |
| `get_token_controls` | Read | Token control flags (`token.controls@1`): An EVM token's pause flag, owner, and EIP-1967 implementation and admin, under one signature. |
| `get_token_snapshot` | Read | Token snapshot (`token.snapshot@1`): A token's supply and decimals (EVM, Starknet) or its whole SPL mint (supply, decimals, mint and freeze authorities) under one signature. |
| `get_token_supply` | Read | Token total supply (`token.supply@1`): The total supply of a token, in whole tokens, read from the token contract or the SPL mint. |
| `get_treasury_avg_rate` | Read | Average interest rate on Treasury securities (`treasury.avgRate@1`): The average interest rate on outstanding U.S. Treasury securities of one kind for one month (Fiscal Data, Average Interest Rates on U.S. Treasury Securities). |
| `get_treasury_debt` | Read | Debt to the Penny (`treasury.debt@1`): U.S. total public debt outstanding, or its debt held by the public or intragovernmental holdings, for one business day (Fiscal Data, Debt to the Penny). |

On `mcp.molpha.io` the one-call round and submit tools become prepare/sign/execute pairs ([above](#mcpmolphaio)). Every tool returns `structuredContent` and carries MCP annotations; see [Structured output and annotations](docs/reference.md#structured-output-and-annotations). For the source format, tolerance-mode aggregation and the full configuration table, see [docs/reference.md](docs/reference.md#sources).

**Round timing.** Rounds run on a fixed 100 ms tick. Requests for one feed (the same source and quorum) inside one tick share a round, so a feed runs at most 10 rounds per second, and one wallet gets at most one round per tick for a feed: a second request in the same tick is answered with HTTP 409, which the round tools retry a tick later before failing with `round_conflict`. See [Round timing](docs/reference.md#round-timing).

## Setup

For the [local server](#local-stdio).

**Signer.** Put your settings in a `.env` file and check them with the doctor. It prints a ready-to-paste config for your client with secrets left as placeholders. Use a dedicated testnet wallet.

```dotenv
SIGNER_BACKEND=memory
OWNER_KEYPAIR=/absolute/path/to/owner-keypair.json
SOLANA_RPC=https://api.devnet.solana.com
MOLPHA_DRY_RUN=true
```

Privy and Turnkey settings are in [docs/reference.md](docs/reference.md#signers) and [.env.example](.env.example).

<!-- molpha:generated:doctor -->
```sh
npx -y @molpha/mcp@0.2.0 doctor
```
<!-- /molpha:generated:doctor -->

**Dry-run lock.** `MOLPHA_DRY_RUN=true` locks `execute_subscription_round`, `execute_x402_round` and `submit_attestation` to previews. A call with `dryRun: false` is refused with `dry_run_locked`, so going live is a change to the server's config, never to one tool call.

**Subscription.** Subscribing debits USDC, so it is kept out of the MCP tools and runs as a CLI command with the same signer configuration. `--max-price-usdc` is a cap in USDC base units (6 decimals); drop `--dry-run` to subscribe, or use `extend` to extend one.

<!-- molpha:generated:provision -->
```sh
npx -y @molpha/mcp@0.2.0 provision subscribe --plan Basic --max-price-usdc 20000000 --dry-run
```
<!-- /molpha:generated:provision -->

**Client.** Every client launches the local server with `npx`. Snippets for Claude Code, Cursor, VS Code, Codex and Claude Desktop are in [docs/integration.md](docs/integration.md), ready-to-edit copies are in [examples](examples), and Claude Desktop users can install the `molpha-mcp.mcpb` bundle attached to each release.

## Example prompts

> **Discover.** Use Molpha to inspect the current oracle capabilities. Summarize the registry version, node count, chains, gateways, and verifier addresses. Make no writes.

> **Derive.** Derive a Molpha sourceId for a source that reads `https://api.example.com/v1/finalized/price`, takes the JSON value at `$.price` and signs it as an int256 with 8 decimals. Show me the source, the canonical JSON and the sourceId. Do not send a transaction.

> **Fetch.** For that source, run a subscription round with 3 signatures for the EVM chain. Summarize the value, timestamp, registry version and verifier call. Treat the signed attestation as the trust anchor, not the value alone.

> **Provider.** List the integrated data providers, describe TickerLayer's `btcusd` feed, and run it with 3 signatures for Solana, passing the feed's `source` exactly as given.

> **Check spend.** Call `get_x402_status` for 3 signatures. Tell me the price, where payment goes, and my USDC balance before I authorize an `execute_x402_round`.

> **Publish.** If I give you a newer signed attestation, preview `submit_attestation` with `dryRun: true`, explain the exact write, and wait for my confirmation before submitting.

Use a public endpoint that returns stable, independently reproducible data: live ticker endpoints may differ across oracle nodes and fail to reach quorum.

## How it works

```mermaid
flowchart LR
    Client["MCP client"] <-->|"stdio / HTTP"| Server["Molpha MCP server"]
    Server --> Guardrails["Dry-run · daily caps · spend caps"]
    Server --> Signer["Signer adapter<br/>local · Privy · Turnkey"]
    Server --> SDK["Molpha SDK / x402 client"]
    SDK --> Gateway["Molpha gateway"]
    Gateway <--> Nodes["Oracle node quorum"]
    SDK <--> Solana["Solana program<br/>feeds · subscriptions"]
    Gateway --> Artifact["Threshold-signed attestation"]
    Artifact --> Server
    Server --> Args["EVM / Starknet verifier args,<br/>or submit_attestation on Solana"]
```

The server is an adapter and policy boundary, not a new source of truth. Oracle nodes independently evaluate the committed source (their own HTTP fetches and chain reads) and produce one aggregate signature after reaching quorum; the server returns that self-contained signed artifact. Consumers trust a value only after verifying the signed payload against its registry version.

## Development

```bash
git clone https://github.com/molpha/mcp.git
cd mcp
npm ci
cp .env.example .env
npm run build
```

Point a client at the built server with `node /absolute/path/to/mcp/dist/src/server.js`.

```bash
npm run dev          # start from TypeScript
npm run typecheck && npm test && npm run build   # run before opening a pull request
npm run gen:install  # rewrite the generated install snippets in the docs and examples
npm run smoke:pack   # pack the tarball and run it with npx over stdio (needs network)
npm run pack:mcpb    # build the Claude Desktop bundle from an allowlist
```

`@molpha/sdk` is pinned to an exact version and resolved from the npm registry; to try a local checkout run `npm install ../sdk` and do not commit the result. Install snippets are generated from `src/install-config.ts`: edit the renderers, not the generated text, because `npm test` fails when a generated file is out of date.

Versioning and publishing use [Changesets](https://github.com/changesets/changesets): if a pull request changes published behavior, run `npx changeset`. On merge to `main`, [release.yml](.github/workflows/release.yml) opens a "Version Packages" PR and, when that merges, publishes `@molpha/mcp` to npm (trusted publishing, no token) and `server.json` to the [MCP registry](https://registry.modelcontextprotocol.io/).

Bug reports and focused pull requests are welcome. For security issues, use [GitHub's private vulnerability reporting](https://github.com/molpha/mcp/security/advisories/new) instead of a public issue.

## Documentation

- [Integration guide](docs/integration.md): install per client, spending, [signing in with your own wallet (SIWX)](docs/integration.md#4-sign-in-with-your-own-wallet-siwx), and running the HTTP server yourself
- [Reference](docs/reference.md): sourceId, tolerance mode, x402, providers, configuration, signers
- [Molpha protocol documentation](https://docs.molpha.io/)
- [Client configuration examples](examples) and the [MCPB manifest](manifest.json)

## License

Released under the [MIT License](LICENSE).
