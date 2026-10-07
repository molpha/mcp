import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { request } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedHttpServer, loadHttpConfig, type HostedServerOptions } from "../../src/http/server.js";
import { toDataUpdateArtifact } from "../../src/artifacts.js";
import { sealChallenge } from "../../src/challenge.js";
import { getSharedRuntime, type RequestContext } from "../../src/clients.js";
import { sanitizeToolResult } from "../../src/http/policy.js";
import { executePreparedX402Round, fetchX402Status } from "../../src/x402.js";

vi.mock("../../src/x402.js", async original => ({
  ...await original<typeof import("../../src/x402.js")>(),
  fetchX402Status: vi.fn(async () => ({ endpoint: "https://gateway.test", status: { gateway: "g", authority: "a", payTo: "t", treasuryAta: "ata", quotedNextPrice: "1", pendingTickets: 0 } })),
  executePreparedX402Round: vi.fn()
}));
const flatResult = { sourceId: "1".repeat(64), value: "42", valuePacked: "2".repeat(64), timestamp: 1714300000, registryVersion: 7, signaturesRequired: 1, signersBitmap: "4", s: "3".repeat(64), commitmentAddr: "4".repeat(40), fresh: true };
const apiConfig = { url: "https://example.com/finalized", responseParser: "$.value" };
const walletA = Keypair.generate().publicKey.toBase58();
const walletB = Keypair.generate().publicKey.toBase58();
const canary = "CANARY_NEVER_LOG_882197";
const HOSTED_TOOLS = 14;
/** What a client configured for the removed per-request signer scheme still sends. */
function legacySignerHeaders(wallet = walletA) {
  return { "X-Molpha-Signer": "privy", "X-Molpha-Privy-App-Id": canary + "app", "X-Molpha-Privy-App-Secret": canary + "secret", "X-Molpha-Privy-Wallet-Id": canary + "wallet", "X-Molpha-Privy-Wallet-Address": wallet };
}
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); vi.clearAllMocks(); });

