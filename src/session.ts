/**
 * Gateway sign-in sessions for a wallet this server does not hold. The caller's
 * wallet signs one text message (begin → sign → complete) and receives a bearer
 * token that admits subscription rounds in place of the per-request RequestAuth
 * signature. This talks to the gateway directly: the SDK signs RequestAuth itself
 * and has no session path.
 *
 * The session token passes through this server on its way to the gateway. It is
 * never stored, cached or logged here, and is sent to exactly one configured
 * gateway endpoint.
 */
import { setTimeout as delay } from "node:timers/promises";
import {
  getBase58Decoder,
  getBase58Encoder,
  getPublicKeyFromAddress,
  signatureBytes,
  verifySignature,
  type Address
} from "@solana/kit";
import type { Connection } from "@solana/web3.js";
import { exactBytes, utf8Bytes } from "./bytes.js";
import { assertToleranceQuorum, canonicalizeApiConfig, deriveSourceId, type ApiConfigLike } from "./apiconfig.js";
import { getMolphaProgramId, requireMethod, type RequestLifecycle } from "./clients.js";
import type { MolphaConfig } from "./config.js";
import { normalizeSourceId } from "./hex.js";
import { readRoundResponse } from "./round-response.js";
import { assertChallenge, encodeSiwxHeader, formatSiwsMessage, SIWX_HEADER, type SiwxMessageFields } from "./siwx.js";
import { parseSolanaPubkey } from "./solana-address.js";
import { clusterNetwork, conflictRetryDelayMs, gatewayAuthority } from "./x402.js";
import { deriveGatewayPda } from "./x402-payment.js";

export interface SessionContext {
  lifecycle?: RequestLifecycle;
  config: MolphaConfig;
  connection: Pick<Connection, "getGenesisHash">;
  solana: Record<string, unknown>;
  gateway: Record<string, unknown>;
}

/**
 * What begin_session hands complete_session: the terms that were signed and the
 * gateway they are for. Neither secret nor authenticated — the gateway is what
 * holds a sign-in to its terms, and the endpoint is checked against configuration
 * again before anything is sent to it.
 */
interface SessionChallenge {
  endpoint: string;
  fields: SiwxMessageFields;
}

export interface BegunSession {
  message: string;
  challenge: string;
  gatewayEndpoint: string;
  address: Address;
  owner: Address;
  /** Unix seconds after which the gateway refuses the signed message. */
  expiresAt: number;
}

export interface OpenedSession {
  sessionToken: string;
  gatewayEndpoint: string;
  sessionId: string;
  authority: string;
  owner: string;
  role: string;
  /** Unix seconds. */
  expiresAt: number;
}

export type SignatureEncoding = "base58" | "base64" | "hex";

/**
 * A session belongs to the gateway that opened it. With one endpoint configured that
 * is the one; with several the caller names it, and it must be one of them — this
 * server sends a signed message or a token nowhere else.
 */
export function sessionEndpoint(config: MolphaConfig, requested?: string): string {
  const trim = (url: string): string => url.replace(/\/$/, "");
  if (requested !== undefined) {
    const match = config.gatewayEndpoints.find((endpoint) => trim(endpoint) === trim(requested));
    if (!match) {
      throw Object.assign(new Error(`${requested} is not a gateway endpoint this server is configured for`), { status: 400 });
    }
    return match;
  }
  const [only, ...others] = config.gatewayEndpoints;
  if (!only) throw new Error("no gateway endpoint configured");
  if (others.length > 0) {
    throw Object.assign(
      new Error("several gateway endpoints are configured and a session belongs to one of them; pass gatewayEndpoint"),
      { status: 400 }
    );
  }
  return only;
}

