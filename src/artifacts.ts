/** Shape a round's signed result into the tool-facing attestation artifact. */

import { z } from "zod";
import { toCanonicalHex } from "./hex.js";

/*
 * The signed artifact is the canonical shape: the round tools emit it (and
 * advertise it in their outputSchema), and submit_attestation and
 * build_verifier_calldata accept it verbatim. It is the gateway's round body
 * (`attestation: { payload, signature }` plus the unsigned `value` and `fresh`),
 * which is also the cross-VM `Attestation` the verifiers take. These schemas are
 * its one definition. They describe widths rather than enforce them, because
 * inputs are zero-padded server-side and an output must never be rejected after
 * a round was paid for.
 */

export const attestationPayloadSchema = z.object({
  value: z
    .string()
    .describe("32-byte packed value, 0x-prefixed hex — the value bytes the signature covers."),
  sourceId: z.string().describe("32-byte sourceId, 0x-prefixed hex."),
  registryVersion: z.number().int().describe("Registry version whose node set signed the round."),
  signaturesRequired: z.number().int().describe("Quorum the aggregate signature satisfies."),
  timestamp: z.number().int().describe("Round timestamp in unix MILLISECONDS, assigned by the gateway; signed. Divide by 1000 to compare with a clock in seconds.")
});

export const attestationSignatureSchema = z.object({
  signature: z.string().describe("Aggregate Schnorr `s`, 32 bytes, 0x-prefixed hex."),
  commitment: z.string().describe("Nonce commitment address, 20 bytes, 0x-prefixed hex."),
  signersBitmap: z
    .string()
    .describe("32-byte big-endian bitmap of the signing nodes' registry indexes, 0x-prefixed hex; signed.")
});

/** The signed struct: what the verifiers and the Solana program check. */
export const attestationSchema = z.object({
  payload: attestationPayloadSchema,
  signature: attestationSignatureSchema
});

/** The trust anchor: what submit_attestation and build_verifier_calldata need. */
export const signedAttestationSchema = z.object({
  attestation: attestationSchema
});

/** Everything a live round returns about the signed result. */
export const signedArtifactSchema = z.object({
  value: z
    .string()
    .describe(
      "Display string for attestation.payload.value, rendered from the source's declared output (a scaled decimal for int256/uint256, true/false for bool, text for string32, else hex). Not signed on its own: do not consume it without the attestation."
    ),
  fresh: z.boolean().describe("Whether the value was freshly fetched this round. Not signed."),
  valuePreimage: z
    .string()
    .optional()
    .describe(
      "keccak256 outputs only: the 0x-hex bytes whose keccak256 is attestation.payload.value. The gateway keeps no copy, so this response is the only one: keep it. submit_attestation stores it (at most 256 bytes) as the feed's raw value. Not signed; it is bound by hashing to the signed value."
    ),
  ...signedAttestationSchema.shape
});

export type AttestationPayload = z.infer<typeof attestationPayloadSchema>;
export type AttestationSignature = z.infer<typeof attestationSignatureSchema>;
export type AttestationArtifact = z.infer<typeof signedArtifactSchema>;

/** Fixed byte widths the SDK and the Solana program enforce on the flat result. */
const HEX_WIDTHS: Record<string, number> = {
  sourceId: 32,
  valuePacked: 32,
  s: 32,
  commitmentAddr: 20,
  signersBitmap: 32
};

/**
 * Flattens the nested shapes a round can arrive in into the flat signed result this
 * server works with internally; a flat input is returned unchanged.
 *
 * - the SDK's `Attestation`: `{ payload: { value (packed), sourceId, ... timestamp },
 *   signature: { s, commitmentAddr, signersBitmap }, value (decimal), fresh }`
 * - the gateway's `data` body: `{ attestation: { payload, signature: { signature, commitment,
 *   signersBitmap } }, value (display string), fresh, valuePreimage? }` — which is also
 *   the artifact the round tools emit, so a round's output is accepted back verbatim
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
    // The gateway stamps `timestamp` (unix ms); the pinned SDK still names it `timestamp`.
    timestamp: payload.timestamp,
    registryVersion: payload.registryVersion,
    signaturesRequired: payload.signaturesRequired,
    signersBitmap: signature.signersBitmap,
    s: signature.s ?? signature.signature,
    commitmentAddr: signature.commitmentAddr ?? signature.commitment,
    fresh: input.fresh ?? true,
    ...(typeof input.valuePreimage === "string" && input.valuePreimage !== "" ? { valuePreimage: input.valuePreimage } : {})
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
      timestamp: Number(flat.timestamp),
    },
    signature: {
      s: flat.s,
      commitmentAddr: flat.commitmentAddr,
      signersBitmap: flat.signersBitmap
    },
    value: String(flat.value ?? ""),
    fresh: Boolean(flat.fresh ?? true),
    // A keccak256 output's preimage: the SDK passes it to the program as the raw value (at most 256 bytes).
    ...(typeof flat.valuePreimage === "string" && flat.valuePreimage !== "" ? { valuePreimage: flat.valuePreimage } : {})
  };
}

/**
 * Accept any shape a caller can plausibly hold (flat, or nested as
 * {@link flattenAttestation} describes) and return the flat shape with every
 * fixed-width hex field canonicalized, so no tool needs a hand-written remap.
 * `value` is a display string, not hex, and the numeric fields are left alone;
 * `valuePreimage` is variable-length hex, `0x`-prefixed.
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

  if (typeof out.valuePreimage === "string" && out.valuePreimage !== "") {
    out.valuePreimage = toPreimageHex(out.valuePreimage);
  } else {
    delete out.valuePreimage;
  }

  return out;
}

/** `0x` + lowercase whole-byte hex; a value that is not hex is corruption, not a format nit. */
function toPreimageHex(value: string): string {
  const clean = value.trim().replace(/^0[xX]/, "").toLowerCase();
  if (!/^(?:[0-9a-f]{2})+$/.test(clean)) {
    throw new Error("valuePreimage: expected whole bytes of hex");
  }
  return `0x${clean}`;
}

/**
 * The artifact the round tools emit: the gateway's round body, with every
 * fixed-width hex field canonicalized.
 */
export function toAttestationArtifact(result: Record<string, unknown>): AttestationArtifact {
  // Normalize on the way out so the artifact this server emits is byte-for-byte
  // acceptable to submit_attestation / build_verifier_calldata without caller-side padding.
  const normalized = normalizeSignedResult(result);

  return {
    value: String(normalized.value ?? ""),
    fresh: Boolean(normalized.fresh ?? true),
    ...(typeof normalized.valuePreimage === "string" ? { valuePreimage: normalized.valuePreimage } : {}),
    attestation: {
      payload: {
        value: String(normalized.valuePacked ?? ""),
        sourceId: String(normalized.sourceId ?? ""),
        registryVersion: Number(normalized.registryVersion ?? 0),
        signaturesRequired: Number(normalized.signaturesRequired ?? 0),
        timestamp: Number(normalized.timestamp ?? 0)
      },
      signature: {
        signature: String(normalized.s ?? ""),
        commitment: String(normalized.commitmentAddr ?? ""),
        signersBitmap: String(normalized.signersBitmap ?? "")
      }
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
