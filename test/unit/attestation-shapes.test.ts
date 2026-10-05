import { describe, expect, it } from "vitest";
import { flattenAttestation, normalizeSignedResult, toSdkAttestation } from "../../src/artifacts.js";

const payload = {
  value: "ab".repeat(32),
  sourceId: "11".repeat(32),
  registryVersion: 4,
  signaturesRequired: 3,
  timestamp: 1_700_000_000_000
};

describe("attestation shapes", () => {
  it("flattens the SDK Attestation (s / commitmentAddr)", () => {
    const flat = flattenAttestation({
      payload,
      signature: { s: "22".repeat(32), commitmentAddr: "33".repeat(20), signersBitmap: "e" },
      value: "100.125",
      fresh: false
    });

    expect(flat).toEqual({
      sourceId: payload.sourceId,
      value: "100.125",
      valuePacked: payload.value,
      timestamp: 1_700_000_000_000,
      registryVersion: 4,
      signaturesRequired: 3,
      signersBitmap: "e",
      s: "22".repeat(32),
      commitmentAddr: "33".repeat(20),
      fresh: false
    });
  });

  it("flattens the gateway body (attestation.signature / commitment) and keeps tolerance metadata", () => {
    const aggregation = { mode: "tolerance", rule: "median" };
    const flat = flattenAttestation({
      attestation: { payload, signature: { signature: "22".repeat(32), commitment: "33".repeat(20), signersBitmap: "e" } },
      value: "42",
      fresh: true,
      configHash: payload.sourceId,
      aggregation
    });

    expect(flat).toMatchObject({ s: "22".repeat(32), commitmentAddr: "33".repeat(20), valuePacked: payload.value, configHash: payload.sourceId, aggregation });
  });

  it("leaves a flat result alone, and normalizes hex widths for every shape", () => {
    const flat = { sourceId: "1", value: "1", valuePacked: "2", s: "3", commitmentAddr: "4", signersBitmap: "5", timestamp: 1 };

    expect(flattenAttestation(flat)).toBe(flat);
    expect(normalizeSignedResult(flat)).toMatchObject({ signersBitmap: `0x${"5".padStart(64, "0")}`, commitmentAddr: `0x${"4".padStart(40, "0")}` });
    expect(
      normalizeSignedResult({ payload, signature: { s: "22".repeat(32), commitmentAddr: "33".repeat(20), signersBitmap: "e" }, value: "1", fresh: true })
    ).toMatchObject({ signersBitmap: `0x${"e".padStart(64, "0")}`, valuePacked: `0x${payload.value}` });
  });

  it("round-trips flat -> SDK Attestation -> flat", () => {
    const flat = normalizeSignedResult({
      sourceId: payload.sourceId,
      value: "7",
      valuePacked: payload.value,
      timestamp: 1_700_000_000_000,
      registryVersion: 4,
      signaturesRequired: 3,
      signersBitmap: "e",
      s: "22".repeat(32),
      commitmentAddr: "33".repeat(20),
      fresh: true
    });

    expect(normalizeSignedResult(toSdkAttestation(flat))).toEqual(flat);
    expect(toSdkAttestation(flat)).toMatchObject({ payload: { timestamp: 1_700_000_000_000, signaturesRequired: 3 }, signature: { s: flat.s } });
  });
});
