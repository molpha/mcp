# Hosted HTTP mode

Run `molpha-mcp --http --port 8402` (or `npm run dev -- --http`). Stdio remains the default. HTTP exposes `POST /mcp` and `GET /healthz`; it uses JSON responses with no sessions or resumable SSE stream. Each POST has its own server and SDK clients. Configuration and the RPC connection are shared. The server holds no keys and accepts no credentials: anything that needs a signature is returned for the caller's own wallet to sign.

The intended public endpoint is `https://mcp.molpha.io/mcp`. This repository change does **not** deploy it or assert that it is live. Use `http://127.0.0.1:8402/mcp` for local testing. The installed MCP SDK negotiates its supported protocol versions, currently through `2025-11-25`.

## Keyless by design

The hosted server never holds, receives or asks for a signing credential. A caller brings its own wallet, and the server asks that wallet for exactly two things:

1. **Sign a UTF-8 text message** — to sign in for subscription rounds.
2. **Sign a Solana v0 transaction without broadcasting it** — to pay for an x402 round, or to submit an attestation.

Every operation that needs a signature is therefore split into a step that prepares, a signature made by the caller's wallet, and a step that completes. `get_capabilities` reports this as `payment.signing: "caller"` and lists the steps.

| Operation | Tools, in order | What the wallet signs |
|---|---|---|
| Subscription round | `begin_session` → `complete_session` → `execute_subscription_round` | One text message, once per session |
| x402 pay-per-request round | `prepare_x402_round` → `execute_x402_round` | One USDC transfer transaction per round (not broadcast) |
| Solana attestation submit | `prepare_submit_attestation` → `send_signed_transaction` (or broadcast it yourself) | One `submit_attestation` transaction |

The remaining tools need no signature: `get_capabilities`, `derive_source_id`, `build_verifier_calldata`, `describe_feed`, `get_latest_value`, `describe_access`, `get_x402_status`, `list_providers`, `get_provider`, `quote_source_payment`. `describe_feed` and `get_latest_value` need an explicit `submitter`, and `get_x402_status` reports a balance only for a `payer` you name: the server has no wallet of its own to default to.

Requests that still carry the removed `X-Molpha-*` signer headers, or anything shaped like a wallet secret in any header, are refused with `400` before the request is read. Private API secrets (`encryptSecrets`) are refused too: they must not pass through a shared server. Run the local server for those (`npx -y @molpha/mcp`, see [integration.md](integration.md)), where a local keypair, Privy or Turnkey signer is still supported.

### Subscription rounds: sign in once

