# Hosted HTTP mode

Run `molpha-mcp --http --port 8402` (or `npm run dev -- --http`). Stdio remains the default. HTTP exposes `POST /mcp` and `GET /healthz`; it uses JSON responses with no sessions or resumable SSE stream. Each POST has its own server, signer, and SDK clients. Configuration and the RPC connection are shared.

The intended public endpoint is `https://mcp.molpha.io/mcp`. This repository change does **not** deploy it or assert that it is live. Use `http://127.0.0.1:8402/mcp` for local testing. The installed MCP SDK negotiates its supported protocol versions, currently through `2025-11-25`.

## Capabilities

| Tool | Unsigned hosted | Signed hosted |
|---|---|---|
| `get_capabilities`, `derive_source_id`, `build_verifier_calldata` | Full | Full |
| `describe_feed`, `get_latest_value` | Explicit `submitter` required | Defaults to signer |
| `get_x402_status` | Quote and gateway float; payer omitted | Includes payer |
| `execute_x402_round` | Parsed 402 quote, no signing or payment | Verified payment and round |
| `execute_subscription_round`, `submit_attestation` | Authentication-required error | Full |

Unsigned `describe_feed` omits signer subscription status. Unsigned x402 quotes are not payer-verified and contain no attestation. A signed execution obtains and independently verifies its payment requirements before paying; a previous unsigned quote is not a payment authorization.

| Policy | Public HTTP defaults | Local stdio / private self-hosting |
|---|---|---|
| Signer | Per-request Privy or Turnkey headers | Local keypair or managed signer in stdio |
| Source secrets via `encryptSecrets` | Rejected before processing | Supported in stdio; HTTP requires explicit opt-in |
| Source API auth headers | Allowed with a response warning | Keep private API work on infrastructure you control |
| Per-round x402 ceiling | `MOLPHA_X402_MAX_PRICE_USDC`, default 1 USDC | Same |
| Daily budgets | Disabled; configure provider policies | Stdio retains daily caps; private HTTP can opt into process-wide caps |
| IP rate limit | Burst 60, refill 1/second, per instance | HTTP operator configurable |

### Trust and credentials

Hosted signing is revocable signing delegation. The server receives provider API credentials in plaintext inside its TLS-terminated process and temporarily holds them while handling a request. It does not persist credentials, create credential sessions, or log header values, arguments, or raw provider errors. This is **not** a claim that the hosted process cannot see credentials. Use scoped provider credentials with amount/spend policies and revoke them when no longer needed. Allowlisting a destination alone does not establish a spending budget.

HTTP never uses `OWNER_KEYPAIR`, `AGENT_KEYPAIR`, `SIGNER_BACKEND`, `KEYCHAIN_BACKEND`, or provider credential environment variables as a signer fallback. It rejects local-wallet signer selection, JSON keypair arrays, and base58-encoded 64-byte wallet secret material in headers. A Turnkey 32-byte hex P-256 API credential is allowed. These shape checks do not identify every possible secret encoding; never send wallet private keys.

Send all required headers on **every** signed request:

| Selector | Required headers |
|---|---|
| `X-Molpha-Signer: privy` | `X-Molpha-Privy-App-Id`, `X-Molpha-Privy-App-Secret`, `X-Molpha-Privy-Wallet-Id`, `X-Molpha-Privy-Wallet-Address` |
| `X-Molpha-Signer: turnkey` | `X-Molpha-Turnkey-Api-Public-Key`, `X-Molpha-Turnkey-Api-Private-Key`, `X-Molpha-Turnkey-Organization-Id`, `X-Molpha-Turnkey-Wallet-Address` |

Omit all signer headers for unsigned access. Duplicate, mixed-provider, incomplete, and unsupported signer headers fail before any tool is run. Wallet addresses must be valid base58 Solana public keys. Header-based signing is custom authentication, not MCP OAuth 2.1; no OAuth discovery or authorization server is provided.

## Client configuration

These examples target the local server. Replace the URL with the public endpoint only after deployment. Configure secrets locally in the client; do not commit populated credential files. Confirm headers are forwarded on tool calls as well as initialization.

| Client | Unsigned | Signed configuration |
|---|---|---|
| Cursor | HTTP URL | `headers` in `mcp.json` |
| Claude Code | HTTP URL | Repeated `--header` options |
| Claude Desktop | Via `mcp-remote` | `mcp-remote --header`; alternatively use the local `.mcpb` bundle |
| Other remote MCP clients | When compatible with the supported protocol | Requires custom headers or a bridge |
| Clients without custom headers | Unsigned tier only | Use a header-capable client or local stdio |

