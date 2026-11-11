/**
 * Reading a gateway round response (`POST /v1/round/execute`, `POST /v1/x402/execute`)
 * and deciding whether it is the round that was asked for. Both paths answer with the
 * same envelope, and neither lets the caller choose the round's timestamp.
 */
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
  const sameRequest =
    normalizeSourceId(String(data.sourceId ?? "")) === expected.sourceId &&
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
  const rendered = expected.output ? formatSourceValue(data.valuePacked, expected.output) : undefined;

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
      ...(preimage !== undefined ? { valuePreimage: preimage } : {})
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
