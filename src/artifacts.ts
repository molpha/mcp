/** Shape a gateway DataUpdateResult into the spec-friendly signed artifact. */

import { z } from "zod";
import { toCanonicalHex } from "./hex.js";

/*
 * The signed artifact is the canonical shape: the round tools emit it (and
 * advertise it in their outputSchema), and submit_attestation and
 * build_verifier_calldata accept it verbatim. These schemas are its one
 * definition. They describe widths rather than enforce them, because inputs are
 * zero-padded server-side and an output must never be rejected after a round
 * was paid for.
 */

export const signedDataUpdateSchema = z.object({
  sourceId: z.string().describe("32-byte sourceId, 0x-prefixed hex."),
  registryVersion: z.number().int().describe("Registry version whose node set signed the round."),
  signaturesRequired: z.number().int().describe("Quorum the aggregate signature satisfies."),
  value: z
    .string()
    .describe("Decimal rendering of valuePacked. Not signed on its own: the signature covers valuePacked."),
  valuePacked: z
    .string()
    .optional()
    .describe("32-byte packed value, 0x-prefixed hex — the value bytes the signature covers."),
  timestamp: z.number().int().describe("Gateway-assigned round time in unix MILLISECONDS; signed. Divide by 1000 for seconds.")
});

export const signedSignatureSchema = z.object({
  signature: z.string().describe("Aggregate Schnorr `s`, 32 bytes, 0x-prefixed hex."),
  commitment: z.string().describe("Nonce commitment address, 20 bytes, 0x-prefixed hex."),
  signersBitmap: z
    .string()
    .describe("32-byte big-endian bitmap of the signing nodes' registry indexes, 0x-prefixed hex; signed.")
});

/** The trust anchor: what submit_attestation and build_verifier_calldata need. */
export const signedAttestationSchema = z.object({
  dataUpdate: signedDataUpdateSchema,
  signature: signedSignatureSchema
});

/** Everything a live round returns about the signed result. */
export const signedArtifactSchema = z.object({
  value: z.string().describe("Convenience copy of dataUpdate.value. Do not consume it without the signature."),
  fresh: z.boolean().describe("Whether the value was freshly fetched this round. Not signed."),
  ...signedAttestationSchema.shape
});

export type DataUpdateArtifact = z.infer<typeof signedArtifactSchema>;

/** Fixed byte widths the SDK and the Solana program enforce on the flat result. */
const HEX_WIDTHS: Record<string, number> = {
  sourceId: 32,
  valuePacked: 32,
  s: 32,
  commitmentAddr: 20,
  signersBitmap: 32
};

/**
 * Flattens the two nested shapes a round can arrive in into the flat signed result this
 * server works with internally; a flat input is returned unchanged.
 *
 * - the SDK's `Attestation`: `{ payload: { value (packed), sourceId, ... timestamp },
 *   signature: { s, commitmentAddr, signersBitmap }, value (decimal), fresh }`
 * - the gateway's `data` body: `{ attestation: { payload, signature: { signature, commitment,
 *   signersBitmap } }, value (decimal), fresh, configHash, aggregation? }`
 */
export function flattenAttestation(input: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(input.attestation) ?? (asRecord(input.payload) ? input : undefined);
  const payload = asRecord(nested?.payload);
  if (!nested || !payload) {
    return input;
  }
  const signature = asRecord(nested.signature) ?? {};

  return {
    sourceId: payload.sourceId,
    value: input.value,
    valuePacked: payload.value,
    timestamp: payload.timestamp,
    registryVersion: payload.registryVersion,
    signaturesRequired: payload.signaturesRequired,
    signersBitmap: signature.signersBitmap,
    s: signature.s ?? signature.signature,
    commitmentAddr: signature.commitmentAddr ?? signature.commitment,
    fresh: input.fresh ?? true,
    ...(input.configHash !== undefined ? { configHash: input.configHash } : {}),
    ...(input.aggregation !== undefined ? { aggregation: input.aggregation } : {})
  };
}

