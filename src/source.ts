import { normalizeSourceId, toCanonicalHex } from "./hex.js";
import { requireSdkExport } from "./sdk.js";

/**
 * A Molpha source and its identity, delegated to the SDK so the bytes match the gateway and the nodes.
 *
 * `sourceId = keccak256(canonical bytes)`, where the canonical form is a subset of RFC 8785 (JCS): UTF-8,
 * object keys sorted, no whitespace, strings escaped as `JSON.stringify` does, and no JSON numbers at all
 * (every numeric quantity is a string in a fixed grammar). The gateway and the SDK accept any key order and
 * whitespace and re-sort; a node requires the canonical bytes. Validation is the SDK's `parseSource`: a
 * rejected source carries the path of the offending field.
 *
 * Only the nodes evaluate a source. Nothing here, and nothing in this server, runs one.
 */

export type OutputType = "int256" | "uint256" | "bool" | "bytes32" | "string32" | "keccak256";

/** A source's declared output: how its transform result becomes the 32 signed bytes. */
export interface SourceOutput {
  type: OutputType;
  /** The scale of an int256/uint256 output; 0 for every other type. */
  decimals: number;
}

/** The SDK's `ParsedSource`: a validated source with its canonical form and ID. */
export interface ParsedSourceLike {
  /** The document, every key present. */
  doc: Record<string, unknown>;
  /** Canonical JSON text: the exact preimage of the sourceId. */
  canonical: string;
  bytes: Uint8Array;
  id: Uint8Array;
  /** `0x`-prefixed lowercase hex of `id`. */
  idHex: string;
  inputNames: string[];
  output: SourceOutput;
  /** Whether the source aggregates by median tolerance rather than requiring identical values. */
  tolerance: boolean;
}

/** The read of an http input, as the source format spells it. */
export interface HttpRead {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body: { contentType: string; text: string } | null;
}

/** An error about the caller's source. `path` names the offending field and never contains a secret. */
export function invalidSourceError(message: string, path = "", errorClass = "value"): Error {
  return Object.assign(new Error(message), { code: "invalid_source", path, errorClass });
}

/** Whether `error` is the SDK's `SourceError` (matched by name, as the SDK is a dynamically loaded export). */
export function isSourceError(error: unknown): error is Error & { path: string; errorClass?: string } {
  return error instanceof Error && error.name === "SourceError" && typeof (error as { path?: unknown }).path === "string";
}

function asSourceError(error: unknown): unknown {
  if (isSourceError(error)) {
    return invalidSourceError(error.message, error.path, typeof error.errorClass === "string" ? error.errorClass : "value");
  }
  return error;
}

/**
 * Validates a source document from a tool call with the SDK's strict `parseSource`. A rejected source
 * throws an `invalid_source` error whose `path` says where. Input is always parsed afresh, never taken as
 * an already parsed source: a caller can send any object, including one shaped like a parsed source whose
 * ID was never derived.
 */
export function parseSource(source: unknown): ParsedSourceLike {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw invalidSourceError("source: expected a source document (a JSON object)", "", "type");
  }
  try {
    return requireSdkExport<(input: object) => ParsedSourceLike>("parseSource")(source);
  } catch (error) {
    throw asSourceError(error);
  }
}

/** Refuses a tolerance-mode request the nodes would reject, before any gateway call or payment. */
export function assertToleranceQuorum(source: ParsedSourceLike, signaturesRequired: number): void {
  requireSdkExport<(src: ParsedSourceLike, quorum: number) => void>("assertToleranceQuorum")(source, signaturesRequired);
}

export interface DerivedSourceId {
  /** 32-byte sourceId, `0x`-prefixed lowercase hex. */
  sourceId: string;
  /** The canonical document: every key present, keys sorted, every number a string. */
  canonicalSource: Record<string, unknown>;
  /** The exact UTF-8 preimage hashed into `sourceId`. */
  canonicalJson: string;
  /** The declared output type and scale. */
  output: SourceOutput;
}

/** Validates `source` and derives its sourceId. */
export function deriveSourceId(source: unknown): DerivedSourceId {
  return describeSourceId(parseSource(source));
}

/** The identity of an already parsed source. */
export function describeSourceId(parsed: ParsedSourceLike): DerivedSourceId {
  return {
    sourceId: parsed.idHex,
    canonicalSource: canonicalSourceDocument(parsed),
    canonicalJson: parsed.canonical,
    output: parsed.output
  };
}

/** The source as the gateway should receive it: the canonical document, unchanged from what was hashed. */
export function canonicalSourceDocument(parsed: ParsedSourceLike): Record<string, unknown> {
  return JSON.parse(parsed.canonical) as Record<string, unknown>;
}

/** The parsed source's sourceId, after checking a caller-supplied `sourceId` guard against it. */
export function guardSourceId(sourceId: string | undefined, parsed: ParsedSourceLike): string {
  if (sourceId !== undefined && normalizeSourceId(sourceId) !== normalizeSourceId(parsed.idHex)) {
    throw new Error(`sourceId does not match source: expected ${parsed.idHex}, got ${sourceId}`);
  }
  return parsed.idHex;
}

/**
 * The sourceId a tool call refers to: derived from `source` when given (a caller-supplied `sourceId` must
 * then agree with it), else the caller's own.
 */
export function resolveSourceId(sourceId: string | undefined, source: unknown): string {
  if (source !== undefined && source !== null) {
    return guardSourceId(sourceId, parseSource(source));
  }

  if (sourceId === undefined) {
    throw new Error("either sourceId or source is required");
  }

  return toCanonicalHex(sourceId, 32, "sourceId");
}

/** A parsed source's http inputs, in name order. */
export function httpInputs(parsed: ParsedSourceLike): Array<{ name: string; read: HttpRead }> {
  const inputs = parsed.doc.inputs as Record<string, { kind?: unknown; read?: HttpRead }>;
  return parsed.inputNames.flatMap((name) => {
    const input = inputs[name];
    return input?.kind === "http" && input.read ? [{ name, read: input.read }] : [];
  });
}

/**
 * The one http input a payment, a source payment or a provider credential applies to. A payment names no
 * host, so it can only be attached to a source that fetches from exactly one.
 */
export function singleHttpInput(parsed: ParsedSourceLike): { name: string; read: HttpRead } {
  const http = httpInputs(parsed);
  if (http.length !== 1) {
    throw invalidSourceError(
      `A paid source needs exactly one http input (a payment names no host); this source has ${http.length}${
        http.length > 0 ? `: ${http.map((i) => i.name).join(", ")}` : ""
      }.`,
      "inputs"
    );
  }
  return http[0]!;
}

/**
 * Renders a signed 32-byte value the way the source's declared output reads it (a scaled integer, a bool,
 * a string32's text, or hex). Display only. Undefined when `valuePacked` is not 32 bytes of hex (`0x` optional).
 */
export function formatSourceValue(valuePacked: unknown, output: SourceOutput): string | undefined {
  if (typeof valuePacked !== "string" || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(valuePacked)) {
    return undefined;
  }
  const hex = valuePacked.startsWith("0x") ? valuePacked : `0x${valuePacked}`;
  return requireSdkExport<(value: string, output: SourceOutput) => string>("formatValue")(hex, output);
}
