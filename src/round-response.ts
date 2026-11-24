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
  /**
   * The requested source's fallback words ({@link policyFallbackWords}) when it has a policy. With them the
   * outcome is read from the signed value: a value among them is the fallback, anything else conclusive.
   * Without them (no policy) no outcome is reported, whatever the gateway's unsigned label says.
   */
  fallbackWords?: string[];
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
      ...(preimage !== undefined ? { valuePreimage: preimage } : {}),
      ...policyOutcome(data, expected.fallbackWords)
    }
  };
}

/**
 * A policy round's outcome, from the signed value (as the SDK's `readOutcome` reads it): a value among the
 * source's fallback words is its fallback, anything else conclusive. The gateway's label is unsigned: it only
 * supplies the reason, and only when it also says fallback. A source without a policy has no outcome.
 */
export function policyOutcome(
  data: Record<string, unknown>,
  fallbackWords: string[] | undefined
): { outcome?: "conclusive" | "fallback"; reason?: string } {
  if (fallbackWords === undefined) {
    return {};
  }
  const value = "0x" + String(data.valuePacked ?? "").replace(/^0[xX]/, "").toLowerCase();
  if (!fallbackWords.includes(value)) {
    return { outcome: "conclusive" };
  }
  const reason = data.outcome === "fallback" && typeof data.reason === "string" && /^0x[0-9a-f]{2}$/i.test(data.reason)
    ? data.reason.toLowerCase()
    : undefined;
  return { outcome: "fallback", ...(reason !== undefined ? { reason } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
