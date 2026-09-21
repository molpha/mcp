import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { request } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { address } from "@solana/kit";
import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedHttpServer, loadHttpConfig, type HostedServerOptions } from "../../src/http/server.js";
import { getSharedRuntime, createRequestContext, type RequestContext } from "../../src/clients.js";
import { sanitizeToolResult } from "../../src/http/policy.js";
import { MemorySigner } from "../../src/signer/backends/memory.js";
import { fetchX402Status, quoteX402Round } from "../../src/x402.js";

vi.mock("../../src/x402.js", async original => ({
  ...await original<typeof import("../../src/x402.js")>(),
  fetchX402Status: vi.fn(async () => ({ endpoint: "https://gateway.test", status: { gateway: "g", authority: "a", ataAddress: "ata", ataExists: true, ataBalance: "100", committedAmount: "0", quotedNextPrice: "1", unsettledRounds: 0 } })),
  quoteX402Round: vi.fn(async () => ({ payment: "x402", dryRun: true, quoteOnly: true, paymentRequired: { x402Version: 2, accepts: [{}] }, note: "Unsigned quote" }))
}));
const flatResult = { sourceId: "1".repeat(64), value: "42", valuePacked: "2".repeat(64), timestamp: 1714300000, registryVersion: 7, signaturesRequired: 1, signersBitmap: "4", s: "3".repeat(64), commitmentAddr: "4".repeat(40), fresh: true };
const apiConfig = { url: "https://example.com/finalized", responseParser: "$.value" };
const walletA = Keypair.generate().publicKey.toBase58();
const walletB = Keypair.generate().publicKey.toBase58();
const canary = "CANARY_NEVER_LOG_882197";
function signerHeaders(wallet = walletA) {
  return { "X-Molpha-Signer": "privy", "X-Molpha-Privy-App-Id": canary + "app", "X-Molpha-Privy-App-Secret": canary + "secret", "X-Molpha-Privy-Wallet-Id": canary + "wallet", "X-Molpha-Privy-Wallet-Address": wallet };
}
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); vi.clearAllMocks(); });

async function start(overrides: HostedServerOptions = {}) {
  const logs: Record<string, unknown>[] = [];
  const contexts: RequestContext[] = [];
  const hosted = createHostedHttpServer({
    config: { ...loadHttpConfig({}), port: 0 }, runtime: getSharedRuntime({ SOLANA_RPC: "http://localhost:8899" }), log: entry => logs.push(entry),
    contextFactory(runtime, spec, lifecycle) {
      const ctx: RequestContext = {
        ...runtime, lifecycle, hosted: true,
        ...(spec ? { signer: { publicKey: address(spec.config.address), isAvailable: async () => true,
          signMessage: vi.fn(async () => new Uint8Array(64)), signTransaction: vi.fn(async tx => tx), signAllTransactions: vi.fn(async txs => txs) } } : {}),
        gateway: { getNodes: vi.fn(async () => []), requestSignedData: vi.fn(async () => flatResult) },
        solana: { getRegistryVersion: vi.fn(async () => 7), readFeed: vi.fn(async () => null), readSubscription: vi.fn(async () => null),
          submitAttestation: vi.fn(async () => ({ signature: "tx", feed: spec?.config.address })) }
      };
      contexts.push(ctx); return ctx;
    }, ...overrides
  });
  hosted.server.listen(0, "127.0.0.1");
  await once(hosted.server, "listening");
  closes.push(() => hosted.close());
  const base = `http://127.0.0.1:${(hosted.server.address() as AddressInfo).port}`;
  async function rpc(method: string, params: unknown = {}, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = await response.json() as any;
    return { response, body };
  }
  const call = (name: string, args: unknown = {}, headers: Record<string, string> = {}) => rpc("tools/call", { name, arguments: args }, headers);
  return { ...hosted, base, rpc, call, logs, contexts };
}