async function start(overrides: HostedServerOptions = {}) {
  const logs: Record<string, unknown>[] = [];
  const contexts: RequestContext[] = [];
  const hosted = createHostedHttpServer({
    config: { ...loadHttpConfig({}), port: 0 }, runtime: getSharedRuntime({ SOLANA_RPC: "http://localhost:8899" }), log: entry => logs.push(entry),
    contextFactory(runtime, lifecycle) {
      const ctx: RequestContext = {
        ...runtime, lifecycle, hosted: true,
        gateway: { getNodes: vi.fn(async () => []) },
        solana: { getRegistryVersion: vi.fn(async () => 7), readFeed: vi.fn(async () => null), readSubscription: vi.fn(async () => null) }
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
      expect((await client.listTools()).tools).toHaveLength(HOSTED_TOOLS);
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
    expect((await app.rpc("tools/list")).body.result.tools).toHaveLength(HOSTED_TOOLS);
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
  it("refuses the old signer headers and wallet secrets before reading the request, and logs none of it", async () => {
    const app = await start();
    for (const headers of [legacySignerHeaders(), { "X-Molpha-Signer": "turnkey" }, { "X-Api-Key": JSON.stringify(Array(64).fill(7)) }]) {
      const refused = await app.call("get_capabilities", {}, headers);
      expect(refused.response.status).toBe(400);
      expect(refused.body.error.message).toMatch(/no longer accepted|Wallet secret/);
      expect(JSON.stringify(refused.body)).not.toContain(canary);
    }
    expect(app.contexts).toHaveLength(0);
    expect(JSON.stringify(app.logs)).not.toContain(canary);
    expect(JSON.stringify(app.logs)).not.toContain(walletA);
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
  it("runs capabilities, derivation, and verifier calldata with no credentials at all", async () => {
    const app = await start();
    const caps = (await app.call("get_capabilities")).body.result.structuredContent;
    expect(caps.registryVersion).toBe(7);
    expect(caps.payment.x402Caps.dailyCapsEnabled).toBe(false);
    expect(caps.payment.x402Caps.maxSpendPerDayUsdcAtomic).toBeUndefined();
    // The server says it holds no signer, and which tools to call around the caller's own.
    expect(caps.payment).toMatchObject({ signing: "caller", steps: {
      subscription: ["begin_session", "complete_session", "execute_subscription_round"],
      x402: ["prepare_x402_round", "execute_x402_round"],
      solanaSubmit: ["prepare_submit_attestation", "send_signed_transaction"] } });
    const derived = (await app.call("derive_source_id", { apiConfig })).body.result.structuredContent;
    expect(derived.sourceId).toMatch(/^[0-9a-fx]{64,66}$/);
    const artifact = toDataUpdateArtifact(flatResult);
    expect((await app.call("build_verifier_calldata", { dataUpdate: artifact.dataUpdate, signature: artifact.signature, chain: "evm" })).body.result.structuredContent.chain).toBe("evm");
  });
  it.each(["describe_feed", "get_latest_value"])("%s needs an explicit submitter and reports no subscription", async name => {
    const app = await start();
    const args = { sourceId: flatResult.sourceId, signaturesRequired: 1 };
    expect((await app.call(name, args)).body.result.content[0].text).toContain("submitter_required");
    const result = (await app.call(name, { ...args, submitter: walletA })).body.result.structuredContent;
    expect(result).toMatchObject({ submitter: walletA, feed: null });
    expect(result.subscription).toBeUndefined();
  });
  it("x402 status omits payer and daily budgets unless a payer is named", async () => {
    const app = await start();
    const status = (await app.call("get_x402_status")).body.result.structuredContent;
    expect(status.gateway).toBeDefined();
    expect(status.payer).toBeUndefined();
    expect(status.note).toMatch(/pass `payer`/);
    expect(status.caps.dailyCapsEnabled).toBe(false);
    expect(fetchX402Status).toHaveBeenCalled();
  });
  it("offers x402 as prepare then execute, and never the one-shot signing tool's inputs", async () => {
    const app = await start();
    const tools = (await app.rpc("tools/list")).body.result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    const execute = tools.find(tool => tool.name === "execute_x402_round")!;
    expect(tools.map(tool => tool.name)).toContain("prepare_x402_round");
    expect(Object.keys(execute.inputSchema.properties).sort()).toEqual(["challenge", "signedTransaction"]);
    expect((await app.call("execute_x402_round", { apiConfig, chains: ["solana"] })).response.status).toBe(400);
  });
  it("keeps the prepared-payment error codes through the hosted error policy", async () => {
    const secret = "7c".repeat(32);
    const unconfigured = await start();
    const args = { challenge: "mc1.00000000.e30.AAAA", signedTransaction: "AA==" };
    expect((await unconfigured.call("execute_x402_round", args)).body.result.content[0].text).toContain("missing_config");
    const app = await start({ config: { ...loadHttpConfig({ MOLPHA_HTTP_CHALLENGE_SECRET: secret }), port: 0 } });
    const refused = (await app.call("execute_x402_round", args)).body.result;
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text)).toMatchObject({ code: "invalid_challenge" });
    expect(JSON.stringify(app.logs)).not.toContain(secret);
  });
  it("no longer offers any tool that signs on the server", async () => {
    const app = await start();
    const tools = (await app.rpc("tools/list")).body.result.tools as Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown> } }>;
    const names = tools.map(tool => tool.name);
    expect(names).not.toContain("submit_attestation");
    expect(names).toEqual(expect.arrayContaining(["begin_session", "complete_session", "describe_access", "prepare_submit_attestation", "send_signed_transaction"]));
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema.properties)).not.toEqual(expect.arrayContaining(["autoSubmit"]));
      expect(Object.keys(tool.inputSchema.properties)).not.toEqual(expect.arrayContaining(["encryptSecrets"]));
      expect(tool.description).toContain("holds no keys");
      expect(tool.description).not.toMatch(/signer header/i);
    }
    const subscription = tools.find(tool => tool.name === "execute_subscription_round")!;
    expect(Object.keys(subscription.inputSchema.properties)).toContain("sessionToken");
    // The stdio-shaped calls are refused as malformed, not run without authorization.
    expect((await app.call("execute_subscription_round", { apiConfig, chains: ["solana"] })).response.status).toBe(400);
    expect((await app.call("submit_attestation", { result: flatResult })).response.status).toBe(400);
    expect(app.contexts).toHaveLength(0);
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
    const app = await start({ contextFactory: (_runtime, lifecycle) => ({ ...runtime, hosted: true, lifecycle,
      gateway: { getNodes: async () => { throw new Error(canary); } },
      solana: { getRegistryVersion: async () => { throw new Error(canary); }, readFeed: async () => { throw new Error(canary); }, readSubscription: async () => { throw new Error(canary); } } }) });
    for (const [tool, args] of [["get_capabilities", {}], ["get_latest_value", { sourceId: flatResult.sourceId, signaturesRequired: 1, submitter: walletA }], ["describe_access", { address: walletA }]] as const) {
      expect(JSON.stringify((await app.call(tool, args)).body)).not.toContain(canary);
    }
    const mismatch = sanitizeToolResult({ isError: true, content: [{ type: "text", text: canary }, { type: "text", text: JSON.stringify({ code: "output_schema_mismatch", message: canary }) }] });
    expect(JSON.stringify(mismatch)).not.toContain(canary);
    const metadata = sanitizeToolResult({ content: [], structuredContent: { verifiers: { starknet: [{ network: "test", error: canary }] } } });
    expect(JSON.stringify(metadata)).not.toContain(canary);
    expect(JSON.stringify(app.logs)).not.toContain(canary);
  });
  it("stops at the deadline, and says so differently once a payment may be in flight", async () => {
    const secret = "7c".repeat(32);
    const config = { ...loadHttpConfig({ MOLPHA_HTTP_CHALLENGE_SECRET: secret }), timeoutMs: 120, port: 0 };
    const runtime = getSharedRuntime({});
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const app = await start({ config, contextFactory: (_runtime, lifecycle) => ({ ...runtime, hosted: true, lifecycle,
      connection: { getBlockHeight: async () => 1 } as unknown as RequestContext["connection"],
      gateway: { getNodes: async () => { await pending; return []; } }, solana: { getRegistryVersion: async () => 7 } }) });

    // Nothing irreversible started: a plain timeout.
    const read = await app.call("get_capabilities");
    expect(read.response.status).toBe(504);
    expect(read.body.error.message).toBe("Request timed out.");

    // The payment was handed to the gateway and the answer never came: the caller is told what to look for.
    vi.mocked(executePreparedX402Round).mockImplementation(async (ctx) => {
      ctx.lifecycle!.effectStarted = true;
      ctx.lifecycle!.reconciliation = { payer: walletA, payTo: walletB, memo: "a".repeat(64), sourceId: "b".repeat(64),
        amountAtomicUsdc: "10", payerSignature: "5".repeat(88), lastValidBlockHeight: 100, gatewayMessage: canary };
      await pending;
      throw new Error("unreachable");
    });
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: Keypair.generate().publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [] }).compileToV0Message());
    const challenge = sealChallenge(config.challengeKeys!, "x402", { round: { lastValidBlockHeight: 100 }, chains: ["evm"] }, Date.now() / 1000 + 60);
    const paid = await app.call("execute_x402_round", { challenge, signedTransaction: Buffer.from(tx.serialize()).toString("base64") });
    expect(paid.response.status).toBe(504);
    expect(paid.body.error.message).toContain("Reconcile");
    expect(paid.body.error.data).toMatchObject({ code: "payment_outcome_unknown",
      details: { payer: walletA, memo: "a".repeat(64), amountAtomicUsdc: "10", payerSignature: "5".repeat(88), lastValidBlockHeight: 100 } });
    expect(JSON.stringify(paid.body)).not.toContain(canary);
    release();
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
    const app = await start({ log: entry => { process.stderr.write(JSON.stringify(entry)); }, contextFactory: (_runtime, lifecycle) => ({
      ...runtime, hosted: true, lifecycle,
      gateway: { getNodes: async () => { throw new Error(canary); }, fetchGatewayInfo: async () => { throw Object.assign(new Error(canary), { status: 401 }); } },
      solana: { getRegistryVersion: async () => 1, readFeed: async () => { throw new Error(canary); }, readSubscription: async () => { throw new Error(canary); },
        getRegistrySelectionConfig: async () => { throw new Error(canary); } }
    }) });
    const results = await Promise.all([
      app.call("get_capabilities", {}),
      app.call("describe_feed", { sourceId: flatResult.sourceId, signaturesRequired: 1, submitter: walletA }),
      app.call("describe_access", { address: walletA }),
      // A session token and a signature are credentials too: neither may reach a log, even on failure.
      app.call("execute_subscription_round", { sessionToken: `molpha_sess_${canary}`, apiConfig: { ...apiConfig, headers: { Authorization: canary } }, chains: ["solana"] }),
      app.call("complete_session", { challenge: canary, signature: canary }),
      app.call("get_capabilities", {}, legacySignerHeaders())
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
  const app = await start({ contextFactory: (_runtime, lifecycle) => ({ ...runtime, lifecycle, hosted: true,
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

it("cancels the work of a request whose client has gone", async () => {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const after = vi.fn(async () => 7);
  const runtime = getSharedRuntime({});
  let lifecycleSignal: AbortSignal | undefined;
  const app = await start({ contextFactory: (_runtime, lifecycle) => {
    lifecycleSignal = lifecycle.signal;
    return { ...runtime, lifecycle, hosted: true,
      gateway: { getNodes: async () => { entered(); await pending; lifecycle.signal.throwIfAborted(); await after(); return []; } },
      solana: { getRegistryVersion: async () => 7 } };
  } });
  const controller = new AbortController();
  const response = fetch(`${app.base}/mcp`, { method: "POST", signal: controller.signal,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_capabilities", arguments: {} } }) });
  const rejected = expect(response).rejects.toThrow();
  await ready;
  controller.abort();
  await rejected;
  await vi.waitFor(() => expect(lifecycleSignal?.aborted).toBe(true));
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(after).not.toHaveBeenCalled();
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
