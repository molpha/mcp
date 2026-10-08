/**
 * list_providers and get_provider read the gateway's provider catalog. The gateway is faked with a stubbed fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMolphaContext, type MolphaContext } from "../../src/clients.js";
import { loadConfig } from "../../src/config.js";
import { callTool, callToolError } from "./tool-harness.js";

vi.mock("../../src/clients.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/clients.js")>()),
  getMolphaContext: vi.fn()
}));

const feed = (id: string, flowHost: string) => ({
  id,
  title: `${id} last trade`,
  operation: "crypto.trade_last",
  symbol: id.toUpperCase(),
  sourceId: id.padEnd(64, "0"),
  apiConfig: { url: `${flowHost}/crypto/trade/last/${id.toUpperCase()}`, method: "GET", headers: {}, responseParser: "$.price", valueTransform: "" }
});

const detail = {
  id: "tickerlayer",
  name: "TickerLayer",
  description: "Real-time market data.",
  docsUrl: "https://tickerlayer.com/docs",
  termsUrl: "https://tickerlayer.com/terms-of-use#data-licence",
  disclosure: "Values are attested provider quotes.",
  aggregation: { mode: "tolerance", minSignatures: 3, reason: "Live ticks differ between nodes." },
  operations: [{ id: "crypto.trade_last", assetClass: "crypto", path: "/crypto/trade/last/:symbol", symbolExample: "BTCUSD" }],
  flows: [
    { kind: "api_key", baseUrl: "https://api.tickerlayer.com", credential: { mode: "sponsored", header: "x-api-key" }, feeds: [feed("btcusd", "https://api.tickerlayer.com"), feed("eurusd", "https://api.tickerlayer.com")] },
    { kind: "x402", baseUrl: "https://x402-testnet.tickerlayer.com", pathPrefix: "/v1", x402: { network: "eip155:84532" }, feeds: [feed("btcusd", "https://x402-testnet.tickerlayer.com/v1")] }
  ]
};

const ok = (data: unknown) => new Response(JSON.stringify({ status: "ok", data }), { status: 200 });
const notFoundProvider = () => new Response(JSON.stringify({ error: "provider not found" }), { status: 404 });
const notFoundRoute = () => new Response("404 page not found", { status: 404 });

function useGateways(endpoints: string[], answer: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return answer(String(input));
  }));
  const context = { config: loadConfig({ GATEWAY_ENDPOINTS: endpoints.join(","), SOLANA_RPC: "http://solana.test" }) };
  vi.mocked(getMolphaContext).mockResolvedValue(context as unknown as MolphaContext);
  return calls;
}

beforeEach(() => vi.mocked(getMolphaContext).mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("list_providers", () => {
  it("lists what the gateway integrates, and which gateway answered", async () => {
    const calls = useGateways(["http://gw.test/"], () =>
      ok({ providers: [{ id: "tickerlayer", name: "TickerLayer", description: "d", flows: ["api_key", "x402"], feedCount: 6 }] })
    );

    expect(await callTool("list_providers", {})).toEqual({
      gateway: "http://gw.test/",
      providers: [{ id: "tickerlayer", name: "TickerLayer", description: "d", flows: ["api_key", "x402"], feedCount: 6 }]
    });
    expect(calls).toEqual(["http://gw.test/v1/providers"]);
  });

  it("answers an empty list when the gateway integrates none", async () => {
    useGateways(["http://gw.test"], () => ok({ providers: [] }));
    expect(await callTool("list_providers", {})).toMatchObject({ providers: [] });
  });

  it("skips a gateway without the catalog and uses the next", async () => {
    const calls = useGateways(["http://old.test", "http://new.test"], (url) => (url.startsWith("http://old.test") ? notFoundRoute() : ok({ providers: [] })));
    expect(await callTool("list_providers", {})).toMatchObject({ gateway: "http://new.test" });
    expect(calls).toHaveLength(2);
  });

  it("says plainly when no configured gateway serves the catalog", async () => {
    useGateways(["http://old.test"], () => notFoundRoute());
    const error = await callToolError("list_providers", {});
    expect(String(error.message)).toContain("does not serve the provider catalog");
  });
});

describe("get_provider", () => {
  it("describes the provider with complete feeds and says how to use them", async () => {
    useGateways(["http://gw.test"], () => ok(detail));
    const out = await callTool("get_provider", { provider: "tickerlayer" });

    expect(out).toMatchObject({ id: "tickerlayer", aggregation: { mode: "tolerance", minSignatures: 3 }, disclosure: "Values are attested provider quotes." });
    expect((out.flows as unknown[]).length).toBe(2);
    expect(out.operations).toBeUndefined();
    // Both flows are explained, and the advice is to pass the apiConfig unchanged.
    expect(String(out.howToUse)).toContain("unchanged");
    expect(String(out.howToUse)).toContain("api_key flow");
    expect(String(out.howToUse)).toContain("x402 flow");
    expect(String(out.howToUse)).toContain("attested provider quotes");
  });

  it("narrows to one flow and one feed", async () => {
    useGateways(["http://gw.test"], () => ok(detail));
    const out = await callTool("get_provider", { provider: "tickerlayer", flow: "x402", feed: "btcusd" });
    const flows = out.flows as Array<{ kind: string; feeds: Array<{ id: string }> }>;

    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ kind: "x402" });
    expect(flows[0]!.feeds.map((f) => f.id)).toEqual(["btcusd"]);
    expect(String(out.howToUse)).not.toContain("api_key flow");
  });

  it("includes the routes only when asked", async () => {
    useGateways(["http://gw.test"], () => ok(detail));
    expect(await callTool("get_provider", { provider: "tickerlayer", includeOperations: true })).toMatchObject({
      operations: [{ id: "crypto.trade_last" }]
    });
  });

  it("encodes the provider id so it cannot reach another path", async () => {
    const calls = useGateways(["http://gw.test"], () => notFoundProvider());
    await callToolError("get_provider", { provider: "../nodes" });
    expect(calls).toEqual(["http://gw.test/v1/providers/..%2Fnodes"]);
  });

  it("names the available feeds when one does not exist", async () => {
    useGateways(["http://gw.test"], () => ok(detail));
    const error = await callToolError("get_provider", { provider: "tickerlayer", feed: "dogeusd" });
    expect(String(error.message)).toContain("btcusd, eurusd");
  });

  it("says which flows exist when the asked-for one does not", async () => {
    useGateways(["http://gw.test"], () => ok({ ...detail, flows: [detail.flows[0]] }));
    const error = await callToolError("get_provider", { provider: "tickerlayer", flow: "x402" });
    expect(String(error.message)).toContain("does not serve the x402 flow");
    expect(String(error.message)).toContain("api_key");
  });

  it("sends the caller to list_providers for an unknown provider", async () => {
    useGateways(["http://gw.test"], () => notFoundProvider());
    const error = await callToolError("get_provider", { provider: "nope" });
    expect(String(error.message)).toContain("list_providers");
  });
});
