import { describe, expect, it } from "vitest";
import { flattenAttestation, normalizeSignedResult, toAttestationArtifact, toSdkAttestation } from "../../src/artifacts.js";

const payload = {
  value: "ab".repeat(32),
  sourceId: "11".repeat(32),
  registryVersion: 4,
  signaturesRequired: 3,
  timestamp: 1_700_000_000
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
      timestamp: 1_700_000_000,
      registryVersion: 4,
      signaturesRequired: 3,
      signersBitmap: "e",
      s: "22".repeat(32),
      commitmentAddr: "33".repeat(20),
      fresh: false
    });
  });

  it("flattens the gateway body (attestation.signature / commitment), which carries no configHash or aggregation", () => {
    const flat = flattenAttestation({
      attestation: { payload, signature: { signature: "22".repeat(32), commitment: "33".repeat(20), signersBitmap: "e" } },
      value: "42",
      fresh: true
    });

    expect(flat).toEqual({
      sourceId: payload.sourceId,
      value: "42",
      valuePacked: payload.value,
      timestamp: 1_700_000_000,
      registryVersion: 4,
      signaturesRequired: 3,
      signersBitmap: "e",
      s: "22".repeat(32),
      commitmentAddr: "33".repeat(20),
      fresh: true
    });
    expect(flat).not.toHaveProperty("configHash");
    expect(flat).not.toHaveProperty("aggregation");
  });

  it("keeps a keccak256 output's preimage, in either shape, and normalizes its spelling", () => {
    const gateway = flattenAttestation({
      attestation: { payload, signature: { signature: "22".repeat(32), commitment: "33".repeat(20), signersBitmap: "e" } },
      value: `0x${payload.value}`,
      fresh: true,
      valuePreimage: "0x68656C6C6F"
    });
    const sdk = flattenAttestation({
      payload,
      signature: { s: "22".repeat(32), commitmentAddr: "33".repeat(20), signersBitmap: "e" },
      value: "x",
      fresh: true,
      valuePreimage: "0x68656c6c6f"
    });

    expect(gateway.valuePreimage).toBe("0x68656C6C6F");
    expect(sdk.valuePreimage).toBe("0x68656c6c6f");
    expect(normalizeSignedResult(gateway).valuePreimage).toBe("0x68656c6c6f");
    expect(normalizeSignedResult({ ...gateway, valuePreimage: "68656c6c6f" }).valuePreimage).toBe("0x68656c6c6f");
    expect(() => normalizeSignedResult({ ...gateway, valuePreimage: "0xabc" })).toThrow(/valuePreimage/);
    expect(toSdkAttestation(normalizeSignedResult(gateway))).toMatchObject({ valuePreimage: "0x68656c6c6f" });
    expect(toAttestationArtifact(normalizeSignedResult(gateway))).toMatchObject({ valuePreimage: "0x68656c6c6f" });
  });

  it("leaves no preimage field where there is none", () => {
    const flat = normalizeSignedResult({ sourceId: "1", value: "1", valuePacked: "2", s: "3", commitmentAddr: "4", signersBitmap: "5", timestamp: 1, valuePreimage: "" });

    expect(flat).not.toHaveProperty("valuePreimage");
    expect(toSdkAttestation(flat)).not.toHaveProperty("valuePreimage");
    expect(toAttestationArtifact(flat)).not.toHaveProperty("valuePreimage");
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
      timestamp: 1_700_000_000,
      registryVersion: 4,
      signaturesRequired: 3,
      signersBitmap: "e",
      s: "22".repeat(32),
      commitmentAddr: "33".repeat(20),
      fresh: true
    });

    expect(normalizeSignedResult(toSdkAttestation(flat))).toEqual(flat);
    expect(toSdkAttestation(flat)).toMatchObject({ payload: { timestamp: 1_700_000_000, signaturesRequired: 3 }, signature: { s: flat.s } });
  });
});