describe("stateless HTTP", () => {
  it("interoperates with the SDK Streamable HTTP client across independent POSTs", async () => {
    const app = await start();
    const client = new Client({ name: "hosted-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${app.base}/mcp`));
    try {
      await client.connect(transport as Transport);
      expect((await client.listTools()).tools).toHaveLength(9);
      const result = await client.callTool({ name: "derive_source_id", arguments: { apiConfig } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toHaveProperty("sourceId");
    } finally { await client.close(); }
  });
  it("initializes, lists all tools, and handles notification without a session or signer", async () => {
    const app = await start();
    const init = await app.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.response.status).toBe(200);
    expect(init.response.headers.get("mcp-session-id")).toBeNull();
    expect((await app.rpc("tools/list")).body.result.tools).toHaveLength(9);
    expect(app.contexts).toHaveLength(0);
    const notified = await fetch(`${app.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(notified.status).toBe(202);
  });
  it("serves health and rejects unsupported methods/routes, malformed JSON, host, origin, and oversized bodies", async () => {
    const app = await start();
    expect((await fetch(`${app.base}/healthz`)).status).toBe(200);
    for (const method of ["GET", "DELETE"]) expect((await fetch(`${app.base}/mcp`, { method })).status).toBe(405);
    expect((await fetch(`${app.base}/other`)).status).toBe(404);
    expect((await app.rpc("tools/list", {}, { origin: "https://evil.test" })).response.status).toBe(403);
    // Fetch rewrites Host, so exercise Host validation through Node's raw client.
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${app.base}/mcp`, { headers: { host: "evil.test" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    expect(hostStatus).toBe(403);
    expect((await fetch(`${app.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "bad" })).status).toBe(400);
    expect((await fetch(`${app.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(256 * 1024 + 1) })).status).toBe(413);
  });
  it("rejects encryptSecrets before schema stripping and does not echo invalid argument values", async () => {
    const app = await start();
    const encrypted = await app.call("derive_source_id", { apiConfig, encryptSecrets: { key: canary } });
    expect(encrypted.response.status).toBe(400);
    expect(encrypted.body.error.message).toContain("encryptSecrets");
    const invalid = await app.call("derive_source_id", { apiConfig: { ...apiConfig, method: canary } });
    expect(invalid.response.status).toBe(400);
    expect(JSON.stringify(invalid.body)).not.toContain(canary);
    expect(app.contexts).toHaveLength(0);
  });
  it("allows an explicit private-server encryptSecrets override", async () => {
    const app = await start({ config: { ...loadHttpConfig({ MOLPHA_HTTP_ALLOW_ENCRYPT_SECRETS: "true" }), port: 0 } });
    const result = await app.call("execute_subscription_round", { apiConfig, chains: ["solana"], encryptSecrets: { key: "secret" } }, signerHeaders());
    expect(result.body.result.isError).not.toBe(true);
    expect(app.contexts[0]!.gateway.requestSignedData).toHaveBeenCalledWith(expect.objectContaining({ encrypt: { secrets: { key: "secret" } } }));
  });
  it("enforces rate limits using socket IP, ignores forged forwarding, and exempts health", async () => {
    const app = await start({ config: { ...loadHttpConfig({}), burst: 1, port: 0 } });
    expect((await app.rpc("tools/list")).response.status).toBe(200);
    expect((await app.rpc("tools/list", {}, { "x-forwarded-for": "1.2.3.4" })).response.status).toBe(429);
    expect((await fetch(`${app.base}/healthz`)).status).toBe(200);
  });
  it("accepts an overwritten single IP only from an explicit trusted proxy", async () => {
    const app = await start({ config: { ...loadHttpConfig({}), trustedProxies: ["127.0.0.1"], burst: 1, port: 0 } });
    expect((await app.rpc("tools/list", {}, { "cf-connecting-ip": "1.2.3.4" })).response.status).toBe(200);
    expect((await app.rpc("tools/list", {}, { "cf-connecting-ip": "1.2.3.5" })).response.status).toBe(200);
    expect((await app.rpc("tools/list", {}, { "cf-connecting-ip": "1.2.3.4" })).response.status).toBe(429);
  });
});

describe("tier behavior and isolation", () => {
  it("runs unsigned capabilities, derivation, and verifier calldata", async () => {
    const app = await start();
    const caps = (await app.call("get_capabilities")).body.result.structuredContent;
    expect(caps.registryVersion).toBe(7);
    expect(caps.payment.x402Caps.dailyCapsEnabled).toBe(false);
    expect(caps.payment.x402Caps.maxSpendPerDayUsdcAtomic).toBeUndefined();
    const derived = (await app.call("derive_source_id", { apiConfig })).body.result.structuredContent;
    expect(derived.sourceId).toMatch(/^[0-9a-fx]{64,66}$/);
    const artifact = (await app.call("execute_subscription_round", { apiConfig, chains: ["evm"] }, signerHeaders())).body.result.structuredContent;
    expect((await app.call("build_verifier_calldata", { dataUpdate: artifact.dataUpdate, signature: artifact.signature, chain: "evm" })).body.result.structuredContent.chain).toBe("evm");
  });
  it.each(["describe_feed", "get_latest_value"])("%s requires unsigned submitter and omits signer subscription", async name => {
    const app = await start();
    const args = { sourceId: flatResult.sourceId, signaturesRequired: 1 };
    expect((await app.call(name, args)).body.result.content[0].text).toContain("submitter_required");
    const result = (await app.call(name, { ...args, submitter: walletA })).body.result.structuredContent;
    expect(result).toMatchObject({ submitter: walletA, feed: null });
    expect(result.subscription).toBeUndefined();
  });
  it("unsigned x402 status omits payer and daily budgets, and execution only quotes", async () => {
    const app = await start();
    const status = (await app.call("get_x402_status")).body.result.structuredContent;
    expect(status.gatewayFloat).toBeDefined();
    expect(status.payer).toBeUndefined();
    expect(status.caps.dailyCapsEnabled).toBe(false);
    expect(fetchX402Status).toHaveBeenCalled();
    expect((await app.call("execute_x402_round", { apiConfig, chains: ["solana"] })).body.result.structuredContent.quoteOnly).toBe(true);
    expect(quoteX402Round).toHaveBeenCalledWith(expect.not.objectContaining({ signer: expect.anything() }), expect.anything());
  });
  it.each(["execute_subscription_round", "submit_attestation"])("%s requires auth even for previews", async name => {
    const app = await start();
    const args = name === "submit_attestation" ? { result: flatResult, dryRun: true } : { apiConfig, chains: ["solana"], dryRun: true };
    expect((await app.call(name, args)).body.result.content[0].text).toContain("authentication_required");
  });
  it("isolates concurrent signers, propagates autoSubmit, then serves an unsigned request", async () => {
    const app = await start();
    const results = await Promise.all([walletA, walletB].map(wallet => app.call("execute_subscription_round", { apiConfig, chains: ["solana"], autoSubmit: true }, signerHeaders(wallet))));
    expect(results.map(r => r.body.result.structuredContent.submitted.submitter)).toEqual([walletA, walletB]);
    const reads = await Promise.all([walletA, walletB].map(wallet => app.call("get_latest_value", { sourceId: flatResult.sourceId, signaturesRequired: 1 }, signerHeaders(wallet))));
    expect(reads.map(r => r.body.result.structuredContent.submitter)).toEqual([walletA, walletB]);
    const unsigned = await app.call("get_latest_value", { sourceId: flatResult.sourceId, signaturesRequired: 1 });
    expect(unsigned.body.result.content[0].text).toContain("submitter_required");
    expect(app.contexts.at(-1)?.signer).toBeUndefined();
    expect(JSON.stringify(app.logs)).not.toContain(canary);
    expect(JSON.stringify(app.logs)).not.toContain(walletA);
  });
  it("warns on source API credentials without logging arguments", async () => {
    const app = await start();
    const result = await app.call("derive_source_id", { apiConfig: { ...apiConfig, headers: { Authorization: canary } } });
    expect(result.body.result.structuredContent.warnings[0]).toContain("self-hosted");
    expect(JSON.stringify(app.logs)).not.toContain(canary);
  });
});

describe("privacy and lifecycle", () => {
  it("sanitizes thrown, nested, subscription, and schema mismatch errors", async () => {
    const runtime = getSharedRuntime({});
    const app = await start({ contextFactory: (_runtime, _spec, lifecycle) => ({ ...runtime, hosted: true, lifecycle,
      gateway: { getNodes: async () => { throw new Error(canary); } },
      solana: { getRegistryVersion: async () => { throw new Error(canary); }, readFeed: async () => { throw new Error(canary); } } }) });
    for (const [tool, args] of [["get_capabilities", {}], ["get_latest_value", { sourceId: flatResult.sourceId, signaturesRequired: 1, submitter: walletA }]] as const) {
      expect(JSON.stringify((await app.call(tool, args, signerHeaders())).body)).not.toContain(canary);
    }
    const mismatch = sanitizeToolResult({ isError: true, content: [{ type: "text", text: canary }, { type: "text", text: JSON.stringify({ code: "output_schema_mismatch", message: canary }) }] });
    expect(JSON.stringify(mismatch)).not.toContain(canary);
    const metadata = sanitizeToolResult({ content: [], structuredContent: { verifiers: { starknet: [{ network: "test", error: canary }] } } });
    expect(JSON.stringify(metadata)).not.toContain(canary);
    expect(JSON.stringify(app.logs)).not.toContain(canary);
  });
  it("stops at the deadline and blocks a later autoSubmit", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const submit = vi.fn(async () => ({ signature: "tx", feed: walletA }));
    const runtime = getSharedRuntime({});
    const signer = await MemorySigner.fromSecretKey(Keypair.generate().secretKey);
    const app = await start({ config: { ...loadHttpConfig({}), timeoutMs: 80, port: 0 }, contextFactory: (_runtime, _spec, lifecycle) => ({
      ...createRequestContext(runtime, signer, lifecycle),
      gateway: { requestSignedData: async () => { await pending; return flatResult; } }, solana: { submitAttestation: submit }
    }) });
    const result = await app.call("execute_subscription_round", { apiConfig, chains: ["solana"], autoSubmit: true }, signerHeaders());
    expect(result.response.status).toBe(504);
    expect(result.body.error.message).toContain("Reconcile");
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(submit).not.toHaveBeenCalled();
  });
  it("guards signer methods after cancellation", async () => {
    const controller = new AbortController();
    const signer = await MemorySigner.fromSecretKey(Keypair.generate().secretKey);
    const call = vi.spyOn(signer, "signMessage");
    const context = createRequestContext(getSharedRuntime({}), signer, { signal: controller.signal });
    controller.abort();
    await expect(context.signer!.signMessage(new Uint8Array(1))).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
});


it("captures all process log channels without credential or argument canaries", async () => {
  const output: string[] = [];
  const capture = (...args: unknown[]) => { output.push(args.map(String).join(" ")); };
  const spies = [vi.spyOn(console, "log").mockImplementation(capture), vi.spyOn(console, "warn").mockImplementation(capture),
    vi.spyOn(console, "error").mockImplementation(capture),
    vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; }),
    vi.spyOn(process.stderr, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; })];
  try {
    const runtime = getSharedRuntime({});
    const signer = await MemorySigner.fromSecretKey(Keypair.generate().secretKey);
    const app = await start({ log: entry => { process.stderr.write(JSON.stringify(entry)); }, contextFactory: (_runtime, _spec, lifecycle) => ({
      ...createRequestContext(runtime, signer, lifecycle),
      gateway: { getNodes: async () => { throw new Error(canary); }, requestSignedData: async () => { throw Object.assign(new Error(canary), { status: 401 }); } },
      solana: { getRegistryVersion: async () => 1, readFeed: async () => null, readSubscription: async () => { throw new Error(canary); } }
    }) });
    const results = await Promise.all([
      app.call("get_capabilities", {}, signerHeaders()),
      app.call("describe_feed", { sourceId: flatResult.sourceId, signaturesRequired: 1 }, signerHeaders()),
      app.call("execute_subscription_round", { apiConfig: { ...apiConfig, headers: { Authorization: canary } }, chains: ["solana"] }, signerHeaders())
    ]);
    expect(JSON.stringify(results.map(result => result.body))).not.toContain(canary);
    await Promise.all(closes.splice(0).map(close => close()));
    expect(output.join("\n")).not.toContain(canary);
    expect(output.join("\n")).toContain("metrics");
  } finally { spies.forEach(spy => spy.mockRestore()); }
});

it("drains an in-flight request on graceful shutdown", async () => {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const runtime = getSharedRuntime({});
  const app = await start({ contextFactory: (_runtime, _spec, lifecycle) => ({ ...runtime, lifecycle, hosted: true,
    gateway: { getNodes: async () => { entered(); await pending; return []; } },
    solana: { getRegistryVersion: async () => 7 } }) });
  const response = app.call("get_capabilities");
  await ready;
  const close = closes.pop()!();
  release();
  expect((await response).body.result.structuredContent.registryVersion).toBe(7);
  await close;
  expect(app.server.listening).toBe(false);
});

it("cancels disconnected requests and prevents subsequent autoSubmit", async () => {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const submit = vi.fn(async () => ({ signature: "tx", feed: walletA }));
  const runtime = getSharedRuntime({});
  const signer = await MemorySigner.fromSecretKey(Keypair.generate().secretKey);
  let lifecycleSignal: AbortSignal | undefined;
  const app = await start({ contextFactory: (_runtime, _spec, lifecycle) => {
    lifecycleSignal = lifecycle.signal;
    return { ...createRequestContext(runtime, signer, lifecycle),
      gateway: { requestSignedData: async () => { entered(); await pending; return flatResult; } },
      solana: { submitAttestation: submit } };
  } });
  const controller = new AbortController();
  const response = fetch(`${app.base}/mcp`, { method: "POST", signal: controller.signal,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...signerHeaders() },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_subscription_round", arguments: { apiConfig, chains: ["solana"], autoSubmit: true } } }) });
  const rejected = expect(response).rejects.toThrow();
  await ready;
  controller.abort();
  await rejected;
  await vi.waitFor(() => expect(lifecycleSignal?.aborted).toBe(true));
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(submit).not.toHaveBeenCalled();
  expect(app.logs.some(log => log.status === "cancelled")).toBe(true);
});

it("returns 413 for oversized chunked bodies rather than destroying the response socket", async () => {
  const app = await start();
  const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = request(`${app.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.write("x".repeat(128 * 1024));
    req.write("x".repeat(128 * 1024));
    req.end("x");
  });
  expect(result.status).toBe(413);
  expect(JSON.parse(result.body).error.message).toContain("256 KiB");
});


it("keeps public payment reconciliation on a post-payment schema failure", () => {
  const controller = new AbortController();
  const result = sanitizeToolResult({ isError: true, content: [
    { type: "text", text: canary },
    { type: "text", text: JSON.stringify({ code: "output_schema_mismatch", message: canary }) }
  ] }, { signal: controller.signal, reconciliation: { payer: walletA, payTo: walletB,
    memo: "a".repeat(64), sourceId: "b".repeat(64), amountAtomicUsdc: "10", gatewayMessage: canary } });
  const error = JSON.parse(result.content[0]!.text);
  expect(error).toMatchObject({ code: "payment_outcome_unknown", details: { payer: walletA, memo: "a".repeat(64), amountAtomicUsdc: "10" } });
  expect(JSON.stringify(result)).not.toContain(canary);
});

it("does not expose hosted RPC API keys through capabilities", async () => {
  const app = await start({ runtime: getSharedRuntime({ SOLANA_RPC: `https://rpc.example/${canary}?api-key=${canary}` }) });
  const result = await app.call("get_capabilities");
  expect(result.body.result.structuredContent.solanaRpc).toBe("https://rpc.example");
  expect(JSON.stringify(result.body)).not.toContain(canary);
});
