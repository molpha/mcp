import { describe, expect, it } from "vitest";
import { checkSourceDeterminism } from "../../src/determinism.js";
import { decodeFeedValue, describeValueEncoding } from "../../src/feed.js";
import { assertToleranceQuorum, parseSource } from "../../src/source.js";
import { sourceSchema } from "../../src/tools/schemas.js";
import { prepareRound } from "../../src/tools/round.js";
import { CANONICAL_VECTORS } from "./source-vectors.js";
import { priceSource, word } from "./sources.js";
import { callTool, callToolError } from "./tool-harness.js";

const tolerance = { maxDeviationBps: "50", maxAgeMs: "2000" };
/** Median tolerance, int256 at 8 decimals. */
const tolerant = priceSource({ url: "https://example.test/rate", tolerance });
const exact = priceSource({ url: "https://example.test/rate" });
const httpTolerance = CANONICAL_VECTORS.find((v) => v.name === "http-tolerance")!;

describe("median tolerance mode: sourceId", () => {
  it("matches the Go reference's known-answer canonical form and digest", async () => {
    const out = await callTool("derive_source_id", { source: JSON.parse(httpTolerance.input) });

    expect(out.canonicalJson).toBe(httpTolerance.canonical);
    expect(out.sourceId).toBe(httpTolerance.sourceId);
    expect(out.canonicalSource).toMatchObject({ aggregation: { mode: "tolerance", rule: "median", maxDeviationBps: "50", maxAgeMs: "2000" } });
    expect(out.output).toEqual({ type: "int256", decimals: 8 });
  });

  it("makes exact and tolerance mode different feeds", () => {
    expect(tolerant.sourceId).not.toBe(exact.sourceId);
    expect(exact.canonical).toContain('"aggregation":null');
  });
});

