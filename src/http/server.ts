import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRequestContext, getSharedRuntime, type RequestContext, type RequestLifecycle, type SharedRuntime } from "../clients.js";
import { registerTools } from "../tools/index.js";
import { normalizeError } from "../errors.js";
import { HttpInputError, parseSignerHeaders, signerFromSpec, type SignerSpec } from "./signers.js";
import { hostedToolServer, record, safeError, safeReconciliation, type HostedTool } from "./policy.js";
import { serverVersion } from "../version.js";

export interface HttpConfig {
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  trustedProxies: string[];
  allowEncryptSecrets: boolean;
  rateLimit: boolean;
  burst: number;
  refillPerSecond: number;
  bodyLimit: number;
  timeoutMs: number;
}

function positive(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) throw new Error("Invalid positive HTTP configuration value");
  return Number(value);
}
function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value !== "true" && value !== "false") throw new Error("HTTP boolean configuration must be true or false");
  return value === "true";
}
const list = (value: string | undefined, fallback: string[]) => value === undefined ? fallback : value.split(",").map(item => item.trim()).filter(Boolean);
const unique = (values: string[]) => [...new Set(values)];

function hostnameFromPlatformUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return undefined;
  }
}

/** Deployment hostnames Vercel injects; merged into Host/Origin allowlists. */
export function vercelPublicHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return unique(
    [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]
      .map(hostnameFromPlatformUrl)
      .filter((value): value is string => Boolean(value))
  );
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env, portOverride?: number): HttpConfig {
  const port = portOverride ?? positive(env.MOLPHA_HTTP_PORT || env.PORT, 8402);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("HTTP port must be between 1 and 65535");
  const vercelHosts = vercelPublicHosts(env);
  return {
    host: env.MOLPHA_HTTP_HOST ?? (env.VERCEL === "1" ? "0.0.0.0" : "127.0.0.1"), port,
    allowedHosts: unique([...list(env.MOLPHA_HTTP_ALLOWED_HOSTS, ["localhost", "127.0.0.1", "[::1]", "mcp.molpha.io"]), ...vercelHosts]),
    allowedOrigins: unique([...list(env.MOLPHA_HTTP_ALLOWED_ORIGINS, [`http://localhost:${port}`, `http://127.0.0.1:${port}`, "https://mcp.molpha.io"]), ...vercelHosts.map(host => `https://${host}`)]),
    trustedProxies: list(env.MOLPHA_HTTP_TRUSTED_PROXIES, []),
    allowEncryptSecrets: bool(env.MOLPHA_HTTP_ALLOW_ENCRYPT_SECRETS, false),
    rateLimit: bool(env.MOLPHA_HTTP_RATE_LIMIT, true),
    burst: positive(env.MOLPHA_HTTP_RATE_BURST, 60),
    refillPerSecond: positive(env.MOLPHA_HTTP_RATE_REFILL, 1),
    bodyLimit: 256 * 1024, timeoutMs: 90_000
  };
}

/** Bounded per-process limiter. Never evict an active bucket to admit new IPs. */
export class IpLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private burst: number, private refill: number, private maxEntries = 10_000) {}
  take(ip: string, now = Date.now()): boolean {
    let bucket = this.buckets.get(ip);
    if (!bucket) {
      if (this.buckets.size >= this.maxEntries) {
        for (const [key, entry] of this.buckets) if (now - entry.at >= Math.max(300_000, this.burst / this.refill * 1000)) this.buckets.delete(key);
        if (this.buckets.size >= this.maxEntries) return false;
      }
      bucket = { tokens: this.burst, at: now };
      this.buckets.set(ip, bucket);
    }
    bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.at) / 1000 * this.refill);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

function clientIp(req: IncomingMessage, config: HttpConfig): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  if (!config.trustedProxies.includes(peer)) return peer;
  // Trust only a single canonical value supplied/overwritten by the immediate proxy.
  const forwarded = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"];
  return typeof forwarded === "string" && isIP(forwarded.trim()) ? forwarded.trim() : peer;
}