/** Fetches a sign-in challenge for `address`, checks it states this server's terms, and returns the text to sign. */
export async function beginSession(
  ctx: SessionContext,
  args: { address: Address; owner?: Address | undefined; gatewayEndpoint?: string | undefined }
): Promise<BegunSession> {
  ctx.lifecycle?.signal.throwIfAborted();
  // Beginning needs no token, so with several endpoints the first is a fine default; it is
  // returned, and every later call names it.
  const endpoint = sessionEndpoint(ctx.config, args.gatewayEndpoint ?? ctx.config.gatewayEndpoints[0]);
  const owner = args.owner ?? args.address;
  const programId = getMolphaProgramId();
  const [network, authority] = await Promise.all([clusterNetwork(ctx.connection), gatewayAuthority(ctx, endpoint)]);
  const gatewayPda = await deriveGatewayPda(authority, programId);

  const query = new URLSearchParams({ address: args.address, owner });
  const res = await fetch(`${endpoint.replace(/\/$/, "")}/v1/session/challenge?${query.toString()}`, {
    method: "GET",
    ...(ctx.lifecycle ? { signal: ctx.lifecycle.signal } : {})
  });
  if (res.status === 404) {
    throw Object.assign(new Error(`${endpoint} does not offer sign-in sessions (GET /v1/session/challenge is not served)`), {
      code: "sessions_unavailable"
    });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`sign-in challenge request failed: ${await readError(res)}`), { status: res.status });
  }
  const fields = assertChallenge(
    { endpoint, network, programId, gatewayPda, address: args.address, owner },
    asRecord(await res.json())?.data
  );
  const sealed: SessionChallenge = { endpoint, fields };

  return {
    message: formatSiwsMessage(fields),
    challenge: Buffer.from(JSON.stringify(sealed)).toString("base64url"),
    gatewayEndpoint: endpoint,
    address: args.address,
    owner,
    expiresAt: Math.floor(Date.parse(fields.expirationTime) / 1000)
  };
}

/**
 * Exchanges the signed message for a session token. The signature is checked here
 * first, so a wallet that signed something else (a prefixed or wrapped message, the
 * wrong key) is told so plainly instead of through the gateway's refusal.
 */
export async function completeSession(
  ctx: Pick<SessionContext, "lifecycle" | "config">,
  args: { challenge: string; signature: string; signatureEncoding?: SignatureEncoding | undefined }
): Promise<OpenedSession> {
  ctx.lifecycle?.signal.throwIfAborted();
  const { endpoint: sealedEndpoint, fields } = decodeChallenge(args.challenge);
  const endpoint = sessionEndpoint(ctx.config, sealedEndpoint);
  const address = parseSolanaPubkey(fields.address, "challenge address");
  const message = formatSiwsMessage(fields);

  const signature = decodeSignature(args.signature, args.signatureEncoding);
  const valid =
    signature !== undefined &&
    (await verifySignature(await getPublicKeyFromAddress(address), signatureBytes(exactBytes(signature)), utf8Bytes(message)));
  if (!valid) {
    throw Object.assign(
      new Error(
        `signature is not ${address}'s Ed25519 signature over the exact UTF-8 bytes of the sign-in message; sign the message as returned, with no prefix, envelope or trailing newline`
      ),
      { code: "invalid_signature" }
    );
  }

  const res = await fetch(`${endpoint.replace(/\/$/, "")}/v1/session`, {
    method: "POST",
    headers: { [SIWX_HEADER]: encodeSiwxHeader(fields, getBase58Decoder().decode(signature)) },
    ...(ctx.lifecycle ? { signal: ctx.lifecycle.signal } : {})
  });
  if (res.status === 401) {
    throw Object.assign(new Error(`the gateway refused the sign-in: ${await readError(res)}`), { code: "sign_in_rejected" });
  }
  if (res.status !== 201) {
    throw Object.assign(new Error(`sign-in failed: ${await readError(res)}`), { status: res.status });
  }
  const data = asRecord(asRecord(await res.json())?.data);
  if (!data || typeof data.token !== "string" || !data.token || data.authority !== fields.address || typeof data.expiresAt !== "number") {
    throw new Error("the gateway returned a malformed session");
  }
  return {
    sessionToken: data.token,
    gatewayEndpoint: endpoint,
    sessionId: String(data.sessionId ?? ""),
    authority: String(data.authority),
    owner: String(data.owner ?? ""),
    role: String(data.role ?? ""),
    expiresAt: data.expiresAt
  };
}

export interface SessionRoundOptions {
  sessionToken: string;
  apiConfig: ApiConfigLike;
  signaturesRequired: number;
  /** When set, must match the sourceId derived from apiConfig. */
  sourceId?: string | undefined;
  gatewayEndpoint?: string | undefined;
}