describe("median tolerance mode: input validation", () => {
  it("is a permissive object at the tool boundary: the SDK validates", () => {
    expect(sourceSchema.safeParse(exact.doc).success).toBe(true);
    expect(sourceSchema.safeParse(tolerant.doc).success).toBe(true);
    expect(sourceSchema.safeParse("a source").success).toBe(false);
    expect(sourceSchema.safeParse([]).success).toBe(false);
  });

  it("is a plain record of unknowns, not a recursive schema", () => {
    // The transform is an expression tree; a recursive schema of it makes an enormous, fragile tool JSON Schema.
    expect(sourceSchema._def.typeName).toBe("ZodRecord");
    expect(sourceSchema._def.valueType._def.typeName).toBe("ZodUnknown");
    expect(sourceSchema.description).toContain("EVERY NUMBER IS A STRING");
    expect(sourceSchema.description).toContain("tolerance aggregation needs output.type int256 and signaturesRequired >= 3");
  });

  it("requires output int256 for tolerance, naming the field", async () => {
    const doc = structuredClone(tolerant.doc) as { output: { type: string } };
    doc.output = { type: "bool", decimals: null } as typeof doc.output;

    expect(await callToolError("derive_source_id", { source: doc })).toMatchObject({
      code: "invalid_source",
      details: { path: "aggregation" }
    });
  });

  it("rejects mode exact, other rules and JSON numbers in the aggregation", async () => {
    for (const [patch, path] of [
      [{ mode: "exact" }, "aggregation.mode"],
      [{ rule: "mean" }, "aggregation.rule"],
      [{ maxAgeMs: 2000 }, "aggregation.maxAgeMs"],
      [{ maxAgeMs: "0" }, "aggregation.maxAgeMs"]
    ] as const) {
      const doc = structuredClone(tolerant.doc) as { aggregation: Record<string, unknown> };
      Object.assign(doc.aggregation, patch);

      expect(await callToolError("derive_source_id", { source: doc }), JSON.stringify(patch)).toMatchObject({
        code: "invalid_source",
        details: { path }
      });
    }
  });

  it("requires at least 3 signatures", () => {
    expect(() => assertToleranceQuorum(parseSource(tolerant.doc), 2)).toThrow(/signaturesRequired >= 3/);
    expect(() => assertToleranceQuorum(parseSource(tolerant.doc), 3)).not.toThrow();
    expect(() => assertToleranceQuorum(parseSource(exact.doc), 1)).not.toThrow();
  });

  it("refuses a 2-signer tolerance round in the shared round preparation both round tools use", () => {
    const base = { source: tolerant.doc, chains: ["solana" as const] };

    expect(() => prepareRound({ ...base, signaturesRequired: 2 })).toThrow(/signaturesRequired >= 3/);
    expect(prepareRound({ ...base, signaturesRequired: 3 })).toBe(tolerant.sourceId);
    expect(prepareRound({ source: exact.doc, chains: ["solana"], signaturesRequired: 1 })).toBe(exact.sourceId);
  });

  it("refuses a round whose sourceId guard names another source, and a source the SDK rejects, before anything is sent", () => {
    const chains = ["solana" as const];
    const bad = structuredClone(exact.doc) as Record<string, unknown>;
    delete bad.transform;

    expect(() => prepareRound({ source: exact.doc, chains, signaturesRequired: 1, sourceId: tolerant.sourceId })).toThrow(/sourceId does not match source/);
    expect(() => prepareRound({ source: bad, chains, signaturesRequired: 1 })).toThrow(expect.objectContaining({ code: "invalid_source", path: "transform" }));
  });

  it("derive_source_id returns the aggregation in the canonical source and preimage", async () => {
    const out = await callTool("derive_source_id", { source: tolerant.doc });

    expect(out.sourceId).toBe(tolerant.sourceId);
    expect(out.canonicalSource).toMatchObject({ aggregation: { mode: "tolerance" } });
    expect(String(out.canonicalJson)).toContain('"aggregation":{"maxAgeMs":"2000"');
    // Keys sorted, as the canonical form requires.
    expect(Object.keys(out.canonicalSource as object)).toEqual(["aggregation", "assert", "inputs", "output", "transform", "v"]);
  });
});

describe("determinism heuristics", () => {
  const driftingUrl = "https://api.example.test/price/latest";

  it("does not warn about a live-drifting URL in tolerance mode, but does in exact mode", async () => {
    const drifting = priceSource({ url: driftingUrl });
    const median = priceSource({ url: driftingUrl, tolerance });

    expect((await checkSourceDeterminism(parseSource(drifting.doc))).warnings.length).toBeGreaterThan(0);
    expect(await checkSourceDeterminism(parseSource(median.doc))).toEqual({ ok: true, warnings: [] });
  });
});

describe("median tolerance mode: feed values", () => {
  const output = { type: "int256" as const, decimals: 8 };

  it("reports the scale as attested, from the source's declared output, and decodes a signed int256", () => {
    expect(describeValueEncoding(output)).toMatchObject({ attested: true, encoding: "int256", decimals: 8 });
    expect(String(describeValueEncoding(output).note)).toContain("10^8");

    // 100.015 at 8 decimals = 10_001_500_000; -1.5 = -150_000_000 as two's complement
    expect(decodeFeedValue(word(10_001_500_000n), output)).toBe("100.015");
    expect(decodeFeedValue(word(-150_000_000n), output)).toBe("-1.5");
    expect(decodeFeedValue("0x1234", output)).toBeUndefined();
  });

  it("states the scale only for numeric outputs", () => {
    expect(describeValueEncoding({ type: "bool", decimals: 0 })).not.toHaveProperty("decimals");
    expect(describeValueEncoding({ type: "keccak256", decimals: 0 })).toMatchObject({ attested: true, encoding: "keccak256" });
    expect(String(describeValueEncoding({ type: "keccak256", decimals: 0 }).note)).toContain("valuePreimage");
  });
});