function validateOrigin(req: IncomingMessage, config: HttpConfig): void {
  const host = req.headers.host;
  let hostname: string;
  try {
    if (!host || /[\s/@\\?#]/.test(host)) throw new Error();
    hostname = new URL(`http://${host}`).hostname;
  } catch { throw new HttpInputError(403, "Host is not allowed."); }
  if (!config.allowedHosts.includes(hostname)) throw new HttpInputError(403, "Host is not allowed.");
  if (req.headers.origin !== undefined && (typeof req.headers.origin !== "string" || !config.allowedOrigins.includes(req.headers.origin))) {
    throw new HttpInputError(403, "Origin is not allowed.");
  }
}

async function readBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<unknown> {
  if (Number(req.headers["content-length"]) > limit) throw new HttpInputError(413, "Request body exceeds 256 KiB.");
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", data); req.off("end", end); req.off("error", fail); req.off("aborted", aborted);
      signal.removeEventListener("abort", aborted);
    };
    const fail = (error: Error) => { cleanup(); chunks = []; reject(error); };
    const aborted = () => fail(new Error("Request cancelled"));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { req.pause(); fail(new HttpInputError(413, "Request body exceeds 256 KiB.")); }
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); const body = Buffer.concat(chunks); chunks = []; resolve(body); };
    req.on("data", data); req.once("end", end); req.once("error", fail); req.once("aborted", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
  signal.throwIfAborted();
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new HttpInputError(400, "Request must contain valid JSON."); }
}

function sendError(res: ServerResponse, status: number, message: string, id: unknown = null, data?: Record<string, unknown>): void {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: typeof id === "string" || typeof id === "number" ? id : null,
    error: { code: status === 400 ? -32600 : -32000, message, ...(data ? { data } : {}) } }));
}

export interface HostedServerOptions {
  config?: HttpConfig;
  runtime?: SharedRuntime;
  /** Injectable for deterministic tests; production always uses per-request managed signers. */
  contextFactory?: (runtime: SharedRuntime, spec: SignerSpec | undefined, lifecycle: RequestLifecycle) => Promise<RequestContext> | RequestContext;
  log?: (entry: Record<string, unknown>) => void;
}