Cursor configuration (replace placeholders locally):

```json
{
  "mcpServers": {
    "molpha": {
      "url": "http://127.0.0.1:8402/mcp",
      "headers": {
        "X-Molpha-Signer": "privy",
        "X-Molpha-Privy-App-Id": "<app-id>",
        "X-Molpha-Privy-App-Secret": "<app-secret>",
        "X-Molpha-Privy-Wallet-Id": "<wallet-id>",
        "X-Molpha-Privy-Wallet-Address": "<base58-wallet-address>"
      }
    }
  }
}
```

For unsigned access remove `headers`. See [Cursor MCP configuration](https://prod.cursor.com/help/customization/mcp).

Claude Code, using environment variables populated locally:

```sh
claude mcp add --transport http molpha http://127.0.0.1:8402/mcp \
  --header "X-Molpha-Signer: privy" \
  --header "X-Molpha-Privy-App-Id: $PRIVY_APP_ID" \
  --header "X-Molpha-Privy-App-Secret: $PRIVY_APP_SECRET" \
  --header "X-Molpha-Privy-Wallet-Id: $PRIVY_WALLET_ID" \
  --header "X-Molpha-Privy-Wallet-Address: $PRIVY_WALLET_ADDRESS"
```

This stores credentials in the client's configuration; command arguments may also be visible to local processes. Use the client's supported secret/configuration mechanisms as appropriate. See [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

Claude Desktop bridge configuration (the `${...}` placeholders below are expanded by `mcp-remote` from its process environment):

```json
{
  "mcpServers": {
    "molpha": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "http://127.0.0.1:8402/mcp", "--allow-http",
        "--header", "X-Molpha-Signer:privy",
        "--header", "X-Molpha-Privy-App-Id:${PRIVY_APP_ID}",
        "--header", "X-Molpha-Privy-App-Secret:${PRIVY_APP_SECRET}",
        "--header", "X-Molpha-Privy-Wallet-Id:${PRIVY_WALLET_ID}",
        "--header", "X-Molpha-Privy-Wallet-Address:${PRIVY_WALLET_ADDRESS}"
      ],
      "env": {
        "PRIVY_APP_ID": "<app-id>",
        "PRIVY_APP_SECRET": "<app-secret>",
        "PRIVY_WALLET_ID": "<wallet-id>",
        "PRIVY_WALLET_ADDRESS": "<base58-wallet-address>"
      }
    }
  }
}
```

Use HTTPS and remove `--allow-http` for deployment. Disable bridge debug logs when using credentials. See [mcp-remote header configuration](https://github.com/punkpeye/mcp-remote).

Plain Node `fetch`, unsigned discovery:

```js
const response = await fetch('http://127.0.0.1:8402/mcp', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-11-25'
    // Add the complete managed-signer header set for signed tool calls.
  },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}
  })
});
console.log(await response.json());
```

Normal MCP clients perform initialization first. The server retains no initialization session between POSTs. Browser callers with an Origin must match the configured allowlist; cross-origin browser CORS support is not provided by default. The fetch example is for Node.

## Configuration and operations

| Variable | Default | Meaning |
|---|---|---|
| `MOLPHA_HTTP_HOST` | `127.0.0.1` | Listener address; container sets `0.0.0.0` |
| `MOLPHA_HTTP_PORT` | `8402` | `--port` takes precedence |
| `MOLPHA_HTTP_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1],mcp.molpha.io` | Exact hostnames, without ports |
| `MOLPHA_HTTP_ALLOWED_ORIGINS` | Local HTTP origins at configured port, `https://mcp.molpha.io` | Exact origins; requests without Origin are accepted |
| `MOLPHA_HTTP_TRUSTED_PROXIES` | Empty | Exact immediate-proxy socket IPs, including IPv4-mapped form if applicable |
| `MOLPHA_HTTP_ALLOW_ENCRYPT_SECRETS` | `false` | Private self-hosting opt-in |
| `MOLPHA_HTTP_DAILY_CAPS` | `false` | Enables existing **process-wide** daily limits, unsuitable for multi-tenant budgeting |
| `MOLPHA_HTTP_RATE_LIMIT` | `true` | Enables per-IP limit |
| `MOLPHA_HTTP_RATE_BURST` | `60` | Bucket capacity |
| `MOLPHA_HTTP_RATE_REFILL` | `1` | Tokens per second |

Server gateway/RPC configuration, verifier networks, `MOLPHA_DRY_RUN`, and `MOLPHA_X402_MAX_PRICE_USDC` retain their meanings. Explicit `dryRun` tool arguments retain stdio precedence over the default. Bodies are capped at 256 KiB; headers at 16 KiB. Health checks bypass rate limiting. There are at most 10,000 rate buckets, with idle entries reclaimed when capacity is needed. Metrics and rate limits reset on restart.

Only trust a proxy that overwrites forwarding headers. The server accepts a single `CF-Connecting-IP` (preferred) or single `X-Forwarded-For` IP when the socket peer is explicitly trusted; comma-separated forwarding chains are not accepted. Do not expose an origin listener configured to trust arbitrary user-supplied forwarding headers.

Requests have a 90-second deadline. Disconnects and deadlines cancel direct x402 HTTP fetches and prevent subsequent signing/submission steps. The Molpha SDK and provider SDKs do not universally support cancellation: an already-running call can finish after the client disconnects. No cancellation can reverse a payment, consume-free a subscription round, or undo a submitted transaction. Timeout responses conservatively warn against blind retries; x402 responses preserve public reconciliation identifiers when payment may have been sent. `SIGINT`/`SIGTERM` drain existing connections within the request deadline, then force-close remaining sockets.

Hosted capabilities expose only the RPC URL origin, omitting provider API keys in its path/query. Logs contain only tool name, signer tier, status, latency, and a process-salted IP hash. Aggregate tool/tier/status counters are emitted every minute and at shutdown. Header values, tool arguments, and raw provider errors are excluded. This application policy must also be enforced at the proxy, tracing, crash reporting, and log collector layers.

## Single-instance deployment runbook

1. Build and run locally:

   ```sh
   docker build -t molpha-mcp-http .
   docker run --rm --name molpha-mcp-http -p 127.0.0.1:8402:8402 \
     -e SOLANA_RPC=https://api.devnet.solana.com \
     molpha-mcp-http
   ```

   The image uses Node 24 and a non-root user. It includes the locked dependency tree (including both optional managed-signer providers). Docker build context uses an allowlist and excludes local credentials, `.env`, `.git`, and `.mcpb` artifacts. Do not bake runtime secrets into an image.
2. Deploy one instance behind a TLS reverse proxy and Cloudflare, route `/mcp` and `/healthz`, disable caching, and allow signer headers through. Keep all public hosted policy defaults. Set proxy/LB idle and response timeouts to at least 120 seconds and shutdown grace to at least 95 seconds. Do not automatically retry POSTs.
3. Restrict origin ingress to your proxy. Configure exact trusted proxy IPs and have the proxy overwrite the client-IP header. Keep local health-check hosts in the Host allowlist. Supply gateway authority pins if the gateway does not publish `/v1/info`.
4. Configure health-based process/container replacement and an external uptime monitor for `/healthz`. A Docker `HEALTHCHECK` alone marks unhealthy containers; the deployment platform must implement replacement. Alert on unavailable health, increased failures, and timeouts. Store only the safe application fields; disable header/body capture and verbose provider tracing throughout the path. Set operational log retention to 7 days.
5. Validate initialization and tools/list with MCP Inspector, unsigned feed reads and quotes against devnet, then a funded managed-signer test. Set provider amount policies before signed tests. Check canary tests, origin restrictions, proxy timeouts, and forwarded-IP handling.
6. Only after the endpoint is verified live, add a `streamable-http` remote with URL `https://mcp.molpha.io/mcp` to `server.json` and refresh the registry metadata. This implementation deliberately leaves that metadata unchanged.

Scale-out needs a shared rate limiter and revised operational limits. No durable tenant budgets, OAuth wrapper, treasury tools, or demo signer are included.

## Tests

`npm test`, `npm run typecheck`, and `npm run build` cover the regular suite. HTTP tests start loopback servers and mock upstream services; they require no funded wallet. Canary tests capture request logs and scan for credential and argument markers, including error paths.

Live devnet tests are skipped unless `MOLPHA_HTTP_DEVNET_TEST=true`. Set `MOLPHA_HTTP_TEST_API_CONFIG` to a deterministic public API config JSON and optionally `MOLPHA_HTTP_TEST_QUORUM` (default 2). This runs unsigned discovery and quoting. To additionally spend devnet USDC for a managed-signer round, explicitly set `MOLPHA_HTTP_DEVNET_PAID_TEST=true` and supply `MOLPHA_HTTP_TEST_HEADERS` as a JSON object with the complete Privy or Turnkey headers for a funded devnet wallet. The test does not load `.env` or local keypair files. Never put these secrets in CI command output.