/** Runs one subscription round under a session and returns the signed aggregate in its flat form. */
export async function executeSessionRound(ctx: SessionContext, opts: SessionRoundOptions): Promise<Record<string, unknown>> {
  ctx.lifecycle?.signal.throwIfAborted();
  assertToleranceQuorum(opts.apiConfig, opts.signaturesRequired);
  const sourceId = normalizeSourceId(deriveSourceId(opts.apiConfig).sourceId);
  if (opts.sourceId !== undefined && normalizeSourceId(opts.sourceId) !== sourceId) {
    throw new Error(`sourceId does not match apiConfig: expected ${sourceId}, got ${opts.sourceId}`);
  }
  const endpoint = sessionEndpoint(ctx.config, opts.gatewayEndpoint);
  const { registryVersion } = await requireMethod<[], Promise<{ registryVersion: number }>>(
    ctx.solana,
    "getRegistrySelectionConfig"
  )();

  const post = (): Promise<Response> =>
    fetch(`${endpoint.replace(/\/$/, "")}/v1/round/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.sessionToken}` },
      // The session names the consumer and the subscription owner; the gateway assigns the timestamp.
      body: JSON.stringify({
        registryVersion,
        signaturesRequired: opts.signaturesRequired,
        apiConfig: canonicalizeApiConfig(opts.apiConfig)
      }),
      ...(ctx.lifecycle ? { signal: ctx.lifecycle.signal } : {})
    });

  ctx.lifecycle?.signal.throwIfAborted();
  // From here a round may run and use one unit of the subscription's quota.
  if (ctx.lifecycle) ctx.lifecycle.effectStarted = true;
  const startedAtMs = Date.now();
  let res = await post();
  if (res.status === 409) {
    // This consumer already has a round for the feed in the current tick. Nothing was reserved,
    // and one full tick later the request lands in a new one. One retry only.
    await delay(conflictRetryDelayMs(), undefined, ctx.lifecycle ? { signal: ctx.lifecycle.signal } : undefined);
    res = await post();
  }

  if (res.status === 401) {
    throw Object.assign(new Error(`the gateway refused the session: ${await readError(res)}`), { code: "session_invalid" });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`subscription round failed: ${await readError(res)}`), { status: res.status });
  }
  const { matches, result } = readRoundResponse(
    asRecord(await res.json()) ?? {},
    { sourceId, registryVersion, signaturesRequired: opts.signaturesRequired },
    startedAtMs
  );
  if (!matches) {
    throw new Error(
      `the gateway returned an aggregate for a different round (sourceId ${String(result.sourceId)}, timestamp ${String(result.timestamp)})`
    );
  }
  return result;
}

function decodeChallenge(challenge: string): SessionChallenge {
  try {
    const parsed = asRecord(JSON.parse(Buffer.from(challenge, "base64url").toString("utf8")));
    const fields = asRecord(parsed?.fields);
    const strings = ["domain", "uri", "statement", "version", "nonce", "issuedAt", "expirationTime", "address", "chainId"];
    if (
      parsed &&
      fields &&
      typeof parsed.endpoint === "string" &&
      strings.every((key) => typeof fields[key] === "string") &&
      Array.isArray(fields.resources) &&
      fields.resources.every((resource) => typeof resource === "string")
    ) {
      return { endpoint: parsed.endpoint, fields: fields as unknown as SiwxMessageFields };
    }
  } catch {
    // fall through
  }
  throw Object.assign(new Error("challenge is not one begin_session returned"), { code: "invalid_challenge" });
}

/** A 64-byte signature in the encoding named, or in whichever of base58, hex and base64 yields 64 bytes. */
function decodeSignature(value: string, encoding?: SignatureEncoding): Uint8Array | undefined {
  const text = value.trim();
  const decoders: Record<SignatureEncoding, () => Uint8Array> = {
    base58: () => new Uint8Array(getBase58Encoder().encode(text)),
    hex: () => (/^(0x)?[0-9a-fA-F]{128}$/.test(text) ? new Uint8Array(Buffer.from(text.replace(/^0x/, ""), "hex")) : new Uint8Array()),
    base64: () => new Uint8Array(Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64"))
  };
  for (const name of encoding ? [encoding] : (["hex", "base58", "base64"] as const)) {
    try {
      const bytes = decoders[name]();
      if (bytes.length === 64) return bytes;
    } catch {
      // not this encoding
    }
  }
  return undefined;
}

async function readError(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    const parsed = asRecord(JSON.parse(text || "{}"));
    return typeof parsed?.error === "string" && parsed.error ? parsed.error : text || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
