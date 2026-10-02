import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import { assertToleranceQuorum, deriveSourceId } from "../../src/apiconfig.js";
import { checkApiConfigDeterminism } from "../../src/determinism.js";
import { decodeToleranceValue, describeValueEncoding } from "../../src/feed.js";
import { aggregationSchema, apiConfigSchema } from "../../src/tools/schemas.js";
import { prepareRound } from "../../src/tools/round.js";
import { callTool } from "./tool-harness.js";

const aggregation = {
  mode: "tolerance",
  rule: "median",
  maxDeviationBps: 50,
  maxAgeMs: 2000,
  numeric: { type: "int256", decimals: 8 }
} as const;

/** Pinned by the node's TestAggregationSourceIdentity and the gateway/SDK known-answer tests. */
const PREIMAGE =
  '{"url":"https://example.test","method":"GET","headers":{},"responseParser":"","valueTransform":"","aggregation":{"mode":"tolerance","rule":"median","maxDeviationBps":50,"maxAgeMs":2000,"numeric":{"type":"int256","decimals":8}}}';
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

describe("median tolerance mode: sourceId", () => {
  it("matches the node's known-answer preimage and digest", () => {
    const derived = deriveSourceId({ url: "https://example.test", responseParser: "", aggregation });

    expect(derived.canonicalJson).toBe(PREIMAGE);
    expect(derived.sourceId).toBe(`0x${toHex(keccak_256(Buffer.from(PREIMAGE, "utf8")))}`);
    expect(derived.sourceId.startsWith("0x6d061959")).toBe(true);
  });

  it("keeps an exact config's sourceId and omits aggregation from its preimage", () => {
    const exact = deriveSourceId({ url: "https://example.test", responseParser: "$.price" });

    expect(exact.canonicalJson).not.toContain("aggregation");
    expect(deriveSourceId({ url: "https://example.test", responseParser: "$.price", aggregation }).sourceId).not.toBe(exact.sourceId);
  });

  it("does not let key order or extra keys in the input leak into the preimage", () => {
    const shuffled = {
      numeric: { decimals: 8, type: "int256" },
      maxAgeMs: 2000,
      maxDeviationBps: 50,
      rule: "median",
      mode: "tolerance"
    } as unknown as typeof aggregation;

    expect(deriveSourceId({ url: "https://example.test", responseParser: "", aggregation: shuffled }).canonicalJson).toBe(PREIMAGE);
  });
});

describe("median tolerance mode: input validation", () => {
  it("rejects mode exact, other rules, other numeric types and a zero maxAgeMs", () => {
    expect(aggregationSchema.safeParse(aggregation).success).toBe(true);
    expect(aggregationSchema.safeParse({ ...aggregation, mode: "exact" }).success).toBe(false);
    expect(aggregationSchema.safeParse({ ...aggregation, rule: "mean" }).success).toBe(false);
    expect(aggregationSchema.safeParse({ ...aggregation, numeric: { type: "uint256", decimals: 8 } }).success).toBe(false);
    expect(aggregationSchema.safeParse({ ...aggregation, maxAgeMs: 0 }).success).toBe(false);
    expect(aggregationSchema.safeParse({ ...aggregation, numeric: { type: "int256", decimals: 256 } }).success).toBe(false);
    expect(aggregationSchema.safeParse({ ...aggregation, extra: 1 }).success).toBe(false);
  });

  it("is optional on apiConfig", () => {
    expect(apiConfigSchema.safeParse({ url: "https://x.test", responseParser: "$.p" }).success).toBe(true);
    expect(apiConfigSchema.safeParse({ url: "https://x.test", responseParser: "$.p", aggregation }).success).toBe(true);
  });

  it("requires at least 3 signatures", () => {
    expect(() => assertToleranceQuorum({ aggregation }, 2)).toThrow(/signaturesRequired >= 3/);
    expect(() => assertToleranceQuorum({ aggregation }, 3)).not.toThrow();
    expect(() => assertToleranceQuorum({}, 1)).not.toThrow();
  });

  it("refuses a 2-signer tolerance round in the shared round preparation both round tools use", () => {
    const base = { apiConfig: { url: "https://x.test/rate", responseParser: "$.p", aggregation }, chains: ["solana" as const] };

    expect(() => prepareRound({ ...base, signaturesRequired: 2 })).toThrow(/signaturesRequired >= 3/);
    expect(prepareRound({ ...base, signaturesRequired: 3 })).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prepareRound({ apiConfig: { url: "https://x.test/rate", responseParser: "$.p" }, chains: ["solana"], signaturesRequired: 1 })).toMatch(/^0x/);
  });

  it("derive_source_id returns aggregation in the canonical config and preimage", async () => {
    const out = await callTool("derive_source_id", {
      apiConfig: { url: "https://example.test", responseParser: "$.price", aggregation }
    });

    expect(out.canonicalApiConfig).toMatchObject({ aggregation });
    expect(String(out.canonicalJson)).toContain('"aggregation":{"mode":"tolerance"');
    expect(Object.keys(out.canonicalApiConfig as object)).toEqual([
      "url",
      "method",
      "headers",
      "responseParser",
      "valueTransform",
      "aggregation"
    ]);
  });

  it("does not warn about a live-drifting URL in tolerance mode, but does in exact mode", () => {
    const url = "https://api.example.test/price/latest";

    expect(checkApiConfigDeterminism({ url, responseParser: "$.p" }).warnings.length).toBeGreaterThan(0);
    expect(checkApiConfigDeterminism({ url, responseParser: "$.p", aggregation }).warnings).toEqual([]);
  });
});

describe("median tolerance mode: feed values", () => {
  it("reports the scale as attested and decodes a signed int256", () => {
    expect(describeValueEncoding("", aggregation)).toMatchObject({ attested: true, encoding: "int256", decimals: 8 });
    expect(describeValueEncoding("multiply:1")).toMatchObject({ attested: false });

    // 100.015 at 8 decimals = 10_001_500_000
    const positive = `0x${(10_001_500_000n).toString(16).padStart(64, "0")}`;
    // -1.5 at 8 decimals = -150_000_000 as two's complement
    const negative = `0x${((1n << 256n) - 150_000_000n).toString(16).padStart(64, "0")}`;

    expect(decodeToleranceValue(positive, 8)).toBe("100.015");
    expect(decodeToleranceValue(negative, 8)).toBe("-1.5");
    expect(decodeToleranceValue("0x1234", 8)).toBeUndefined();
  });
});
