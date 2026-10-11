/**
 * Challenges: what the hosted server hands a caller between two tool calls
 * instead of remembering it. A prepare tool seals the state its execute tool
 * needs; the caller returns it unchanged; a MAC under a deployment secret shows
 * the server it is reading its own words. Nothing in a challenge is secret.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const FORMAT = "mc1";
const MAC_DOMAIN = "molpha-mcp/challenge/v1";
const MIN_SECRET_BYTES = 32;

interface ChallengeKey {
  /** Public: names the key a challenge was sealed with. */
  id: string;
  secret: Buffer;
}

export interface ChallengeKeys {
  current: ChallengeKey;
  /** Still verified, never used to seal: the key being rotated out. */
  previous?: ChallengeKey;
}

/**
 * Reads MOLPHA_HTTP_CHALLENGE_SECRET (and the verify-only
 * MOLPHA_HTTP_CHALLENGE_SECRET_PREVIOUS). Every instance of a deployment must
 * share them, so there is no generated fallback: unset means the tools that
 * need a challenge are unavailable, and a malformed value fails startup.
 */
export function loadChallengeKeys(env: NodeJS.ProcessEnv = process.env): ChallengeKeys | undefined {
  const current = parseSecret(env.MOLPHA_HTTP_CHALLENGE_SECRET, "MOLPHA_HTTP_CHALLENGE_SECRET");
  const previous = parseSecret(env.MOLPHA_HTTP_CHALLENGE_SECRET_PREVIOUS, "MOLPHA_HTTP_CHALLENGE_SECRET_PREVIOUS");
  if (!current) {
    if (previous) throw new Error("MOLPHA_HTTP_CHALLENGE_SECRET_PREVIOUS is set without MOLPHA_HTTP_CHALLENGE_SECRET");
    return undefined;
  }
  return { current, ...(previous ? { previous } : {}) };
}

function parseSecret(value: string | undefined, name: string): ChallengeKey | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const secret = /^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0
    ? Buffer.from(text, "hex")
    : /^[A-Za-z0-9+/_-]+={0,2}$/.test(text)
      ? Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64")
      : undefined;
  if (!secret || secret.length < MIN_SECRET_BYTES) {
    // Never echo the value: it is a credential.
    throw new Error(`${name} must be at least ${MIN_SECRET_BYTES} random bytes, hex or base64 encoded`);
  }
  return { id: createHash("sha256").update(MAC_DOMAIN).update(secret).digest("hex").slice(0, 8), secret };
}

export function requireChallengeKeys(keys: ChallengeKeys | undefined): ChallengeKeys {
  if (!keys) {
    throw Object.assign(new Error("MOLPHA_HTTP_CHALLENGE_SECRET is not set on this server, so prepared operations are unavailable"), {
      code: "missing_config"
    });
  }
  return keys;
}

/** Seals `payload` as a `type` challenge that {@link openChallenge} accepts until `expiresAt` (unix seconds). */
export function sealChallenge(keys: ChallengeKeys, type: string, payload: unknown, expiresAt: number): string {
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt), payload })).toString("base64url");
  return `${FORMAT}.${keys.current.id}.${body}.${mac(keys.current, type, body).toString("base64url")}`;
}

/**
 * Returns the payload of a challenge this deployment sealed as `type`. Anything
 * else is refused as `invalid_challenge`; one past its expiry is refused with
 * `expiredCode`, which tells the caller to prepare again.
 */
export function openChallenge<T>(
  keys: ChallengeKeys,
  type: string,
  challenge: string,
  expiredCode: string,
  now: number = Date.now() / 1000
): T {
  const [format, id, body, tag, ...rest] = challenge.split(".");
  const key = [keys.current, keys.previous].find((candidate) => candidate?.id === id);
  if (format !== FORMAT || !key || !body || !tag || rest.length > 0) {
    throw invalid();
  }
  const expected = mac(key, type, body);
  const given = Buffer.from(tag, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw invalid();
  }

  const sealed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { exp: number; payload: T };
  if (now >= sealed.exp) {
    throw Object.assign(new Error("this prepared operation has expired; prepare it again"), { code: expiredCode });
  }
  return sealed.payload;
}

/** The type is MAC'd, not carried, so a challenge sealed for one tool is not one for another. */
function mac(key: ChallengeKey, type: string, body: string): Buffer {
  return createHmac("sha256", key.secret).update(`${MAC_DOMAIN}\0${type}\0${body}`).digest();
}

function invalid(): Error {
  return Object.assign(new Error("challenge was not issued by this server or has been altered"), { code: "invalid_challenge" });
}
