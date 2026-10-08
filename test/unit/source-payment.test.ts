/**
 * Paying a paywalled source. The gateway, the chain and the source are faked; what is under test is the part that
 * spends money: nothing is signed unless every check passes, and the key never leaves the server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMolphaContext, getSharedRuntime, type MolphaContext } from "../../src/clients.js";
import { loadConfig } from "../../src/config.js";
import { resetGuardrailCounters, sourceSpentToday } from "../../src/guardrails.js";
import { callTool, callToolError } from "./tool-harness.js";

vi.mock("../../src/clients.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/clients.js")>()),
  getMolphaContext: vi.fn()
}));

/** A disposable key used by these tests only. It is not funded anywhere. */
// Not made of digits the fake attestation uses, so "the key is absent" cannot be fooled by a coincidence.
const PAYER_KEY = `0x${"ab".repeat(32)}`;
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOURCE_URL = "https://x402-testnet.tickerlayer.com/v1/crypto/trade/last/BTCUSD";

const apiConfig = {
  url: SOURCE_URL,
  method: "GET" as const,
  responseParser: "$.price",
  aggregation: { mode: "tolerance" as const, rule: "median" as const, maxDeviationBps: 50, maxAgeMs: 2000, numeric: { type: "int256" as const, decimals: 8 } }
};

/** The source's own x402 terms, as a paywalled API answers an unpaid fetch. */
function source402(overrides: Record<string, unknown> = {}, extensions: Record<string, unknown> | null = { "payment-identifier": { info: { required: true } } }): Response {
  return new Response(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact", network: "eip155:84532", asset: USDC_SEPOLIA, payTo: "0x7Dc94dfDdAE57023feea1458B54C4c552E1d0dAC",
          amount: "10000", maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" }, ...overrides
        }
      ],
      ...(extensions ? { extensions } : {})
    }),
    { status: 402 }
  );
}

/**
 * Whether the installed SDK reads a source's payment-identifier. TickerLayer rejects a payment without one, so
 * paying it needs an SDK that does; the SDK this package pins may predate that. The checks that depend on it are
 * skipped, loudly, on an older SDK rather than failing every unrelated build.
 */
const SDK_CARRIES_PAYMENT_IDENTIFIER = await (async () => {
  const { probeSource } = (await import("@molpha/sdk")) as unknown as { probeSource: (c: unknown) => Promise<{ paymentIdentifier?: unknown } | null> };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => source402()) as typeof fetch;
  try {
    return (await probeSource({ url: SOURCE_URL, responseParser: "$.price" }))?.paymentIdentifier !== undefined;
  } finally {
    globalThis.fetch = realFetch;
  }
})();
const needsPaymentIdentifierSdk = SDK_CARRIES_PAYMENT_IDENTIFIER ? "" : " (SKIPPED: the installed @molpha/sdk predates payment-identifier support; bump the pin once it is published)";

const attestation = {
  payload: { value: "2".repeat(64), sourceId: "1".repeat(64), registryVersion: 5, signaturesRequired: 3, timestamp: 1_791_381_703_000 },
  signature: { s: "3".repeat(64), commitmentAddr: "4".repeat(40), signersBitmap: "7" },
  value: "83129.67",
  fresh: true
};

const env = (extra: Record<string, string> = {}) => ({
  GATEWAY_ENDPOINTS: "http://gateway.test",
  SOLANA_RPC: "http://solana.test",
  MOLPHA_SOURCE_PAYER_KEY: PAYER_KEY,
  MOLPHA_SOURCE_PAYMENT_NETWORKS: "eip155:84532",
  ...extra
});

/** `requestSignedData` is the SDK call that would sign and send the authorizations. */
function fakeContext(extraEnv: Record<string, string> = {}, drop: string[] = []) {
  const e: Record<string, string> = env(extraEnv);
  for (const key of drop) delete e[key];
  const gateway = {
    getNodes: vi.fn(async () => Array.from({ length: 5 }, (_, index) => ({ index }))),
    requestSignedData: vi.fn(async (_: Record<string, unknown>) => attestation)
  };
  const solana = { getRegistrySelectionConfig: vi.fn(async () => ({ registryVersion: 5, redundancyBuffer: 1, nodeCount: 5 })) };
  const context = { config: loadConfig(e), gateway, solana, signer: { publicKey: "11111111111111111111111111111112" } };
  vi.mocked(getMolphaContext).mockResolvedValue(context as unknown as MolphaContext);
  return { gateway, solana, config: context.config };
}

function stubSource(response: () => Response) {
  const probes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    probes.push(String(input));
    return response();
  }));
  return probes;
}

const pay = (maxSpendUsdc: string, extra: Record<string, unknown> = {}) => ({
  apiConfig, signaturesRequired: 3, chains: ["solana"], sourcePayment: { maxSpendUsdc }, ...extra
});

