# Deploy the public hosted MCP on Vercel

This is the step-by-step runbook for putting Molpha's **stateless Streamable HTTP** server on Vercel as a public endpoint (`POST /mcp`, `GET /healthz`). Stdio, Docker, and local `--http` are unchanged. Protocol, policy, and client configuration live in [hosted HTTP mode](hosted-http.md); this document only covers Vercel.

The intended production URL is `https://mcp.molpha.io/mcp`. Do not add that URL to `server.json` or the MCP registry until the endpoint is live and the canary in this runbook has passed.

Vercel captures the Node `http.Server` in `src/server.ts` (it looks for `src/server.ts` and a `listen()` call) and runs it as **one Fluid compute function**. When `VERCEL=1`, the process starts HTTP mode automatically — you do not pass `--http` on Vercel. Each POST still builds its own MCP server, signer, and SDK clients. There is no session store, no SSE stream, and no durable daily budget.

## What you need

- A Vercel account that can create a project from [github.com/molpha/mcp](https://github.com/molpha/mcp). Hobby is enough for a first deploy (Fluid default max duration is 300 seconds). Use Pro or Enterprise for production spend caps, WAF, and Instant Rollback.
- GitHub org access to connect the repository (or a fork).
- Node.js 24 locally if you will run `vercel dev`.
- A public hostname. Production should be `mcp.molpha.io`; Vercel also issues `*.vercel.app`.
- A Solana RPC URL you are willing to expose as an **origin only** (the hosted tools strip path/query API keys from `solanaRpc` in responses). Do not put an API key in the RPC URL if you can avoid it.
- Optional: the Molpha gateway authority pin if the gateway does not serve `GET /v1/info`.

Do **not** put wallet keypairs, Privy secrets, or Turnkey API keys in Vercel. The hosted server is keyless: it never uses `OWNER_KEYPAIR`, `SIGNER_BACKEND`, `KEYCHAIN_BACKEND`, or provider credential environment variables, and it accepts no credentials from clients either. Callers sign with their own wallet. See [Keyless by design](hosted-http.md#keyless-by-design).

The one secret the deployment does need is `MOLPHA_HTTP_CHALLENGE_SECRET` (see step 4): it authenticates the state the prepare tools hand back to the execute tools, and every Fluid instance must share it.

## 1. Confirm the server locally first

Vercel will run the same HTTP stack. Prove it on loopback before importing the project.

```sh
npm ci
npm run typecheck && npm test && npm run build
npm start
```

`npm start` is `node dist/src/server.js --http` and binds `127.0.0.1:8402` unless you override host/port.

```sh
curl -sS http://127.0.0.1:8402/healthz
# {"status":"ok"}

curl -sS http://127.0.0.1:8402/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

You should see seventeen tools. Stop the process (`Ctrl+C`) before deploying.

Optional: `npx vercel dev` from the repo root. Vercel CLI sets `VERCEL=1`, so `src/server.ts` starts HTTP without `--http`. Use this to catch Host-allowlist and env mistakes before a cloud deploy.

## 2. Create the Vercel project from GitHub

Dashboard path:

1. [vercel.com/new](https://vercel.com/new) → **Import Git Repository**.
2. Select `molpha/mcp` (or your fork). Root Directory: `.` (repository root).
3. Framework Preset: leave as detected. Vercel should identify a Node.js server from `src/server.ts`. Do **not** switch it to Next.js.
4. Project name: something like `molpha-mcp` (this becomes `molpha-mcp.vercel.app`).
5. Node.js Version: **24.x** (Settings → General → Node.js Version, or rely on `"engines": { "node": ">=24.0.0" }` in `package.json`).
6. Do not add environment variables yet. Click **Deploy** once if you want a failing-closed first build, or skip deploy until step 4.

CLI path (same outcome):

```sh
npm i -g vercel
vercel login
vercel link          # create / link the project
vercel env pull      # optional; do not commit .env.local if it ever contains secrets
```

The repo already contains [`vercel.json`](../vercel.json):

| Key | Why it is set |
| --- | --- |
| `fluid: true` | MCP traffic is bursty with long I/O waits. Fluid is Vercel's default; this pins it. |
| `installCommand: npm ci --include=dev` | Kept from when the hosted server loaded the Privy and Turnkey SDKs (installed as `devDependencies`). It no longer loads them; a production-only install has not been tried on Vercel. |
| `functions["src/server.ts"].maxDuration: 300` | Hosted requests have a 90-second application deadline. 300 seconds is the Hobby Fluid maximum and gives the platform margin above that. |
| `Cache-Control: no-store` | MCP POST bodies and health are not CDN-cacheable. The app also sets `no-store`. |

Do not add `outputDirectory`, Next.js rewrites, or a second `/api` MCP route. One captured Node server already serves `/mcp` and `/healthz`.

## 3. Set environment variables

Vercel → Project → **Settings → Environment Variables**. Add every row below to **Production**. Repeat for **Preview** only if you will hit preview URLs with MCP clients.

Leave a variable unset when the default is what you want. Empty strings are not the same as unset for some parsers; prefer omitting the key.

| Variable | Production value | Notes |
| --- | --- | --- |
| `SOLANA_RPC` | `https://api.devnet.solana.com` (or your RPC origin) | Required for feed reads and for building and checking payments. Prefer an origin with no API key in the path. |
| `GATEWAY_ENDPOINTS` | unset, or `https://dev-gateway.molpha.io` | Molpha gateway base URL(s), comma-separated. **Not** a Solana RPC URL. |
| `GATEWAY_AUTHORITIES` | gateway base58 authority, one per endpoint | Required if the gateway does not serve `GET /v1/info`. Same order as `GATEWAY_ENDPOINTS`. |
| `MOLPHA_EVM_NETWORKS` | `evm-sepolia` | Default is already this. |
| `MOLPHA_STARKNET_NETWORKS` | `starknet-sepolia` | Default is already this. |
| `MOLPHA_X402_MAX_PRICE_USDC` | `1` | Per-round ceiling. Keep the public default until you have a reason to change it. |
| `MOLPHA_HTTP_ALLOWED_HOSTS` | unset, or `mcp.molpha.io,molpha-mcp.vercel.app` | Exact hostnames, no ports. Vercel also **merges** `VERCEL_URL`, `VERCEL_BRANCH_URL`, and `VERCEL_PROJECT_PRODUCTION_URL` at runtime, so preview `*.vercel.app` hosts work without listing every deployment. |
| `MOLPHA_HTTP_ALLOWED_ORIGINS` | unset, or `https://mcp.molpha.io` | Exact origins. Requests with no `Origin` are accepted (normal for Cursor/Claude). Browser CORS is not provided. |
| `MOLPHA_HTTP_HOST` | unset | On Vercel this defaults to `0.0.0.0`. Vercel intercepts `listen()` and does not publish that port publicly. |
| `MOLPHA_HTTP_PORT` / `PORT` | unset | Vercel injects `PORT`. The server honors `MOLPHA_HTTP_PORT`, then `PORT`, then `8402`. The listen port is only used locally. |
| `MOLPHA_HTTP_TRUSTED_PROXIES` | **leave unset** | Only trust a proxy that overwrites forwarding headers with a single IP. Vercel’s socket peer is not a documented static allowlist, and `X-Forwarded-For` may be a chain (rejected). Edge rate limits belong in Vercel Firewall, not in-process IP buckets. |
| `MOLPHA_HTTP_CHALLENGE_SECRET` | 32+ random bytes, hex or base64 (`openssl rand -hex 32`) | **Sensitive.** Required for `prepare_x402_round` / `execute_x402_round` and `prepare_submit_attestation` / `send_signed_transaction`; without it they answer `missing_config`. A malformed value fails startup. Set it for every environment that should take payments. |
| `MOLPHA_HTTP_CHALLENGE_SECRET_PREVIOUS` | unset | Rotation only: the old secret, verified for a few minutes after a change. |
| `MOLPHA_HTTP_ALLOW_ENCRYPT_SECRETS` | **leave unset** | No longer supported; `true` fails startup. |
| `MOLPHA_HTTP_DAILY_CAPS` | unset / `false` | Process-wide counters are meaningless across Fluid instances. Callers set limits in their own wallet's policy. |
| `MOLPHA_HTTP_RATE_LIMIT` | `true` | Per-instance token bucket. Complements, does not replace, WAF. |

**Never set on Vercel:** `SIGNER_BACKEND`, `KEYCHAIN_BACKEND`, `OWNER_KEYPAIR`, `AGENT_KEYPAIR`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WALLET_ID`, `PRIVY_WALLET_ADDRESS`, `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, `TURNKEY_ORGANIZATION_ID`, `TURNKEY_WALLET_ADDRESS`, or any local `.env` dump.

After saving variables, you must **redeploy** for them to apply.

## 4. Open the production URL to MCP clients

MCP clients are not browsers. Two Vercel features will 401/403 them if left on.

1. **Deployment Protection** — Settings → Deployment Protection.
   - Production: **Disabled** (or “Only Preview deployments”). A public MCP cannot sit behind Vercel Authentication.
   - Preview: keep **Standard Protection**. Share bypass tokens only for staff testing; do not put bypass secrets in client configs you will commit.
2. **Vercel Authentication / Password Protection / SSO** — off for production.
3. **Attack Challenge Mode / Bot Fight** — off for `/mcp`. Challenge pages break JSON-RPC clients. If you enable the WAF, allowlist `POST /mcp` and `GET /healthz` as legitimate API traffic, not as browser traffic.
4. **Deployment logs public** — keep logs private. They must not contain headers or bodies; the app already omits them, but platform log settings can reintroduce capture.

## 5. Firewall, timeouts, and caching

1. Settings → **Functions**: confirm Fluid is on, default max duration ≥ 120 seconds (repo sets 300 on `src/server.ts`).
2. Settings → **Firewall**:
   - Add a rate limit on `POST /mcp` (start around 60 req/min/IP, then tune).
   - Do not cache `POST /mcp`. GET `/healthz` may be cached briefly; the app sends `no-store` either way.
   - Disable request-body and header logging on any Log Drain, tracing, or WAF debug rule. The application log contract is: tool name, status, latency, process-salted IP hash. Nothing else.
3. Do **not** configure platform retries for POST. A retried `execute_x402_round` or `submit_attestation` can double-spend. Timeouts return a conservative warning; treat `payment_outcome_unknown` as “reconcile, then decide,” never “retry immediately.”
4. Optional: Settings → Functions → **Region**. Pin near the Solana RPC and `dev-gateway.molpha.io` if you observe cold-start plus RTT issues. One region is enough; this is a single logical function.

## 6. Deploy production

Dashboard: **Deployments → Redeploy** the production branch (`main`), or push a commit.

CLI:

```sh
vercel deploy --prod
```

Wait for the build to finish. Common build failures:

| Symptom | Fix |
| --- | --- |
| Detected as Next.js / missing `/mcp` | Framework must be Node.js server; delete any accidental `app/` or `next.config`. |
| `Cannot find module '@privy-io/node'` (or Turnkey) on signed calls | `installCommand` must be `npm ci --include=dev`. |
| Function exceeded 250 MB | Enable Large Functions (Fluid, public beta) or stop bundling unused native extras. The hosted server signs nothing, so the Privy and Turnkey SDKs (optional dependencies of the package) are not needed. The Docker image prunes them; `npm ci` here installs them, so add `--omit=optional` to `installCommand` if size is the problem. |
| Host is not allowed (403) | `Host` header is the public hostname. Confirm it is `mcp.molpha.io`, the production `*.vercel.app`, or a hostname Vercel injected (`VERCEL_URL`). |
| 401 from Vercel, not JSON-RPC | Deployment Protection is still on. |

## 7. Verify the deployment

Replace `https://molpha-mcp.vercel.app` with the deployment URL Vercel printed.

### Health

```sh
curl -sS -D- https://molpha-mcp.vercel.app/healthz
```

Expect `200` and `{"status":"ok"}`. `cache-control: no-store` should be present.

### Unsigned initialize + tools/list

```sh
curl -sS https://molpha-mcp.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"canary","version":"1"}}}'

curl -sS https://molpha-mcp.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

There is no `Mcp-Session-Id`. Each POST is independent; skip initialize if you only need `tools/list` for a smoke test (MCP Inspector still initializes first).

### MCP Inspector

```sh
npx @modelcontextprotocol/inspector@latest
```

Transport: **Streamable HTTP**. URL: `https://<deployment>/mcp`. No headers or credentials are needed. List tools (seventeen), then `get_capabilities`: `payment.signing` should read `caller`.

### Wrong-host check

```sh
curl -sS https://molpha-mcp.vercel.app/mcp \
  -H 'Host: evil.example' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expect 403 `Host is not allowed.` (TLS/SNI may make this hard through the public hostname; the Inspector origin check is the practical equivalent: a browser `Origin` that is not allowlisted returns 403.)

### Feed read

Call `describe_feed` with an explicit `submitter`. The hosted server has no wallet to default to and rejects a missing `submitter`.

### Paid canary (devnet, funded test wallet, wallet-side limits on)

Only after the checks above pass, with `MOLPHA_HTTP_CHALLENGE_SECRET` set. Use a throwaway devnet wallet holding a little USDC, with a spending policy that allowlists the protocol treasury token account and USDC mint.

Client configuration is the URL alone:

```json
{
  "mcpServers": {
    "molpha": { "url": "https://molpha-mcp.vercel.app/mcp" }
  }
}
```

Then:

1. `get_capabilities`
2. `get_x402_status` with the target quorum and `payer` set to the test wallet
3. `prepare_x402_round` for that payer. Nothing is signed or spent; check `summary` (`payTo` is the protocol treasury, `amountAtomicUsdc` the quoted price)
4. Sign `unsignedTransaction` with the wallet, without broadcasting, and call `execute_x402_round` — only if the summary and the wallet policy both look right

Because prepare and execute are separate requests, they may land on different Fluid instances; that working is the check that the challenge secret is really shared.

Watch Vercel Function logs: you should see JSON lines with `tool`, `status`, `latencyMs`, `ipHash`. If a header value, session token, signed transaction or `apiConfig` appears, **stop** — that is a platform logging misconfiguration, not expected application behavior.

## 8. Attach `mcp.molpha.io`

1. Vercel → Project → **Settings → Domains** → Add `mcp.molpha.io`.
2. At your DNS provider, create the record Vercel shows (usually `CNAME mcp → cname.vercel-dns.com`). Apex domains may need `A`/`ALIAS` records instead.
3. Wait until the domain shows **Valid** and HTTPS is issued.
4. Confirm the Host allowlist: `mcp.molpha.io` is already a default allowed host. If you overrode `MOLPHA_HTTP_ALLOWED_HOSTS`, add it explicitly and redeploy.
5. Repeat the step 7 curls against `https://mcp.molpha.io/healthz` and `https://mcp.molpha.io/mcp`.
6. Point clients at `https://mcp.molpha.io/mcp` (see [Client configuration](hosted-http.md#client-configuration); drop `--allow-http` and any `127.0.0.1` URLs).

Keep the `*.vercel.app` production alias. It is useful for break-glass checks if DNS is wrong. Both hostnames are allowed when Vercel injects `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL`.

## 9. Operational defaults after go-live

| Topic | What to do |
| --- | --- |
| Uptime | External monitor `GET https://mcp.molpha.io/healthz` every minute. Alert on non-200. |
| Failures / 504 | Application timeout is 90 seconds. Platform max is 300. Do not auto-retry POST. |
| Rate limits | In-process limiter is per Fluid instance and resets on scale/cold start. Enforce public limits on the WAF. |
| Daily caps | Leave `MOLPHA_HTTP_DAILY_CAPS=false`. Budgets belong in each caller's wallet policy. |
| Logs | Retain ~7 days. Store only the safe application fields. |
| Rollback | Vercel Instant Rollback to the last good production deployment. |
| Secrets | Rotate provider credentials by revoking them at the provider; the server does not persist them. |
| Scale-out | Expected. There is no shared rate limiter or tenant budget in-app. |

## 10. Registry metadata (last)

Only after `https://mcp.molpha.io/mcp` is verified live:

1. Add a `streamable-http` remote with that URL to [`server.json`](../server.json).
2. Publish/refresh MCP registry metadata through the existing release workflow.
3. Do not do this from a `*.vercel.app` preview URL.

This repository does not add the remote until that launch step.

## Client snippets (production)

Cursor:

```json
{
  "mcpServers": {
    "molpha": {
      "url": "https://mcp.molpha.io/mcp"
    }
  }
}
```

Claude Code:

```sh
claude mcp add --transport http molpha https://mcp.molpha.io/mcp
```

Claude Desktop via `mcp-remote` (HTTPS, no `--allow-http`):

```json
{
  "mcpServers": {
    "molpha": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.molpha.io/mcp"]
    }
  }
}
```

No headers are configured. The tool flows and what the caller's wallet signs: [hosted HTTP mode](hosted-http.md).

## Troubleshooting

| Observation | Likely cause |
| --- | --- |
| Function never calls `listen()`, or stdio hangs in Vercel logs | `VERCEL` is not `1`, or the entry is not `src/server.ts`. Vercel must capture the HTTP server, not the stdio default. |
| 404 on `/mcp` | Wrong framework preset, or a rewrite sent traffic to a missing `/api` route. |
| 403 Host / Origin | Hostname not in the allowlist (custom domain not added, or `MOLPHA_HTTP_ALLOWED_HOSTS` overrode defaults and omitted the Vercel host). |
| 405 on GET `/mcp` | Expected. Streamable HTTP here is POST-only JSON; no SSE GET. |
| 413 | Body > 256 KiB. |
| 429 | In-process or WAF rate limit. |
| 504 with reconcile warning | 90-second deadline after a write may have started. Check the payer’s USDC memo before another paid round. |
| 400 `X-Molpha-* signer headers are no longer accepted` | A client still configured for the removed per-request signer scheme. Remove the headers; the server takes no credentials. |
| `missing_config` from a prepare or execute tool | `MOLPHA_HTTP_CHALLENGE_SECRET` is not set in that environment (redeploy after adding it). |
| `invalid_challenge` right after a prepare | Instances disagree on the challenge secret (a deploy in progress, or a secret set for only some environments). |
| `payment_expired` | More than about a minute passed between prepare and execute. Prepare again. |
| Cold start > a few seconds | First Fluid instance loading the Solana SDKs. Subsequent requests on a warm instance are faster. |

## Related

- [Hosted HTTP mode](hosted-http.md) — keyless flows, policy, Docker runbook, tests
- [Vercel: Node.js servers](https://vercel.com/docs/functions/runtimes/node-js)
- [Vercel: function duration](https://vercel.com/docs/functions/configuring-functions/duration)
- [Vercel: deploy MCP servers](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel) — generic Next.js `mcp-handler` path; this repo uses the captured Node server instead
