/**
 * Molpha Data client: the template catalog, derivation, and unsigned reads. The service expands
 * templates; this server never does. Every source it returns is parsed and re-hashed with the SDK
 * (`parseSource`), and a source that does not hash to its sourceId is refused, so a value or a round is
 * never tied to a source it does not belong to. Signed reads do not go through the service: the tools
 * run the derived source through this server's own round tools, with their guardrails.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { DEFAULT_DATA_URL, type MolphaConfig } from "./config.js";
import { parseSource, type ParsedSourceLike } from "./source.js";

const REQUEST_TIMEOUT_MS = 30_000;

export interface DataTemplateParam {
  name: string;
  type: string;
  required?: boolean;
  default?: string;
  enum?: string[];
  doc: string;
}

export interface DataTemplate {
  id: string;
  version: number;
  ref: string;
  class: string;
  title: string;
  summary: string;
  kinds: string[];
  chains?: string[];
  params: DataTemplateParam[];
  returns: string;
  caveats?: string[];
  example: Record<string, string>;
  path?: string;
}

export type DataRequest = { template: string; params: Record<string, string> } | { source: Record<string, unknown> };

export interface DerivedSource {
  sourceId: string;
  source: Record<string, unknown>;
  canonical: string;
  mode: string;
  template?: string;
  params?: Record<string, string>;
  chain?: string;
  facts?: Record<string, string>;
  parsed: ParsedSourceLike;
}

/** A refusal by the service, with its stable code. */
export class DataServiceError extends Error {
  readonly code: string;
  constructor(
    readonly status: number,
    code: string,
    message: string,
    readonly detail: { stage?: string; likelyDiverged?: boolean; retryAfter?: number } = {}
  ) {
    super(message);
    this.name = "DataServiceError";
    this.code = code;
  }
}

async function call<T>(config: MolphaConfig, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (config.dataApiKey) headers["x-api-key"] = config.dataApiKey;
  const res = await fetch(`${config.dataUrl ?? DEFAULT_DATA_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    throw new DataServiceError(res.status, "BAD_RESPONSE", `Molpha Data answered HTTP ${res.status} with a body that is not JSON.`);
  }
  if (res.ok) return parsed as T;
  const e = (parsed as { error?: { code?: string; message?: string; stage?: string; likelyDiverged?: boolean } } | undefined)?.error;
  const retry = Number(res.headers.get("retry-after"));
  const detail: { stage?: string; likelyDiverged?: boolean; retryAfter?: number } = {};
  if (e?.stage) detail.stage = e.stage;
  if (e?.likelyDiverged) detail.likelyDiverged = true;
  if (Number.isFinite(retry) && retry > 0) detail.retryAfter = retry;
  throw new DataServiceError(res.status, e?.code ?? "HTTP_ERROR", `Molpha Data: ${e?.message ?? `HTTP ${res.status}`}`, detail);
}

export async function listTemplates(config: MolphaConfig, filter: { chain?: string; class?: string } = {}): Promise<DataTemplate[]> {
  const q = new URLSearchParams();
  if (filter.chain) q.set("chain", filter.chain);
  if (filter.class) q.set("class", filter.class);
  const r = await call<{ templates: DataTemplate[] }>(config, `/v1/catalog${q.size ? `?${q}` : ""}`);
  return r.templates;
}

/** Checks that `source` is a valid source whose canonical bytes hash to `sourceId`. */
export function checkSource(source: unknown, sourceId: string): ParsedSourceLike {
  const parsed = parseSource(source);
  if (parsed.idHex.toLowerCase() !== sourceId.toLowerCase()) {
    throw new Error(`Molpha Data returned a source that hashes to ${parsed.idHex}, not to its sourceId ${sourceId}; it was not used.`);
  }
  return parsed;
}

export async function deriveSource(config: MolphaConfig, req: DataRequest): Promise<DerivedSource> {
  const d = await call<Omit<DerivedSource, "parsed">>(config, "/v1/sources/derive", req);
  return { ...d, parsed: checkSource(d.source, d.sourceId) };
}

export interface UnsignedEnvelope {
  template: string | null;
  params: Record<string, string> | null;
  mode: string;
  data: { value: string; encoded: string; type: string; decimals: number | null };
  facts: Record<string, string> | null;
  source: { sourceId: string; config: Record<string, unknown> };
  read: Record<string, unknown>;
  payload: string | null;
  layout?: unknown[];
  fields?: Record<string, string>;
}

const hex = (b: Uint8Array): string => "0x" + Buffer.from(b).toString("hex");

/** An unsigned read: the service's own observation. The source and any payload are checked here. */
export async function unsignedRead(config: MolphaConfig, req: DataRequest): Promise<UnsignedEnvelope> {
  const env = await call<UnsignedEnvelope>(config, "/v1/read", { ...req, attest: false });
  checkSource(env.source.config, env.source.sourceId);
  if (env.payload && env.data.type === "keccak256") {
    const digest = hex(keccak_256(Buffer.from(env.payload.replace(/^0x/, ""), "hex")));
    if (digest !== env.data.encoded.toLowerCase()) {
      throw new Error("Molpha Data returned a payload that does not hash to its value; it was not used.");
    }
  }
  return env;
}
