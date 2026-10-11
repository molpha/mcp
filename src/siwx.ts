/**
 * The client half of a gateway sign-in: the Sign-In-With-X (x402 `sign-in-with-x`
 * extension) message a wallet signs, in its Solana (SIWS) form, and the header
 * that carries it back. The gateway is what holds a sign-in to its terms; this
 * module checks a challenge before a wallet is asked to sign it, so an agent is
 * never handed text that reads differently from what this server expects for
 * its configured gateway.
 */
import type { Address } from "@solana/kit";

export const SIWX_HEADER = "SIGN-IN-WITH-X";
const VERSION = "1";
/** A challenge may not ask for a longer-lived message than this; the gateway caps its own at 5 minutes. */
const MAX_CHALLENGE_SECONDS = 300;
/** How far a challenge's issuedAt may sit from this host's clock. */
const CLOCK_TOLERANCE_MS = 120_000;

/** The terms of a sign-in, as the gateway states them. */
export interface SiwxInfo {
  domain: string;
  uri: string;
  statement: string;
  version: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  resources: string[];
}

/** What a wallet signs: the terms, the chain, and the address signing. */
export interface SiwxMessageFields extends SiwxInfo {
  address: string;
  /** CAIP-2. */
  chainId: string;
}

/** What this server expects a challenge for its gateway to say. */
export interface SiwxTerms {
  /** The configured gateway base URL. */
  endpoint: string;
  /** CAIP-2 id of the SOLANA_RPC cluster. */
  network: string;
  programId: Address;
  gatewayPda: Address;
  address: Address;
  owner: Address;
}

export function siwxStatement(gatewayPda: Address): string {
  return `Sign in to Molpha gateway ${gatewayPda} as subscriber or delegate. This signature does not move funds.`;
}

/**
 * The Sign-In-With-Solana text for a sign-in, byte for byte what the gateway
 * rebuilds and verifies the signature over (the x402 extension's format).
 */
export function formatSiwsMessage(fields: SiwxMessageFields): string {
  const [, reference] = fields.chainId.split(":");
  return [
    `${fields.domain} wants you to sign in with your Solana account:`,
    fields.address,
    "",
    ...(fields.statement ? [fields.statement, ""] : []),
    `URI: ${fields.uri}`,
    `Version: ${fields.version}`,
    `Chain ID: ${reference ?? ""}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
    ...(fields.expirationTime ? [`Expiration Time: ${fields.expirationTime}`] : []),
    ...(fields.resources.length > 0 ? ["Resources:", ...fields.resources.map((resource) => `- ${resource}`)] : [])
  ].join("\n");
}

/**
 * Accepts a gateway's challenge only if it states exactly this server's terms: its
 * domain and URI are the configured endpoint's, its chain the SOLANA_RPC cluster, its
 * statement and resources name the Gateway PDA and program this server derived, and
 * its text is the standard rendering of those fields. Returns the terms to sign.
 */
export function assertChallenge(terms: SiwxTerms, challenge: unknown, nowMs: number = Date.now()): SiwxMessageFields {
  const data = asRecord(challenge);
  const info = asRecord(data?.info);
  if (!data || !info) {
    throw refused("is malformed");
  }
  const text = (source: Record<string, unknown>, field: string): string => {
    const value = source[field];
    if (typeof value !== "string" || value.length === 0) throw refused(`has no ${field}`);
    return value;
  };
  const origin = new URL(terms.endpoint);
  const resources = Array.isArray(info.resources) ? info.resources : [];
  const fields: SiwxMessageFields = {
    domain: text(info, "domain"),
    uri: text(info, "uri"),
    statement: text(info, "statement"),
    version: text(info, "version"),
    nonce: text(info, "nonce"),
    issuedAt: text(info, "issuedAt"),
    expirationTime: text(info, "expirationTime"),
    resources: resources.map(String),
    address: text(data, "address"),
    chainId: text(data, "chainId")
  };

  const expectedResources = [
    `molpha:program:${terms.programId}`,
    `molpha:gateway:${terms.gatewayPda}`,
    `molpha:subscription:${terms.owner}`
  ];
  const issued = Date.parse(fields.issuedAt);
  const expires = Date.parse(fields.expirationTime);
  const checks: Array<[boolean, string]> = [
    [fields.domain === origin.host, `is for domain ${fields.domain}, not ${origin.host}`],
    [fields.uri === `${origin.origin}/v1/session`, `is for URI ${fields.uri}`],
    [fields.chainId === terms.network, `is for chain ${fields.chainId}, not the SOLANA_RPC cluster ${terms.network}`],
    [fields.version === VERSION, `has version ${fields.version}`],
    [fields.address === terms.address, `is for address ${fields.address}`],
    [fields.statement === siwxStatement(terms.gatewayPda), "does not carry this gateway's sign-in statement"],
    [
      fields.resources.length === expectedResources.length && fields.resources.every((r, i) => r === expectedResources[i]),
      "does not name this program, gateway and subscription owner as its resources"
    ],
    [/^[A-Za-z0-9]{16,64}$/.test(fields.nonce), "has a malformed nonce"],
    [
      Number.isFinite(issued) && Math.abs(issued - nowMs) <= CLOCK_TOLERANCE_MS,
      "was not issued now (check this server's clock against the gateway's)"
    ],
    [
      Number.isFinite(expires) && expires > nowMs && expires - issued <= MAX_CHALLENGE_SECONDS * 1000,
      "has an expiry that is missing, past, or more than five minutes out"
    ],
    [data.message === formatSiwsMessage(fields), "carries message text that does not match its own terms"]
  ];
  for (const [ok, problem] of checks) {
    if (!ok) throw refused(problem);
  }
  return fields;
}

/** The `SIGN-IN-WITH-X` header value: base64 of the signed terms as JSON. `signature` is base58. */
export function encodeSiwxHeader(fields: SiwxMessageFields, signature: string): string {
  return Buffer.from(
    JSON.stringify({ ...fields, type: "ed25519", signatureScheme: "siws", signature })
  ).toString("base64");
}

function refused(problem: string): Error {
  return new Error(`the gateway's sign-in challenge ${problem}; refusing to hand it to a wallet`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
