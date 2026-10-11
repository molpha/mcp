import { normalizeSourceId, toCanonicalHex } from "./hex.js";
import { requireSdkExport } from "./sdk.js";

/**
 * sourceId derivation, delegated to the SDK so the bytes match the gateway and
 * nodes: `sourceId = keccak256(canonicalJson)`, where `canonicalJson` is the
 * apiConfig with defaults applied (`method: "GET"`, `headers: {}`,
 * `valueTransform: ""`), header names sorted, serialized compactly with the keys
 * in the fixed order url, method, headers, responseParser, valueTransform and,
 * only in median tolerance mode, aggregation (mode, rule, maxDeviationBps,
 * maxAgeMs, numeric{type, decimals}).
 *
 * That fixed order is Go's struct-field order, not RFC 8785 (JCS): a generic JCS
 * canonicalizer sorts the top-level keys and hashes to a different id.
 */

export interface ApiConfigLike {
  url: string;
  method?: "GET" | "POST" | undefined;
  headers?: Record<string, string> | undefined;
  responseParser: string;
  valueTransform?: string | undefined;
  aggregation?: AggregationLike | undefined;
}

export interface AggregationLike {
  mode: "tolerance";
  rule: "median";
  maxDeviationBps: number;
  maxAgeMs: number;
  numeric: { type: "int256"; decimals: number };
}

/** Tolerance mode is a median over at least three signers; the node rejects fewer. */
export const MIN_TOLERANCE_SIGNATURES = 3;

/** Refuses a tolerance-mode request the nodes would reject, before any gateway call or payment. */
export function assertToleranceQuorum(apiConfig: Pick<ApiConfigLike, "aggregation"> | undefined, signaturesRequired: number): void {
  if (apiConfig?.aggregation && signaturesRequired < MIN_TOLERANCE_SIGNATURES) {
    throw new Error(
      `aggregation.mode "tolerance" needs signaturesRequired >= ${MIN_TOLERANCE_SIGNATURES}, got ${signaturesRequired}`
    );
  }
}

export interface DerivedSourceId {
  /** 32-byte sourceId, `0x`-prefixed lowercase hex. */
  sourceId: string;
  canonicalApiConfig: Record<string, unknown>;
  /** The exact UTF-8 preimage hashed into `sourceId`. */
  canonicalJson: string;
}

export function canonicalizeApiConfig(apiConfig: ApiConfigLike): Record<string, unknown> {
  return requireSdkExport<(cfg: ApiConfigLike) => Record<string, unknown>>("canonicalizeAPIConfig")(apiConfig);
}

export function deriveSourceId(apiConfig: ApiConfigLike): DerivedSourceId {
  const canonicalApiConfig = canonicalizeApiConfig(apiConfig);
  const sourceId = requireSdkExport<(cfg: ApiConfigLike) => string>("deriveSourceIdString")(apiConfig);

  return {
    sourceId: `0x${sourceId}`,
    canonicalApiConfig,
    // The SDK hashes JSON.stringify of its canonical object; test vectors pin both.
    canonicalJson: JSON.stringify(canonicalApiConfig)
  };
}

/**
 * The sourceId a tool call refers to: derived from `apiConfig` when given (a
 * caller-supplied `sourceId` must then agree with it), else the caller's own.
 */
export function resolveSourceId(sourceId: string | undefined, apiConfig: ApiConfigLike | undefined): string {
  if (apiConfig) {
    const derived = deriveSourceId(apiConfig).sourceId;
    if (sourceId !== undefined && normalizeSourceId(sourceId) !== normalizeSourceId(derived)) {
      throw new Error(`sourceId does not match apiConfig: expected ${derived}, got ${sourceId}`);
    }
    return derived;
  }

  if (sourceId === undefined) {
    throw new Error("either sourceId or apiConfig is required");
  }

  return toCanonicalHex(sourceId, 32, "sourceId");
}
