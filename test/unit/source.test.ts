import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import { normalizeError } from "../../src/errors.js";
import {
  deriveSourceId,
  formatSourceValue,
  guardSourceId,
  httpInputs,
  parseSource,
  resolveSourceId,
  singleHttpInput
} from "../../src/source.js";
import { CANONICAL_VECTORS } from "./source-vectors.js";
import { GOLDEN_CANONICAL, GOLDEN_SOURCE_ID, httpAndEvmSource, priceSource, twoHttpSource, word } from "./sources.js";

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

describe("sourceId derivation, held to the Go reference's vectors", () => {
  it.each(CANONICAL_VECTORS)("$name: canonical bytes and ID", ({ input, canonical, sourceId }) => {
    // Any key order and whitespace in, the reference's canonical bytes out.
    const derived = deriveSourceId(JSON.parse(input));

    expect(derived.canonicalJson).toBe(canonical);
    expect(derived.sourceId).toBe(sourceId);
    // sourceId = keccak256 of the canonical bytes, with no domain tag.
    expect(derived.sourceId).toBe(`0x${toHex(keccak_256(Buffer.from(canonical, "utf8")))}`);
    expect(JSON.stringify(derived.canonicalSource)).toBe(canonical);
  });

  it("derives the gateway's golden source (sourcetest.New(\"https://example.com\")) from its canonical form", () => {
    const derived = deriveSourceId(JSON.parse(GOLDEN_CANONICAL));

    expect(derived.canonicalJson).toBe(GOLDEN_CANONICAL);
    expect(derived.sourceId).toBe(GOLDEN_SOURCE_ID);
  });

  it("reports the declared output", () => {
    const outputs = Object.fromEntries(CANONICAL_VECTORS.map((v) => [v.name, deriveSourceId(JSON.parse(v.input)).output]));

    expect(outputs["http-tolerance"]).toEqual({ type: "int256", decimals: 8 });
    expect(outputs["starknet-call"]).toEqual({ type: "uint256", decimals: 18 });
    expect(outputs["keccak-output"]).toEqual({ type: "keccak256", decimals: 0 });
  });

  it("does not let key order leak into the preimage", () => {
    const px = priceSource({ url: "https://example.test/rate" }).doc as Record<string, unknown>;
    const shuffled = Object.fromEntries(Object.entries(px).reverse());

    expect(Object.keys(shuffled)).not.toEqual(Object.keys(px));
    expect(deriveSourceId(shuffled).canonicalJson).toBe(deriveSourceId(px).canonicalJson);
  });

  it("gives tolerance mode a different ID from exact mode", () => {
    const exact = priceSource({ url: "https://example.test/rate" });
    const tolerant = priceSource({ url: "https://example.test/rate", tolerance: { maxDeviationBps: "50", maxAgeMs: "2000" } });

    expect(tolerant.sourceId).not.toBe(exact.sourceId);
    expect(tolerant.canonical).toContain('"aggregation":{"maxAgeMs":"2000","maxDeviationBps":"50","mode":"tolerance","rule":"median"}');
    expect(exact.canonical).toContain('"aggregation":null');
  });
});

describe("parseSource", () => {
  const good = priceSource({ url: "https://example.test/rate" }).doc;

  it("names the field of a rejected source", () => {
    const number = structuredClone(good) as { output: { decimals: unknown } };
    number.output.decimals = 8;
    const missing = structuredClone(good) as Record<string, unknown>;
    delete missing.aggregation;
    const unknown = { ...good, extra: "x" };
    const version = { ...good, v: "2" };

    expect(() => parseSource(number)).toThrow(expect.objectContaining({ code: "invalid_source", path: "output.decimals", errorClass: "number" }));
    expect(() => parseSource(missing)).toThrow(expect.objectContaining({ code: "invalid_source", path: "aggregation", errorClass: "missing_key" }));
    expect(() => parseSource(unknown)).toThrow(expect.objectContaining({ code: "invalid_source", errorClass: "unknown_key" }));
    expect(() => parseSource(version)).toThrow(expect.objectContaining({ code: "invalid_source", path: "v" }));
  });

  it("refuses what is not a document", () => {
    for (const bad of [undefined, null, "{}", 7, []]) {
      expect(() => parseSource(bad)).toThrow(expect.objectContaining({ code: "invalid_source" }));
    }
  });

  it("never takes an object shaped like a parsed source for one", () => {
    // A caller can send any JSON. The SDK's `asParsedSource` would return this as is; the ID in it was never derived.
    const forged = { doc: good, canonical: "{}", idHex: `0x${"ab".repeat(32)}`, id: new Uint8Array(32), inputNames: [], output: {}, tolerance: false };

    expect(() => parseSource(forged)).toThrow(expect.objectContaining({ code: "invalid_source" }));
  });

  it("is reported as invalid_source, with the path as details, and a remediation", () => {
    const bad = { ...good, v: "2" };
    let caught: unknown;
    try {
      parseSource(bad);
    } catch (error) {
      caught = error;
    }

    expect(normalizeError(caught)).toMatchObject({ code: "invalid_source", details: { path: "v", errorClass: "value" } });
    expect(String(normalizeError(caught).remediation)).toContain("every number must be a string");
  });

  it("maps a raw SourceError from the SDK the same way", () => {
    const raw = Object.assign(new Error("source: inputs.px: missing_key: missing key"), { name: "SourceError", path: "inputs.px", errorClass: "missing_key" });

    expect(normalizeError(raw)).toMatchObject({ code: "invalid_source", details: { path: "inputs.px", errorClass: "missing_key" } });
  });
});