/** The flat signed result as the SDK's `Attestation` (`submitAttestation`, the verifier-arg builders). */
export function toSdkAttestation(flat: Record<string, unknown>): Record<string, unknown> {
  return {
    payload: {
      value: flat.valuePacked,
      sourceId: flat.sourceId,
      registryVersion: Number(flat.registryVersion),
      signaturesRequired: Number(flat.signaturesRequired),
      timestamp: Number(flat.timestamp)
    },
    signature: {
      s: flat.s,
      commitmentAddr: flat.commitmentAddr,
      signersBitmap: flat.signersBitmap
    },
    value: String(flat.value ?? ""),
    fresh: Boolean(flat.fresh ?? true)
  };
}

/**
 * Canonicalize every fixed-width hex field on a signed result (flat, or nested as
 * {@link flattenAttestation} describes). `value` is a decimal string, not hex, and the
 * numeric fields are left alone.
 */
export function normalizeSignedResult(input: Record<string, unknown>): Record<string, unknown> {
  const raw = flattenAttestation(input);
  const out: Record<string, unknown> = { ...raw };

  for (const [field, bytes] of Object.entries(HEX_WIDTHS)) {
    const value = raw[field];
    if (value !== undefined && value !== null && value !== "") {
      out[field] = toCanonicalHex(String(value), bytes, field);
    }
  }

  return out;
}

/**
 * Accept either shape a caller can plausibly hold: the artifact this server
 * emits from `execute_subscription_round` / `execute_x402_round`
 * (`{ dataUpdate, signature }`) or the flat SDK/gateway shape
 * (`{ s, commitmentAddr, timestamp }`). Returns the flat shape with hex fields
 * canonicalized, so no tool needs a hand-written remap.
 */
export function toSignedResult(input: Record<string, unknown>): Record<string, unknown> {
  const dataUpdate = asRecord(input.dataUpdate);
  const signature = asRecord(input.signature);

  if (!dataUpdate && !signature) {
    return normalizeSignedResult(input);
  }

  const du = dataUpdate ?? {};
  const sig = signature ?? {};

  return normalizeSignedResult({
    sourceId: du.sourceId ?? input.sourceId,
    value: du.value ?? input.value,
    valuePacked: du.valuePacked ?? input.valuePacked,
    timestamp: du.timestamp ?? input.timestamp,
    registryVersion: du.registryVersion ?? input.registryVersion,
    signaturesRequired: du.signaturesRequired ?? input.signaturesRequired,
    signersBitmap: sig.signersBitmap ?? input.signersBitmap,
    s: sig.signature ?? sig.s ?? input.s,
    commitmentAddr: sig.commitment ?? sig.commitmentAddr ?? input.commitmentAddr,
    fresh: input.fresh ?? true
  });
}

export function toDataUpdateArtifact(result: Record<string, unknown>): DataUpdateArtifact {
  // Normalize on the way out so the artifact this server emits is byte-for-byte
  // acceptable to submit_attestation / build_verifier_calldata without caller-side padding.
  const normalized = normalizeSignedResult(result);

  return {
    value: String(normalized.value ?? ""),
    fresh: Boolean(normalized.fresh ?? true),
    dataUpdate: {
      sourceId: String(normalized.sourceId ?? ""),
      registryVersion: Number(normalized.registryVersion ?? 0),
      signaturesRequired: Number(normalized.signaturesRequired ?? 0),
      value: String(normalized.value ?? ""),
      ...(normalized.valuePacked !== undefined
        ? { valuePacked: String(normalized.valuePacked) }
        : {}),
      timestamp: Number(normalized.timestamp ?? 0)
    },
    signature: {
      signature: String(normalized.s ?? ""),
      commitment: String(normalized.commitmentAddr ?? ""),
      signersBitmap: String(normalized.signersBitmap ?? "")
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
