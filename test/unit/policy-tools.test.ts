/**
 * analyze_source (local) and simulate_source (the gateway's POST /v1/source/simulate, faked with a stubbed fetch).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMolphaContext, type MolphaContext } from "../../src/clients.js";
import { loadConfig } from "../../src/config.js";
import { deriveSourceId, parseSource, policyFallbackWords } from "../../src/source.js";
import { priceSource } from "./sources.js";
import { callTool, callToolError } from "./tool-harness.js";

vi.mock("../../src/clients.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/clients.js")>()),
  getMolphaContext: vi.fn()
}));

const venue = (host: string) => ({
  kind: "http",
  read: { method: "GET", url: `https://${host}/p`, headers: {}, body: null },
  decode: { format: "json", fields: { price: { path: "$.price" } } }
});
const candidate = (name: string) => ({ role: "corroborating", value: { ref: `${name}.price` }, weight: null, rules: [], onError: "disqualify" });

/** A median of two venues that signs -1 when fewer than two qualify. */
const policySource = {
  v: "1",
  aggregation: null,
  assert: [{ op: "gte", args: [{ ref: "$out" }, { const: "0" }] }],
  inputs: { a: venue("a.example.com"), b: venue("b.example.com") },
  policy: {
    candidates: { a: candidate("a"), b: candidate("b") },
    combine: { op: "median", minQualifying: "2", maxSpreadBps: null, order: null },
    independence: "distinctHosts",
    inconclusiveIf: [],
    inconclusive: { fallback: { const: "-1" } }
  },
  transform: { ref: "$agg" },
  output: { type: "int256", decimals: "2" }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("analyze_source", () => {
  it("reports a policy's candidates, fallback words and warnings, with what each warning means", async () => {
    const out = await callTool("analyze_source", { source: policySource });
    const analysis = out.analysis as { policy: { candidates: unknown[]; fallback: { values: string[] } }; aggregation: string };
    expect(analysis.aggregation).toBe("exact");
    expect(analysis.policy.candidates).toHaveLength(2);
    expect(out.fallbackWords).toEqual(["0x" + "ff".repeat(31) + "9c"]);
    const warnings = out.warnings as { code: string; meaning: string }[];
    const composite = warnings.find((w) => w.code === "exactComposite");
    expect(composite?.meaning).toMatch(/tolerance/);
  });

  it("has no policy and no fallback words for a plain source", async () => {
    const out = await callTool("analyze_source", { source: priceSource({ url: "https://example.com/finalized" }).doc });
    expect((out.analysis as { policy: unknown }).policy).toBeNull();
    expect(out.fallbackWords).toEqual([]);
  });

  it("rejects an invalid source with its path, without any network", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await callToolError("analyze_source", { source: { ...policySource, v: "2" } })).toMatchObject({ code: "invalid_source" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

function useGateways(endpoints: string[], answer: (url: string, body: unknown) => Response) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as unknown;
      calls.push({ url: String(input), body });
      return answer(String(input), body);
    })
  );
  const context = { config: loadConfig({ GATEWAY_ENDPOINTS: endpoints.join(","), SOLANA_RPC: "http://solana.test" }) };
  vi.mocked(getMolphaContext).mockResolvedValue(context as unknown as MolphaContext);
  return calls;
}

const simulation = {
  sourceId: deriveSourceId(policySource).sourceId.slice(2),
  source: policySource,
  inputs: [],
  value: { encoded: "0x" + "ff".repeat(31) + "9c", display: "-1", type: "int256", decimals: 2 },
  policy: { candidates: [], n: 1, outcome: "inconclusive", reason: "0x01", signed: true }
};

describe("simulate_source", () => {
  it("posts the canonical source and the inputs to the first gateway that serves the route", async () => {
    const calls = useGateways(["https://old.gw", "https://new.gw/"], (url) =>
      url.startsWith("https://old.gw")
        ? new Response("404 page not found", { status: 404 })
        : new Response(JSON.stringify({ status: "ok", data: simulation }), { status: 200 })
    );
    const inputs = { a: { body: '{"price": 100}' }, b: { error: "fetch" } };
    const out = await callTool("simulate_source", { source: policySource, inputs, timestampMs: 1_795_000_000_500 });
    expect(out.gateway).toBe("https://new.gw");
    expect((out.simulation as typeof simulation).policy.reason).toBe("0x01");
    expect(calls.map((c) => c.url)).toEqual(["https://old.gw/v1/source/simulate", "https://new.gw/v1/source/simulate"]);
    const sent = calls[1]!.body as { source: Record<string, unknown>; inputs: unknown; timestampMs: number };
    expect(sent.inputs).toEqual(inputs);
    expect(sent.timestampMs).toBe(1_795_000_000_500);
    expect(Object.keys(sent.source)).toContain("policy");
  });

  it("stops at a refusal of the request itself; another gateway would refuse it too", async () => {
    const calls = useGateways(["https://a.gw", "https://b.gw"], () =>
      new Response(JSON.stringify({ error: "inputs.b is missing" }), { status: 400 })
    );
    const err = await callToolError("simulate_source", { source: policySource, inputs: { a: { body: "{}" } } });
    expect(JSON.stringify(err)).toMatch(/inputs\.b is missing/);
    expect(calls).toHaveLength(1);
  });

  it("reports every gateway it tried when none could simulate", async () => {
    useGateways(["https://a.gw"], () => new Response(JSON.stringify({ error: "previews at capacity" }), { status: 503 }));
    const err = await callToolError("simulate_source", { source: policySource, inputs: { a: { body: "{}" }, b: { body: "{}" } } });
    expect(JSON.stringify(err)).toMatch(/a\.gw: HTTP 503/);
  });

  it("does not take an answer about another source", async () => {
    const calls = useGateways(["https://a.gw", "https://b.gw"], (url) =>
      new Response(
        JSON.stringify({ status: "ok", data: url.startsWith("https://a.gw") ? { ...simulation, sourceId: "ab".repeat(32) } : simulation }),
        { status: 200 }
      )
    );
    const out = await callTool("simulate_source", { source: policySource, inputs: { a: { body: "{}" }, b: { body: "{}" } } });
    expect(out.gateway).toBe("https://b.gw");
    expect(calls).toHaveLength(2);
    useGateways(["https://a.gw"], () => new Response(JSON.stringify({ status: "ok", data: { ...simulation, sourceId: "ab".repeat(32) } })));
    const err = await callToolError("simulate_source", { source: policySource, inputs: {} });
    expect(JSON.stringify(err)).toMatch(/answered for source/);
  });

  it("refuses an invalid source before any request", async () => {
    const calls = useGateways(["https://a.gw"], () => new Response("{}"));
    expect(await callToolError("simulate_source", { source: { ...policySource, v: "2" }, inputs: {} })).toMatchObject({ code: "invalid_source" });
    expect(calls).toHaveLength(0);
  });
});

describe("policyFallbackWords", () => {
  it("gives a policy source's fallback words, and nothing for a source without a policy", () => {
    expect(policyFallbackWords(parseSource(policySource))).toEqual(["0x" + "ff".repeat(31) + "9c"]);
    expect(policyFallbackWords(parseSource(priceSource({ url: "https://api.example.com/p" }).doc))).toBeUndefined();
  });
});
