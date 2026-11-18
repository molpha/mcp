import { describe, expect, it } from "vitest";
import { inconclusiveIdHex, readRoundResponse } from "../../src/round-response.js";

// A policy's INCONCLUSIVE result (node-client docs/policy.md) is signed under I(S), its value the reason.
const S = "11".repeat(32);
const now = Date.now();
const body = (sourceId: string, valuePacked: string, extra: Record<string, unknown> = {}) => ({
  status: "completed",
  data: {
    attestation: {
      payload: { value: valuePacked, sourceId, registryVersion: 4, signaturesRequired: 3, timestamp: now },
      signature: { signature: "aa".repeat(32), commitment: "bb".repeat(20), signersBitmap: "00".repeat(31) + "0e" }
    },
    value: "x",
    fresh: true,
    ...extra
  }
});
const expected = { sourceId: S, registryVersion: 4, signaturesRequired: 3, output: { type: "int256", decimals: 0 } as const };

describe("readRoundResponse with a policy outcome", () => {
  it("derives I(S) as the node does", () => {
    // new/source/testdata/policy-vectors.json
    expect(inconclusiveIdHex("e371e37c37d592464b293ce89100c4c87ddcb667b901739c60827789b200b8af")).toBe(
      "f0f8a58c104feffc9dc7dbb32452ec9829d7d63ee8bcc1a41ba2c5784a29a9ce"
    );
  });

  it("matches an INCONCLUSIVE round under I(S) and shows the reason, never a value", () => {
    const r = readRoundResponse(
      body(inconclusiveIdHex(S), "00".repeat(31) + "01", { outcome: "inconclusive", reason: "0x01", sourceId: S }),
      expected,
      now
    );
    expect(r.matches).toBe(true);
    expect(r.result.value).toBe("inconclusive 0x01");
    expect(r.result.outcome).toBe("inconclusive");
    expect(r.result.reason).toBe("0x01");
    expect(r.result.roundSourceId).toBe(S);
  });

  it("does not match I(S) without the outcome, or another derivation", () => {
    expect(readRoundResponse(body(inconclusiveIdHex(S), "00".repeat(31) + "01"), expected, now).matches).toBe(false);
    const twice = inconclusiveIdHex(inconclusiveIdHex(S));
    expect(readRoundResponse(body(twice, "00".repeat(31) + "01", { outcome: "inconclusive" }), expected, now).matches).toBe(false);
  });

  it("refuses an INCONCLUSIVE value that is not a reason", () => {
    expect(() =>
      readRoundResponse(body(inconclusiveIdHex(S), "ff".repeat(32), { outcome: "inconclusive" }), expected, now)
    ).toThrow(/reason/);
  });

  it("labels a conclusive policy round and renders its value", () => {
    const r = readRoundResponse(body(S, "00".repeat(31) + "0a", { outcome: "conclusive", sourceId: S }), expected, now);
    expect(r.matches).toBe(true);
    expect(r.result.value).toBe("10");
    expect(r.result.outcome).toBe("conclusive");
  });
});
