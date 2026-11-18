/**
 * Reading a gateway round response (`POST /v1/round/execute`, `POST /v1/x402/execute`)
 * and deciding whether it is the round that was asked for. Both paths answer with the
 * same envelope, and neither lets the caller choose the round's timestamp.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { flattenAttestation } from "./artifacts.js";
import { normalizeSourceId } from "./hex.js";
import { requireSdkExport } from "./sdk.js";
import { formatSourceValue, type SourceOutput } from "./source.js";

/** How far a returned round's gateway-assigned timestamp may sit from this host's clock. */
const ROUND_CLOCK_TOLERANCE_MS = 120_000;

export interface ExpectedRound {
  /** Bare lowercase hex. */
  sourceId: string;
  registryVersion: number;
  signaturesRequired: number;
  /**
   * The requested source's declared output. With it, `value` is rendered here from the signed bytes
   * rather than taken as the gateway sent it, and a `keccak256` preimage is checked to hash to them.
   */
  output?: SourceOutput;
}

export interface RoundResponse {
  /** Whether the aggregate is for the requested source, quorum and registry version, stamped around now. */
  matches: boolean;
  /** The flat signed result, in the shape buildRoundResult consumes. */
  result: Record<string, unknown>;
}

/**
 * Flattens the gateway's `data` (the signed struct is nested as `data.attestation`) and
 * checks it against the request. The gateway stamps the round itself, in unix
 * milliseconds on the round tick grid, so the timestamp can only be checked for
 * plausibility: a value in seconds, or an aggregate replayed from another time, does
 * not pass.
 *
 * `value` is display only. When the request's output is known it is rendered from the signed
 * `payload.value` (the SDK does the same on the subscription path); a `valuePreimage` is accepted only
 * for a keccak256 output and only if it hashes to the signed value.
 */
export function readRoundResponse(body: Record<string, unknown>, expected: ExpectedRound, startedAtMs: number): RoundResponse {
  const data = flattenAttestation(asRecord(body.data) ?? {});
  const timestamp = Number(data.timestamp);
  // A policy's INCONCLUSIVE result is signed under I(S), its value the reason (node-client docs/policy.md).
  const signed = normalizeSourceId(String(data.sourceId ?? ""));
  const inconclusive = data.outcome === "inconclusive" && signed === inconclusiveIdHex(expected.sourceId);
  const reasonWord = /^0{62}([0-9a-f]{2})$/.exec(normalizeSourceId(String(data.valuePacked ?? "")));
  if (inconclusive && (!reasonWord || reasonWord[1] === "00")) {
    throw new Error("an INCONCLUSIVE attestation's value must be its reason code");
  }
  const sameRequest =
    (signed === expected.sourceId || inconclusive) &&
    Number(data.registryVersion) === expected.registryVersion &&
    Number(data.signaturesRequired) === expected.signaturesRequired;
  const stampedNow =
    Number.isSafeInteger(timestamp) &&
    timestamp >= startedAtMs - ROUND_CLOCK_TOLERANCE_MS &&
    timestamp <= Date.now() + ROUND_CLOCK_TOLERANCE_MS;

  const preimage = typeof data.valuePreimage === "string" && data.valuePreimage !== "" ? data.valuePreimage : undefined;
  if (preimage !== undefined && expected.output) {
    if (expected.output.type !== "keccak256") {
      throw new Error("the gateway returned a value preimage, but the source's output is not keccak256");
    }
    const verify = requireSdkExport<(valuePacked: string, preimageHex: string) => boolean>("verifyPreimage");
    if (!verify(String(data.valuePacked ?? ""), preimage)) {
      throw new Error("the gateway's value preimage does not hash to the signed value");
    }
  }
  const rendered = inconclusive
    ? `inconclusive 0x${reasonWord![1]}`
    : expected.output
      ? formatSourceValue(data.valuePacked, expected.output)
      : undefined;

  return {
    matches: sameRequest && stampedNow,
    result: {
      sourceId: data.sourceId,
      value: rendered ?? data.value,
      valuePacked: data.valuePacked,
      timestamp: data.timestamp,
      registryVersion: data.registryVersion,
      signaturesRequired: data.signaturesRequired,
      signersBitmap: data.signersBitmap,
      s: data.s,
      commitmentAddr: data.commitmentAddr,
      fresh: data.fresh ?? true,
      ...(preimage !== undefined ? { valuePreimage: preimage } : {}),
      ...(typeof data.outcome === "string" ? { outcome: data.outcome } : {}),
      ...(inconclusive ? { reason: `0x${reasonWord![1]}` } : {}),
      ...(typeof data.roundSourceId === "string" ? { roundSourceId: data.roundSourceId } : {})
    }
  };
}

const INCONCLUSIVE_TAG = new TextEncoder().encode("MOLPHA_INCONCLUSIVE_V1");

/** I(S) = keccak256("MOLPHA_INCONCLUSIVE_V1" || S), bare lowercase hex. */
export function inconclusiveIdHex(sourceIdHex: string): string {
  const s = normalizeSourceId(sourceIdHex);
  const b = new Uint8Array(INCONCLUSIVE_TAG.length + 32);
  b.set(INCONCLUSIVE_TAG);
  for (let i = 0; i < 32; i++) b[INCONCLUSIVE_TAG.length + i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return Array.from(keccak_256(b), (x) => x.toString(16).padStart(2, "0")).join("");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