export function createHostedHttpServer(options: HostedServerOptions = {}) {
  const config = options.config ?? loadHttpConfig();
  const runtime = options.runtime ?? getSharedRuntime();
  const log = options.log ?? (entry => process.stderr.write(`${JSON.stringify(entry)}\n`));
  const limiter = new IpLimiter(config.burst, config.refillPerSecond);
  const salt = randomBytes(32);
  const metrics = new Map<string, number>();
  const active = new Set<AbortController>();
  let stopping = false;
  const metricTimer = setInterval(() => {
    if (metrics.size) { log({ metrics: Object.fromEntries(metrics) }); metrics.clear(); }
  }, 60_000);
  metricTimer.unref();

  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: config.timeoutMs, headersTimeout: Math.min(30_000, config.timeoutMs) }, async (req, res) => {
    res.setHeader("cache-control", "no-store");
    const started = Date.now();
    const controller = new AbortController();
    const lifecycle: RequestLifecycle = { signal: controller.signal };
    let mcp: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    let id: unknown;
    let toolName = "none";
    let tier = "unsigned";
    let outcome = "ok";
    const ipHash = createHmac("sha256", salt).update(clientIp(req, config)).digest("hex").slice(0, 24);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      controller.abort();
      active.delete(controller);
      void transport?.close().catch(() => {});
      void mcp?.close().catch(() => {});
      if (req.url !== "/healthz") {
        const status = res.statusCode >= 400 ? String(res.statusCode) : outcome;
        log({ tool: toolName, tier, status, latencyMs: Date.now() - started, ipHash });
        const key = `${toolName}/${tier}/${status}`;
        metrics.set(key, (metrics.get(key) ?? 0) + 1);
      }
    };
    const timer = setTimeout(() => {
      outcome = "timeout";
      sendError(res, 504, lifecycle.effectStarted
        ? "Operation timed out after a write may have started. Reconcile before retrying."
        : "Request timed out.", id, lifecycle.reconciliation ? { code: "payment_outcome_unknown", details: safeReconciliation(lifecycle.reconciliation) } : undefined);
      controller.abort();
      // Stop slow request bodies without retaining request-scoped state.
      req.resume();
      cleanup();
    }, config.timeoutMs);
    timer.unref();
    active.add(controller);
    res.once("finish", cleanup);
    res.once("close", () => { if (!res.writableEnded) outcome = "cancelled"; cleanup(); });
    try {
      validateOrigin(req, config);
      if (req.url === "/healthz" && req.method === "GET") {
        res.writeHead(stopping ? 503 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: stopping ? "stopping" : "ok" }));
        return;
      }
      if (stopping) throw new HttpInputError(503, "Server is shutting down.");
      if (req.url !== "/mcp") throw new HttpInputError(404, "Not found.");
      if (req.method !== "POST") { res.setHeader("allow", "POST"); throw new HttpInputError(405, "Method not allowed."); }
      if (config.rateLimit && !limiter.take(ipHash)) {
        res.setHeader("retry-after", String(Math.ceil(1 / config.refillPerSecond)));
        throw new HttpInputError(429, "Rate limit exceeded.");
      }
      const spec = parseSignerHeaders(req.rawHeaders);
      tier = spec?.backend ?? "unsigned";
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) throw new HttpInputError(415, "Content-Type must be application/json.");
      const body = await readBody(req, config.bodyLimit, controller.signal);
      const message = record(body);
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") throw new HttpInputError(400, "Invalid JSON-RPC request.");
      id = message.id;
      const params = record(message.params);
      const args = record(params?.arguments) ?? {};
      if (!config.allowEncryptSecrets && Object.hasOwn(args, "encryptSecrets")) throw new HttpInputError(400, "encryptSecrets is disabled on hosted HTTP. Use npx @molpha/mcp locally or explicitly configure a private self-hosted server.");
      mcp = new McpServer({ name: "molpha-mcp", version: serverVersion });
      const catalog = new Map<string, HostedTool>();
      let context: Promise<RequestContext> | undefined;
      const getContext = () => context ??= Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return options.contextFactory ? options.contextFactory(runtime, spec, lifecycle)
          : createRequestContext(runtime, signerFromSpec(spec), lifecycle);
      });
      registerTools(hostedToolServer(mcp, catalog, (_name, result) => { outcome = result.isError ? "error" : "ok"; }, lifecycle), { getContext, config: runtime.config });
      if (message.method === "tools/call") {
        const tool = typeof params?.name === "string" ? catalog.get(params.name) : undefined;
        if (!tool) throw new HttpInputError(400, "Unknown tool.");
        toolName = params!.name as string;
        if (!tool.schema.safeParse(params?.arguments ?? {}).success) throw new HttpInputError(400, "Invalid tool arguments. Check the tool input schema.");
      }
      controller.signal.throwIfAborted();
      transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      // SDK 1.x optional callback declarations conflict with exactOptionalPropertyTypes.
      await mcp.connect(transport as Transport);
      controller.signal.throwIfAborted();
      await transport.handleRequest(req, res, body);
    } catch (error) {
      outcome = "error";
      if (error instanceof HttpInputError) sendError(res, error.status, error.message, id);
      else sendError(res, 500, "Request failed.", id, safeError(normalizeError(error)));
      req.resume();
      if (res.writableEnded || res.destroyed) cleanup();
    }
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  return { server, config, async close(): Promise<void> {
    stopping = true;
    clearInterval(metricTimer);
    const timer = setTimeout(() => { for (const controller of active) controller.abort(); server.closeAllConnections(); }, config.timeoutMs + 1000);
    timer.unref();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    clearTimeout(timer);
    if (metrics.size) log({ metrics: Object.fromEntries(metrics) });
  } };
}