A step-by-step walkthrough, with a signing example and delegate setup, is in [integration.md](integration.md#4-sign-in-with-your-own-wallet-siwx).

`begin_session({ address, owner? })` returns a short Sign-In-With-Solana message (the x402 `sign-in-with-x` extension's format). It names the gateway, the program and the subscription owner, states that it moves no funds, and expires in about five minutes. The server checks that the gateway's challenge states exactly the configured gateway's terms before returning it. Sign `message` as UTF-8 text — no prefix, no envelope, no trailing newline. `solana sign-offchain-message` wraps the text in an envelope and will **not** verify.

`complete_session({ challenge, signature })` verifies the signature locally (base58, base64 or hex), exchanges it at the gateway, and returns a `sessionToken`. The gateway checks on chain that the signer is the subscription owner, or a delegate the owner added with `add_delegate`; a delegate passes the owner's address as `owner`. Use `describe_access` to see a wallet's role and limits first.

`execute_subscription_round({ sessionToken, apiConfig, signaturesRequired, chains })` runs the round.

What a session is, and is not:

- It identifies the caller and nothing more. The gateway re-reads the subscription and the delegate account from chain for every round, so removing a delegate (`remove_delegate`) or letting the subscription lapse ends access within seconds, whatever tokens exist. There is no on-chain pause; a delegate's `max_data_requests` limit is enforced by the gateway, per subscription term.
- It is short-lived (30 minutes by default, never past the subscription term), bound to one wallet and one gateway, and revocable at the gateway (`DELETE /v1/session`).
- The token passes through this server on each `execute_subscription_round` call. It is never stored, cached or logged here, and is sent only to a configured gateway endpoint. To keep it off this server entirely, call the gateway's `POST /v1/round/execute` directly with `Authorization: Bearer <token>`.
- Sessions require a gateway that has them enabled (`GET /v1/info` reports `sessionAuth: true`). Against one that does not, `begin_session` answers `sessions_unavailable`.

### x402 rounds: prepare, sign, execute

`prepare_x402_round({ apiConfig, signaturesRequired, payer, chains })` quotes the round and verifies the gateway's payment requirements against the server's own chain reads — `payTo` is the protocol treasury owner (the ProtocolConfig PDA, not the gateway), the asset is the protocol USDC mint, the amount is the protocol round price, and the memo is the request's commitment — then returns an unsigned USDC transfer, a `summary` of what it does, and a `challenge`. The gateway's facilitator is the fee payer; `payer` is the only signature the caller provides.

Sign `unsignedTransaction` with the payer's wallet and **do not broadcast it**: the facilitator co-signs and submits it. Then call `execute_x402_round({ challenge, signedTransaction })`. The signed transaction is accepted only if it is byte-for-byte the prepared one carrying the payer's valid signature.

- A prepared payment lives about a minute (its blockhash). After that `execute_x402_round` answers `payment_expired`: prepare again. Wallets that need human approval may need more than one attempt.
- A payment buys one round. Replaying the same challenge and transaction is refused by the gateway. That holds when the round failed after the gateway dispatched it, for example with a 503 because too few nodes accepted it: the payment is not settled, but it cannot be used again, so prepare a new one.
- Rounds run on a fixed 100 ms tick: requests for one feed (the same source and quorum) inside one tick share a round, a feed runs at most 10 rounds per second, and one wallet gets at most one round per tick for a feed. A request that lands in a tick where the wallet already has a round is answered with HTTP 409 before anything is reserved. `execute_x402_round` and `execute_subscription_round` repeat it once, one full tick later; an x402 round resends the same payment, which a 409 leaves unspent. A request refused again fails with `round_conflict`.
- The server builds the transaction the wallet signs. Check `summary` against your wallet's own view of the transaction, and set a wallet-side policy that allowlists the treasury token account and the USDC mint with a per-transaction cap. The per-round ceiling `MOLPHA_X402_MAX_PRICE_USDC` applies at both steps.

### Challenges

`challenge` values are opaque state the server hands back to itself through the caller, authenticated with HMAC-SHA256 under `MOLPHA_HTTP_CHALLENGE_SECRET`. Nothing in one is secret. Every instance of a deployment must share the secret, so there is no generated fallback: without it `prepare_x402_round`, `execute_x402_round`, `prepare_submit_attestation` and `send_signed_transaction` answer `missing_config`, and a malformed value fails startup. `send_signed_transaction` sends only a transaction the server prepared; it is not a general relay.

To rotate: set `MOLPHA_HTTP_CHALLENGE_SECRET_PREVIOUS` to the old value and `MOLPHA_HTTP_CHALLENGE_SECRET` to the new one, deploy, and remove the previous value a few minutes later. Challenges live at most 90 seconds.

### Error codes

| Code | Meaning | What to do |
|---|---|---|
| `payment_expired`, `transaction_expired` | The challenge or its blockhash lapsed | Call the prepare tool again and sign the new transaction |
| `signed_transaction_mismatch` | Not the prepared transaction, or not signed by its payer | Sign the prepared transaction unchanged; do not broadcast |
| `invalid_challenge` | Not issued by this deployment, or altered | Call the prepare tool again |
| `invalid_signature` | Not the address's signature over the exact message | Sign the message as returned, as raw UTF-8 |
| `sign_in_rejected` | The gateway refused the message (expired, already used) | Call `begin_session` again |
| `session_invalid` | The token is unknown, expired or revoked | Sign in again |
| `sessions_unavailable` | The gateway has sessions disabled | Use x402, or a gateway with sessions |
| `forbidden` | No active subscription, out of quota, or the delegate was removed | See `describe_access` |
| `round_conflict` | HTTP 409, after one retry: this wallet already has a round for this feed (the same source and quorum) in the current 100 ms tick. Nothing was reserved | Wait at least 100 ms and call again; it is a new round |
| `round_timeout` | HTTP 503: the gateway reached its own capacity limit (`gateway at capacity`; nothing was reserved), or too few nodes completed the round. Or the upstream timed out | Wait, then read state before retrying; a retry is a new round |
| `payment_outcome_unknown` | A payment was sent and the answer never arrived | Reconcile with `details` before paying again |
| `missing_config` | The deployment has no challenge secret | Operator: set `MOLPHA_HTTP_CHALLENGE_SECRET` |

| Policy | Public HTTP defaults | Local stdio |
|---|---|---|
| Signer | None: the caller's wallet signs | Local keypair, Privy or Turnkey |
| Source secrets via `encryptSecrets` | Refused | Supported |
| Source API auth headers | Allowed with a response warning | Keep private API work on infrastructure you control |
| Per-round x402 ceiling | `MOLPHA_X402_MAX_PRICE_USDC`, default 1 USDC | Same |
| Daily budgets | Disabled; set limits in the wallet's own policy | Daily caps |
| IP rate limit | Burst 60, refill 1/second, per instance | — |

## Client configuration

No headers, tokens or secrets are configured in the client: the URL is all there is.

Cursor:

```json
{
  "mcpServers": {
    "molpha": { "url": "http://127.0.0.1:8402/mcp" }
  }
}
```

Claude Code:

```sh
claude mcp add --transport http molpha http://127.0.0.1:8402/mcp
```

Claude Desktop, through `mcp-remote` (remove `--allow-http` and use HTTPS for a deployment), or use the local `.mcpb` bundle for stdio:

```json
{
  "mcpServers": {
    "molpha": { "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:8402/mcp", "--allow-http"] }
  }
}
```

These examples target the local server. Replace the URL with the public endpoint only after deployment. The agent also needs a wallet it can ask to sign: any wallet tool that can sign a UTF-8 message and sign a Solana v0 transaction without broadcasting it.

Plain Node `fetch`:

```js
const response = await fetch('http://127.0.0.1:8402/mcp', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-11-25'
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
| `MOLPHA_HTTP_HOST` | `127.0.0.1` | Listener address; container and Vercel set `0.0.0.0` |
| `MOLPHA_HTTP_PORT` | `8402` | `--port` takes precedence, then `MOLPHA_HTTP_PORT`, then `PORT` |
| `MOLPHA_HTTP_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1],mcp.molpha.io` | Exact hostnames, without ports. Vercel also merges `VERCEL_URL` / `VERCEL_BRANCH_URL` / `VERCEL_PROJECT_PRODUCTION_URL`. |
| `MOLPHA_HTTP_ALLOWED_ORIGINS` | Local HTTP origins at configured port, `https://mcp.molpha.io` | Exact origins; requests without Origin are accepted. Vercel also merges `https://` for each injected hostname. |
| `MOLPHA_HTTP_TRUSTED_PROXIES` | Empty | Exact immediate-proxy socket IPs, including IPv4-mapped form if applicable |
| `MOLPHA_HTTP_CHALLENGE_SECRET` | Unset | At least 32 random bytes, hex or base64, shared by every instance. Authenticates the `challenge` values the prepare tools hand out. Unset disables those tools; malformed fails startup. Generate with `openssl rand -hex 32`. |
| `MOLPHA_HTTP_CHALLENGE_SECRET_PREVIOUS` | Unset | The secret being rotated out: still verified, never used to seal |
| `MOLPHA_HTTP_DAILY_CAPS` | `false` | Enables existing **process-wide** daily limits, unsuitable for multi-tenant budgeting |
| `MOLPHA_HTTP_RATE_LIMIT` | `true` | Enables per-IP limit |
| `MOLPHA_HTTP_RATE_BURST` | `60` | Bucket capacity |
| `MOLPHA_HTTP_RATE_REFILL` | `1` | Tokens per second |

Server gateway/RPC configuration, verifier networks and `MOLPHA_X402_MAX_PRICE_USDC` retain their meanings. The hosted tools take no `dryRun`: the prepare steps are already previews that sign and spend nothing. `MOLPHA_HTTP_ALLOW_ENCRYPT_SECRETS` is no longer supported, and setting it to `true` fails startup. Bodies are capped at 256 KiB; headers at 16 KiB. Health checks bypass rate limiting. There are at most 10,000 rate buckets, with idle entries reclaimed when capacity is needed. Metrics and rate limits reset on restart.

Only trust a proxy that overwrites forwarding headers. The server accepts a single `CF-Connecting-IP` (preferred) or single `X-Forwarded-For` IP when the socket peer is explicitly trusted; comma-separated forwarding chains are not accepted. Do not expose an origin listener configured to trust arbitrary user-supplied forwarding headers.

Requests have a 90-second deadline. Disconnects and deadlines cancel the server's HTTP fetches to the gateway and stop later steps. The Molpha SDK does not universally support cancellation: an already-running chain read can finish after the client disconnects. No cancellation can reverse a payment, give back a subscription round, or undo a submitted transaction. Timeout responses conservatively warn against blind retries; x402 responses preserve public reconciliation identifiers when payment may have been sent. `SIGINT`/`SIGTERM` drain existing connections within the request deadline, then force-close remaining sockets.

Hosted capabilities expose only the RPC URL origin, omitting provider API keys in its path/query. Logs contain only tool name, status, latency, and a process-salted IP hash. Aggregate tool/status counters are emitted every minute and at shutdown. Header values, tool arguments (session tokens, signatures and signed transactions among them), and raw upstream errors are excluded. This application policy must also be enforced at the proxy, tracing, crash reporting, and log collector layers.

## Single-instance deployment runbook

1. Build and run locally:

   ```sh
   docker build -t molpha-mcp-http .
   docker run --rm --name molpha-mcp-http -p 127.0.0.1:8402:8402 \
     -e SOLANA_RPC=https://api.devnet.solana.com \
     molpha-mcp-http
   ```

   The image uses Node 24 and a non-root user. It includes the locked production dependency tree; the Privy and Turnkey signer SDKs are optional dependencies of the package and are pruned from the image (`npm prune --omit=dev --omit=optional`), since the hosted server signs nothing. Docker build context uses an allowlist and excludes local credentials, `.env`, `.git`, and `.mcpb` artifacts. Do not bake runtime secrets into an image.
2. Deploy one instance behind a TLS reverse proxy and Cloudflare, route `/mcp` and `/healthz`, and disable caching. No custom headers need to be forwarded. Keep all public hosted policy defaults. Set proxy/LB idle and response timeouts to at least 120 seconds and shutdown grace to at least 95 seconds. Do not automatically retry POSTs.
3. Restrict origin ingress to your proxy. Configure exact trusted proxy IPs and have the proxy overwrite the client-IP header. Keep local health-check hosts in the Host allowlist. Supply gateway authority pins if the gateway does not publish `/v1/info`. Set `MOLPHA_HTTP_CHALLENGE_SECRET` as a deployment secret.
4. Configure health-based process/container replacement and an external uptime monitor for `/healthz`. A Docker `HEALTHCHECK` alone marks unhealthy containers; the deployment platform must implement replacement. Alert on unavailable health, increased failures, and timeouts. Store only the safe application fields; disable header/body capture and verbose provider tracing throughout the path. Set operational log retention to 7 days.
5. Validate initialization and tools/list with MCP Inspector, feed reads and `prepare_x402_round` against devnet, then a round paid from a funded test wallet with a wallet-side spending policy in place. Check canary tests, origin restrictions, proxy timeouts, and forwarded-IP handling.
6. Only after the endpoint is verified live, add a `streamable-http` remote with URL `https://mcp.molpha.io/mcp` to `server.json` and refresh the registry metadata. This implementation deliberately leaves that metadata unchanged.

Scale-out needs a shared rate limiter and revised operational limits; the challenge secret is already shared configuration, so prepare and execute may land on different instances. No durable tenant budgets, OAuth wrapper, treasury tools, or demo signer are included.

## Tests

`npm test`, `npm run typecheck`, and `npm run build` cover the regular suite. HTTP tests start loopback servers and mock upstream services; they require no funded wallet. Canary tests capture request logs and scan for credential and argument markers, including error paths.

Live devnet tests are skipped unless `MOLPHA_HTTP_DEVNET_TEST=true`. Set `MOLPHA_HTTP_TEST_API_CONFIG` to a deterministic public API config JSON and optionally `MOLPHA_HTTP_TEST_QUORUM` (default 2). This runs discovery and, when `MOLPHA_HTTP_TEST_PAYER` names a devnet wallet holding USDC, `prepare_x402_round` for it: a verified quote and an unsigned transaction, with nothing signed or spent. The test holds no key, loads no `.env` or keypair file, and needs `MOLPHA_HTTP_CHALLENGE_SECRET` for the prepare step.