describe("sourceId guard", () => {
  const px = priceSource({ url: "https://example.test/rate" });

  it("accepts the derived ID with or without 0x, in any case", () => {
    expect(resolveSourceId(px.sourceId.toUpperCase().replace("0X", "0x"), px.doc)).toBe(px.sourceId);
    expect(resolveSourceId(px.bareId, px.doc)).toBe(px.sourceId);
    expect(resolveSourceId(undefined, px.doc)).toBe(px.sourceId);
  });

  it("refuses an ID that is not the source's", () => {
    expect(() => resolveSourceId("ff".repeat(32), px.doc)).toThrow(/sourceId does not match source: expected 0x[0-9a-f]{64}, got ff/);
    expect(() => guardSourceId("ff".repeat(32), parseSource(px.doc))).toThrow(/does not match source/);
  });

  it("takes a caller's own sourceId when no source is given, and needs one of the two", () => {
    expect(resolveSourceId(px.bareId.toUpperCase(), undefined)).toBe(px.sourceId);
    expect(() => resolveSourceId(undefined, undefined)).toThrow("either sourceId or source is required");
    expect(() => resolveSourceId("not-hex", undefined)).toThrow(/sourceId/);
  });
});

describe("http inputs", () => {
  it("finds the one http input beside chain inputs", () => {
    const parsed = parseSource(httpAndEvmSource("https://a.example.com/p").doc);

    expect(parsed.inputNames).toEqual(["px", "rate"]);
    expect(httpInputs(parsed).map((i) => i.name)).toEqual(["px"]);
    expect(singleHttpInput(parsed).read.url).toBe("https://a.example.com/p");
  });

  it("refuses a source with two, naming them, and one with none", () => {
    expect(() => singleHttpInput(parseSource(twoHttpSource().doc))).toThrow(
      expect.objectContaining({ code: "invalid_source", message: expect.stringContaining("this source has 2: a, b") })
    );
    const chainOnly = JSON.parse(CANONICAL_VECTORS.find((v) => v.name === "evm-call-sig")!.input);
    expect(() => singleHttpInput(parseSource(chainOnly))).toThrow(expect.objectContaining({ code: "invalid_source", message: expect.stringContaining("has 0") }));
  });
});

describe("formatSourceValue", () => {
  it("renders each output type as the source declares it", () => {
    expect(formatSourceValue(word(10_001_500_000n), { type: "int256", decimals: 8 })).toBe("100.015");
    expect(formatSourceValue(word(-150_000_000n), { type: "int256", decimals: 8 })).toBe("-1.5");
    expect(formatSourceValue(word(5n), { type: "uint256", decimals: 0 })).toBe("5");
    expect(formatSourceValue(word(1n), { type: "bool", decimals: 0 })).toBe("true");
    expect(formatSourceValue(word(0n), { type: "bool", decimals: 0 })).toBe("false");
    expect(formatSourceValue(`0x${Buffer.from("USDC").toString("hex").padEnd(64, "0")}`, { type: "string32", decimals: 0 })).toBe("USDC");
    expect(formatSourceValue(word(255n), { type: "bytes32", decimals: 0 })).toBe(word(255n));
  });

  it("takes the value with or without 0x, and is undefined for anything that is not 32 bytes", () => {
    expect(formatSourceValue(word(7n).slice(2), { type: "uint256", decimals: 0 })).toBe("7");
    expect(formatSourceValue("0x1234", { type: "int256", decimals: 8 })).toBeUndefined();
    expect(formatSourceValue(undefined, { type: "int256", decimals: 8 })).toBeUndefined();
  });
});
