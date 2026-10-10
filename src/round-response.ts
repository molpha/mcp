/**
 * Reading a gateway round response (`POST /v1/round/execute`, `POST /v1/x402/execute`)
 * and deciding whether it is the round that was asked for. Both paths answer with the
 * same envelope, and neither lets the caller choose the round's timestamp.
 */
import { flattenAttestation } from "./artifacts.js";
import { normalizeSourceId } from "./hex.js";

/** How far a returned round's gateway-assigned timestamp may sit from this host's clock. */
const ROUND_CLOCK_TOLERANCE_MS = 120_000;

export interface ExpectedRound {
  /** Bare lowercase hex. */
  sourceId: string;
  registryVersion: number;
  signaturesRequired: number;
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
 */
export function readRoundResponse(body: Record<string, unknown>, expected: ExpectedRound, startedAtMs: number): RoundResponse {
  const data = flattenAttestation(asRecord(body.data) ?? {});
  const timestamp = Number(data.timestamp);
  const sameRequest =
    normalizeSourceId(String(data.sourceId ?? "")) === expected.sourceId &&
    Number(data.registryVersion) === expected.registryVersion &&
    Number(data.signaturesRequired) === expected.signaturesRequired;
  const stampedNow =
    Number.isSafeInteger(timestamp) &&
    timestamp >= startedAtMs - ROUND_CLOCK_TOLERANCE_MS &&
    timestamp <= Date.now() + ROUND_CLOCK_TOLERANCE_MS;

  return {
    matches: sameRequest && stampedNow,
    result: {
      sourceId: data.sourceId,
      value: data.value,
      valuePacked: data.valuePacked,
      timestamp: data.timestamp,
      registryVersion: data.registryVersion,
      signaturesRequired: data.signaturesRequired,
      configHash: data.configHash,
      signersBitmap: data.signersBitmap,
      s: data.s,
      commitmentAddr: data.commitmentAddr,
      fresh: data.fresh ?? true,
      ...(data.aggregation !== undefined ? { aggregation: data.aggregation } : {})
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
