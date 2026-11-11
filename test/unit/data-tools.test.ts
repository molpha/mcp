/**
 * Molpha Data tools. The service is faked with a stubbed fetch answering with real responses of a service
 * that read mainnet (test/fixtures/data, 2026-11-11); signed reads run the real execute_subscription_round with a
 * faked SDK gateway.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../../src/clients.js";
import { loadConfig } from "../../src/config.js";
import { DATA_CATALOG } from "../../src/data-catalog.generated.js";
import { dataToolName } from "../../src/tools/data.js";
import { callTool, callToolError, collectTools } from "./tool-harness.js";

const fixture = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(new URL(`../fixtures/data/${name}`, import.meta.url), "utf8"));

const unsignedPrice = fixture("unsigned-pool-price.json");
const derived = fixture("derive-aave-reserve.json");
const snapshot = fixture("unsigned-token-snapshot-solana.json");

type Answer = { status?: number; body: unknown };

function useService(answer: (path: string, body: any) => Answer) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, headers: init.headers as Record<string, string> });
    const a = answer(new URL(url).pathname, body);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }));
  return calls;
}

const attestation = {
  payload: { value: "2".repeat(64), sourceId: derived.sourceId.slice(2), registryVersion: 5, signaturesRequired: 3, timestamp: 1_791_381_703_000 },
  signature: { s: "3".repeat(64), commitmentAddr: "4".repeat(40), signersBitmap: "7" },
  value: "0.04",
  fresh: true
};

function context(env: Record<string, string> = {}) {
  const gateway = { requestSignedData: vi.fn(async (_: Record<string, unknown>) => attestation) };
  const ctx = {
    config: loadConfig({ GATEWAY_ENDPOINTS: "http://gateway.test", SOLANA_RPC: "http://solana.test", MOLPHA_DATA_URL: "http://data.test", ...env }),
    gateway,
    solana: {},
    signer: { publicKey: "11111111111111111111111111111112" }
  };
  return { dependencies: { getContext: async () => ctx as unknown as RequestContext }, gateway };
}

afterEach(() => vi.unstubAllGlobals());

describe("the data tool surface", () => {
  it("has one tool per catalog template, each with the template's parameters", () => {
    const tools = collectTools();
    for (const t of DATA_CATALOG) {
      const tool = tools.find((x) => x.name === dataToolName(t.id));
      expect(tool, t.id).toBeDefined();
      for (const p of t.params) expect(Object.keys(tool!.config.inputSchema), `${t.id}.${p.name}`).toContain(p.name);
      expect(tool!.config.description).toContain(t.ref);
    }
    expect(new Set(DATA_CATALOG.map((t) => dataToolName(t.id))).size).toBe(DATA_CATALOG.length);
  });
});

describe("unsigned reads", () => {
  it("returns the service's read with its source, re-hashed", async () => {
    const { dependencies } = context({ MOLPHA_DATA_API_KEY: "client-key-0000000001" });
    const calls = useService(() => ({ body: unsignedPrice }));
    const out = await callTool("get_pool_price", { chain: "ethereum", pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640" }, dependencies);
    expect(out).toMatchObject({ mode: "unsigned", sourceId: unsignedPrice.source.sourceId, value: unsignedPrice.data.value });
    expect(calls[0]!.url).toBe("http://data.test/v1/read");
    expect(calls[0]!.body).toEqual({ template: "dex.pool.price@1", params: { chain: "ethereum", pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640" }, attest: false });
    expect(calls[0]!.headers["x-api-key"]).toBe("client-key-0000000001");
  });

  it("returns a snapshot's payload, layout and decoded fields", async () => {
    const { dependencies } = context();
    useService(() => ({ body: snapshot }));
    const out = await callTool("get_token_snapshot", { chain: "solana", token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, dependencies);
    expect(out).toMatchObject({ mode: "unsigned", payload: snapshot.payload, fields: snapshot.fields });
  });

  it("refuses a source that does not hash to its sourceId, and a payload that does not hash to its value", async () => {
    const { dependencies } = context();
    const bad = structuredClone(unsignedPrice);
    bad.source.config.output.decimals = "17";
    useService(() => ({ body: bad }));
    expect(JSON.stringify(await callToolError("get_pool_price", { chain: "ethereum", pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640" }, dependencies))).toMatch(/hashes to/);

    const badPayload = structuredClone(snapshot);
    badPayload.payload = badPayload.payload.replace(/.$/, (c: string) => (c === "0" ? "1" : "0"));
    useService(() => ({ body: badPayload }));
    expect(JSON.stringify(await callToolError("get_token_snapshot", { chain: "solana", token: "x" }, dependencies))).toMatch(/payload that does not hash to its value/);
  });

  it("passes the service's refusal through with its code", async () => {
    const { dependencies } = context();
    useService(() => ({ status: 424, body: { error: { code: "ASSERTION_FAILED", message: "source assertion: assertion 0 failed", stage: "source assertion" } } }));
    expect(await callToolError("read_data", { template: "lending.aave.reserve", params: { chain: "ethereum", asset: "0xdead" } }, dependencies)).toMatchObject({
      code: "source_failed",
      details: { service: "molpha-data", serviceCode: "ASSERTION_FAILED", stage: "source assertion" }
    });
    useService(() => ({ status: 422, body: { error: { code: "PARAM_INVALID", message: "dex.pool.price: pool: not an EVM address" } } }));
    expect(await callToolError("get_pool_price", { chain: "ethereum", pool: "0x1" }, dependencies)).toMatchObject({ code: "invalid_data_request" });
    useService(() => ({ status: 429, body: { error: { code: "RATE_LIMITED", message: "rate limit exceeded" } } }));
    expect(await callToolError("get_pool_price", { chain: "ethereum", pool: "0x1" }, dependencies)).toMatchObject({ code: "data_unavailable" });
  });
});

describe("signed reads", () => {
  it("derive at the service, then run the round through execute_subscription_round", async () => {
    const { dependencies, gateway } = context();
    const calls = useService((path) => (path === "/v1/sources/derive" ? { body: derived } : { status: 500, body: {} }));
    const out = await callTool(
      "get_aave_reserve",
      { chain: "ethereum", asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", attest: true, chains: ["solana"] },
      dependencies
    );
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1/sources/derive"]);
    expect(out).toMatchObject({ mode: "signed", sourceId: derived.sourceId, template: "lending.aave.reserve@1" });
    expect((out.round as Record<string, unknown>).payment).toBe("subscription");
    // The SDK got the source this server parsed, at the default quorum.
    const sent = gateway.requestSignedData.mock.calls[0]![0] as { source: { idHex: string }; signaturesRequired: number };
    expect(sent.source.idHex).toBe(derived.sourceId);
    expect(sent.signaturesRequired).toBe(3);
  });

  it("keeps the round tool's dry-run lock", async () => {
    const { dependencies, gateway } = context({ MOLPHA_DRY_RUN: "true" });
    useService(() => ({ body: derived }));
    const out = await callTool("read_data", { template: "lending.aave.reserve", params: {}, attest: true, chains: ["solana"] }, dependencies);
    expect(out).toMatchObject({ mode: "signed", round: { dryRun: true, payment: "subscription" } });
    expect(gateway.requestSignedData).not.toHaveBeenCalled();
    expect(await callToolError("read_data", { template: "lending.aave.reserve", params: {}, attest: true, chains: ["solana"], dryRun: false }, dependencies)).toMatchObject({ code: "dry_run_locked" });
  });

  it("refuses a derived source that does not hash to its sourceId before anything is signed", async () => {
    const { dependencies, gateway } = context();
    useService(() => ({ body: { ...derived, sourceId: "0x" + "00".repeat(32) } }));
    await callToolError("read_data", { template: "lending.aave.reserve", params: {}, attest: true, chains: ["solana"] }, dependencies);
    expect(gateway.requestSignedData).not.toHaveBeenCalled();
  });

  it("on a server that cannot sign, returns the derived source only", async () => {
    useService(() => ({ body: derived }));
    for (const deps of [{ readOnly: { reason: "no signer" } }, { hosted: {} }]) {
      const { dependencies } = context();
      const out = await callTool("read_data", { template: "lending.aave.reserve", params: {}, attest: true }, { ...deps, ...dependencies });
      expect(out).toMatchObject({ mode: "derived", sourceId: derived.sourceId, source: derived.source });
    }
  });
});

describe("list_data_templates", () => {
  it("falls back to this release's snapshot when the service does not answer", async () => {
    const { dependencies } = context();
    useService(() => ({ status: 503, body: { error: { code: "BUSY", message: "busy" } } }));
    const out = await callTool("list_data_templates", { class: "lending" }, dependencies);
    expect(out.from).toBe("snapshot");
    expect((out.templates as Array<{ tool: string }>).map((t) => t.tool)).toContain("get_aave_reserve");
  });
});