/** Everything a tool returned or failed with, as one string: the key must be in none of it. */
const everything = (value: unknown) => JSON.stringify(value);

beforeEach(() => {
  resetGuardrailCounters();
  vi.mocked(getMolphaContext).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("source payment configuration", () => {
  it("is off unless BOTH a payer key and an allowed network are configured", () => {
    expect(loadConfig({}).sourcePayment).toMatchObject({ payerKey: undefined, networks: [] });
    const noNetwork = fakeContext({}, ["MOLPHA_SOURCE_PAYMENT_NETWORKS"]);
    const noKey = fakeContext({}, ["MOLPHA_SOURCE_PAYER_KEY"]);
    expect(noNetwork.config.sourcePayment?.networks).toEqual([]);
    expect(noKey.config.sourcePayment?.payerKey).toBeUndefined();
  });

  it("rejects a malformed key without echoing it, and a malformed network", () => {
    const bad = "not-a-key-0123456789";
    try {
      loadConfig({ MOLPHA_SOURCE_PAYER_KEY: bad });
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).toContain("32-byte hex private key");
      expect(String((error as Error).message)).not.toContain(bad);
    }
    expect(() => loadConfig({ MOLPHA_SOURCE_PAYMENT_NETWORKS: "solana:devnet" })).toThrow(/CAIP-2 EVM networks/);
    expect(() => loadConfig({ MOLPHA_SOURCE_PAYMENT_NETWORKS: "eip155:84532,base" })).toThrow(/"base"/);
    expect(() => loadConfig({ MOLPHA_SOURCE_PAYMENT_NETWORKS: "eip155:11155111" })).toThrow(/no known USDC contract/);
  });

  it("defaults to a quarter dollar a round and a dollar a day", () => {
    expect(loadConfig({}).sourcePayment).toMatchObject({ maxPerRoundAtomic: 250_000n, maxPerDayAtomic: 1_000_000n });
  });

  it("is never loaded by the hosted server, which holds no wallet", () => {
    const runtime = getSharedRuntime(env() as NodeJS.ProcessEnv);
    expect(runtime.config.sourcePayment?.payerKey).toBeUndefined();
    expect(runtime.config.sourcePayment?.networks).toEqual([]);
  });

  it("shows up in get_capabilities as a policy, with the payer's address and never its key", async () => {
    fakeContext();
    const out = await callTool("get_capabilities", {});
    expect(out.sourcePayment).toMatchObject({ enabled: true, allowedNetworks: ["eip155:84532"], perRoundCapUsdc: "0.25", dailyCapUsdc: "1" });
    expect(String((out.sourcePayment as { payer: string }).payer)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(everything(out)).not.toContain(PAYER_KEY.slice(2));
  });
});

describe("quote_source_payment", () => {
  it("prices the round before anything is paid: per fetch, the nodes that fetch, and the worst case", async () => {
    fakeContext();
    const probes = stubSource(() => source402());
    const out = await callTool("quote_source_payment", { apiConfig, signaturesRequired: 3 });

    expect(probes).toEqual([SOURCE_URL]); // exactly one unpaid request
    expect(out).toMatchObject({
      paywalled: true,
      quote: {
        network: "eip155:84532", pricePerCallUsdc: "0.01", eligibleSetSize: 4, // min(3 + buffer 1, 5 nodes)
        worstCaseUsdc: "0.04"
      },
      policy: { enabled: true, networkAllowed: true, wouldPay: true, reasons: [] }
    });
  });

  it.skipIf(!SDK_CARRIES_PAYMENT_IDENTIFIER)(`says when the source requires a payment identifier${needsPaymentIdentifierSdk}`, async () => {
    fakeContext();
    stubSource(() => source402());
    expect(await callTool("quote_source_payment", { apiConfig, signaturesRequired: 3 })).toMatchObject({ quote: { requiresPaymentIdentifier: true } });
  });

  it("reports a free source as free", async () => {
    fakeContext();
    stubSource(() => new Response("{}", { status: 200 }));
    expect(await callTool("quote_source_payment", { apiConfig, signaturesRequired: 3 })).toMatchObject({ paywalled: false });
  });

  it("says why it would not pay: an unlisted network, a price over the cap, no configuration", async () => {
    fakeContext();
    stubSource(() => source402({ network: "eip155:8453", asset: USDC_BASE }));
    expect(await callTool("quote_source_payment", { apiConfig, signaturesRequired: 3 })).toMatchObject({
      policy: { networkAllowed: false, wouldPay: false }
    });

    // 0.10 per fetch x 4 = 0.40, above the 0.25 per-round cap.
    stubSource(() => source402({ amount: "100000" }));
    const dear = await callTool("quote_source_payment", { apiConfig, signaturesRequired: 3 });
    expect(dear).toMatchObject({ quote: { worstCaseUsdc: "0.4" }, policy: { wouldPay: false } });
    expect(String((dear.policy as { reasons: string[] }).reasons.join(" "))).toContain("per-round cap");

    fakeContext({}, ["MOLPHA_SOURCE_PAYER_KEY"]);
    stubSource(() => source402());
    expect(await callTool("quote_source_payment", { apiConfig, signaturesRequired: 3 })).toMatchObject({ policy: { enabled: false, wouldPay: false } });

    fakeContext();
    stubSource(() => source402({ asset: "0x0000000000000000000000000000000000000001" }));
    const wrongAsset = await callTool("quote_source_payment", { apiConfig, signaturesRequired: 3 });
    expect(wrongAsset).toMatchObject({ policy: { networkAllowed: true, assetAllowed: false, wouldPay: false } });
    expect(String((wrongAsset.policy as { reasons: string[] }).reasons.join(" "))).toContain("only signs USDC");
  });
});

describe("execute_subscription_round with sourcePayment", () => {
  it("pays the vetted terms, once, and says what it did", async () => {
    const { gateway } = fakeContext();
    stubSource(() => source402());
    const out = await callTool("execute_subscription_round", pay("0.04"));

    expect(gateway.requestSignedData).toHaveBeenCalledTimes(1);
    const sent = gateway.requestSignedData.mock.calls[0]![0] as { maxRetries: number; sourcePayment: { terms: Record<string, unknown>; signer: { address: string } } };
    // No automatic retry once signing starts, and the SDK signs exactly the terms that were vetted.
    expect(sent.maxRetries).toBe(1);
    expect(sent.sourcePayment.terms).toMatchObject({ amount: "10000", network: "eip155:84532" });
    expect(sent.sourcePayment.signer.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    expect(out.sourcePayment).toMatchObject({ paid: true, network: "eip155:84532", authorizations: 4, pricePerCallUsdc: "0.01", upToUsdc: "0.04" });
    expect(out.dataUpdate).toBeDefined(); // the signed round is still returned
    expect(sourceSpentToday()).toBe(40_000n);
    expect(everything(out)).not.toContain(PAYER_KEY.slice(2));
  });

  it.skipIf(!SDK_CARRIES_PAYMENT_IDENTIFIER)(`hands the SDK the source's payment-identifier declaration to sign with${needsPaymentIdentifierSdk}`, async () => {
    const { gateway } = fakeContext();
    stubSource(() => source402());
    await callTool("execute_subscription_round", pay("0.04"));
    const sent = gateway.requestSignedData.mock.calls[0]![0] as { sourcePayment: { terms: Record<string, unknown> } };
    expect(sent.sourcePayment.terms).toMatchObject({ paymentIdentifier: { info: { required: true } } });
  });

  describe("refuses before signing anything", () => {
    const expectNothingPaid = (gateway: { requestSignedData: ReturnType<typeof vi.fn> }) => {
      expect(gateway.requestSignedData).not.toHaveBeenCalled();
      expect(sourceSpentToday()).toBe(0n);
    };

    it("when the server is not set up to pay", async () => {
      const { gateway } = fakeContext({}, ["MOLPHA_SOURCE_PAYER_KEY"]);
      const probes = stubSource(() => source402());
      const error = await callToolError("execute_subscription_round", pay("1"));
      expect(error).toMatchObject({ code: "source_payment_disabled" });
      expect(String(error.remediation)).toContain("MOLPHA_SOURCE_PAYER_KEY");
      expect(probes).toEqual([]); // not even a price fetch
      expectNothingPaid(gateway);
    });

    it("when the worst case is more than the caller authorized", async () => {
      const { gateway } = fakeContext();
      stubSource(() => source402());
      const error = await callToolError("execute_subscription_round", pay("0.03")); // worst case is 0.04
      expect(error).toMatchObject({ code: "source_payment_refused" });
      expect(String(error.message)).toContain("0.04 USDC");
      expect(String(error.message)).toContain("0.03 USDC you authorized");
      expectNothingPaid(gateway);
    });

    it("when the source asks for a network the server does not allow", async () => {
      const { gateway } = fakeContext();
      stubSource(() => source402({ network: "eip155:8453", asset: USDC_BASE }));
      const error = await callToolError("execute_subscription_round", pay("10"));
      expect(error).toMatchObject({ code: "source_payment_refused" });
      expect(String(error.message)).toContain("eip155:8453");
      expectNothingPaid(gateway);
    });

    it("when the source asks for a non-USDC token on an allowed network", async () => {
      const { gateway } = fakeContext();
      stubSource(() => source402({ asset: "0x0000000000000000000000000000000000000001" }));
      const error = await callToolError("execute_subscription_round", pay("10"));
      expect(error).toMatchObject({ code: "source_payment_refused" });
      expect(String(error.message)).toContain("only signs USDC");
      expect(String(error.message)).toContain(USDC_SEPOLIA);
      expectNothingPaid(gateway);
    });

    it("when the round would exceed the per-round cap, however much the caller authorized", async () => {
      const { gateway } = fakeContext();
      stubSource(() => source402({ amount: "100000" })); // 0.40 worst case, cap 0.25
      const error = await callToolError("execute_subscription_round", pay("100"));
      expect(String(error.message)).toContain("per-round cap");
      expectNothingPaid(gateway);
    });

    it("when it would pass the daily cap, counting what is already committed", async () => {
      const { gateway } = fakeContext({ MOLPHA_SOURCE_MAX_SPEND_PER_DAY_USDC: "0.05" });
      stubSource(() => source402());
      await callTool("execute_subscription_round", pay("0.04")); // 0.04 of 0.05
      const error = await callToolError("execute_subscription_round", pay("0.04"));
      expect(String(error.message)).toContain("daily cap");
      expect(gateway.requestSignedData).toHaveBeenCalledTimes(1);
      expect(sourceSpentToday()).toBe(40_000n); // the refused round added nothing
    });

    it("with a private source: its secrets cannot be paired with a payment", async () => {
      const { gateway } = fakeContext();
      const probes = stubSource(() => source402());
      const error = await callToolError("execute_subscription_round", pay("1", { encryptSecrets: { k: "v" } }));
      expect(String(error.message)).toContain("encryptSecrets");
      expect(probes).toEqual([]);
      expectNothingPaid(gateway);
    });
  });

  it("never lets concurrent rounds all pass a cap only one fits under", async () => {
    const { gateway } = fakeContext({ MOLPHA_SOURCE_MAX_SPEND_PER_DAY_USDC: "0.05" });
    stubSource(() => source402());
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => callTool("execute_subscription_round", pay("0.04"))));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(gateway.requestSignedData).toHaveBeenCalledTimes(1);
    expect(sourceSpentToday()).toBe(40_000n);
  });

  it("runs an unpaywalled source as an ordinary round and signs nothing", async () => {
    const { gateway } = fakeContext();
    stubSource(() => new Response("{}", { status: 200 }));
    const out = await callTool("execute_subscription_round", pay("0.04"));

    const sent = gateway.requestSignedData.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.sourcePayment).toBeUndefined();
    expect(sent.maxRetries).toBeUndefined();
    expect(out.sourcePayment).toMatchObject({ paid: false });
    expect(sourceSpentToday()).toBe(0n);
  });

  it("previews without probing or signing in a dry run", async () => {
    const { gateway } = fakeContext();
    const probes = stubSource(() => source402());
    const out = await callTool("execute_subscription_round", pay("0.04", { dryRun: true }));

    expect(out).toMatchObject({ dryRun: true, sourcePayment: { paid: false, upToUsdc: "0.04" } });
    expect(probes).toEqual([]);
    expect(gateway.requestSignedData).not.toHaveBeenCalled();
  });

  it("does not pay a paywalled source the caller did not authorize, and explains what to do", async () => {
    const { gateway } = fakeContext();
    stubSource(() => source402());
    // The SDK throws this when the gateway quotes a source and no payment was authorized.
    gateway.requestSignedData.mockRejectedValueOnce(
      Object.assign(new Error("API source requires payment for up to 4 fetches"), { name: "UpstreamPaymentRequiredError", quote: { provider: "tickerlayer", eligibleSetSize: 4 } })
    );
    const error = await callToolError("execute_subscription_round", {
      apiConfig, signaturesRequired: 3, chains: ["solana"]
    });

    expect(error).toMatchObject({ code: "source_payment_required", details: { provider: "tickerlayer", eligibleSetSize: 4 } });
    expect(String(error.remediation)).toContain("quote_source_payment");
    expect(String(error.remediation)).toContain("sourcePayment.maxSpendUsdc");
    expect((gateway.requestSignedData.mock.calls[0]![0] as Record<string, unknown>).sourcePayment).toBeUndefined();
    expect(sourceSpentToday()).toBe(0n);
  });

  it("never returns the payer key in any answer or error", async () => {
    const { gateway } = fakeContext();
    stubSource(() => source402());
    const outputs: unknown[] = [
      await callTool("execute_subscription_round", pay("0.04")),
      await callTool("quote_source_payment", { apiConfig, signaturesRequired: 3 }),
      await callTool("get_capabilities", {}),
      await callToolError("execute_subscription_round", pay("0.001"))
    ];
    gateway.requestSignedData.mockRejectedValueOnce(new Error("gateway down"));
    outputs.push(await callToolError("execute_subscription_round", pay("0.04")));

    for (const output of outputs) expect(everything(output)).not.toContain(PAYER_KEY.slice(2));
  });
});
