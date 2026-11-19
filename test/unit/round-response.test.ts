import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { readRoundResponse } from "../../src/round-response.js";
import { buildRoundResult } from "../../src/tools/round.js";

// A policy's fallback (node-client docs/policy.md) is an ordinary value under S; the gateway labels it.
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
  it("matches a fallback round under S, renders the fallback as a value and keeps the label", () => {
    const r = readRoundResponse(body(S, "ff".repeat(32), { outcome: "fallback", reason: "0x01" }), expected, now);
    expect(r.matches).toBe(true);
    expect(r.result.value).toBe("-1");
    expect(r.result.outcome).toBe("fallback");
    expect(r.result.reason).toBe("0x01");
  });

  it("labels a conclusive policy round and renders its value", () => {
    const r = readRoundResponse(body(S, "00".repeat(31) + "0a", { outcome: "conclusive" }), expected, now);
    expect(r.matches).toBe(true);
    expect(r.result.value).toBe("10");
    expect(r.result.outcome).toBe("conclusive");
    expect(r.result.reason).toBeUndefined();
  });

  it("does not match a round under another source ID, whatever its label", () => {
    expect(readRoundResponse(body("22".repeat(32), "ff".repeat(32), { outcome: "fallback", reason: "0x01" }), expected, now).matches).toBe(false);
  });

  it("drops an unknown label", () => {
    const r = readRoundResponse(body(S, "00".repeat(31) + "0a", { outcome: "inconclusive", reason: "0x01" }), expected, now);
    expect(r.result.outcome).toBeUndefined();
    expect(r.result.reason).toBeUndefined();
  });
});

describe("buildRoundResult with a policy outcome", () => {
  const config = loadConfig({ GATEWAY_ENDPOINTS: "http://gateway.test", SOLANA_RPC: "http://solana.test" });

  it("emits the fallback label and reason in the round tools' output", async () => {
    const r = readRoundResponse(body(S, "ff".repeat(32), { outcome: "fallback", reason: "0x01" }), expected, now);
    const out = await buildRoundResult(r.result, [], config, "subscription", false);
    expect(out).toMatchObject({ value: "-1", outcome: "fallback", reason: "0x01" });
  });

  it("emits a conclusive label without a reason", async () => {
    const r = readRoundResponse(body(S, "00".repeat(31) + "0a", { outcome: "conclusive" }), expected, now);
    const out = await buildRoundResult(r.result, [], config, "x402", false);
    expect(out).toMatchObject({ value: "10", outcome: "conclusive" });
    expect(out).not.toHaveProperty("reason");
  });

  it("emits no label for a source without a policy", async () => {
    const r = readRoundResponse(body(S, "00".repeat(31) + "0a"), expected, now);
    const out = await buildRoundResult(r.result, [], config, "subscription", false);
    expect(out).not.toHaveProperty("outcome");
    expect(out).not.toHaveProperty("reason");
  });
});
