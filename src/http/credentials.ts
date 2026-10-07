import { getBase58Encoder } from "@solana/kit";
import { HttpInputError } from "./errors.js";

/** A Solana secret key as a JSON byte array or as base58: what a wallet export looks like. */
export function secretShaped(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const array: unknown = JSON.parse(trimmed);
      if (Array.isArray(array) && (array.length === 32 || array.length === 64) &&
        array.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return true;
    } catch { /* not a JSON keypair */ }
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(trimmed)) {
    try { return getBase58Encoder().encode(trimmed).length === 64; } catch { return false; }
  }
  return false;
}

/**
 * The hosted server takes no signing credentials: callers sign with their own wallet. A request
 * that still carries the old per-request signer headers, or anything shaped like a wallet secret,
 * is refused before it is read any further, so a client configured for the old scheme stops
 * sending provider secrets instead of having them silently ignored.
 *
 * rawHeaders retains duplicates that Node's normalized header map can hide.
 */
export function refuseCredentialHeaders(rawHeaders: readonly string[]): void {
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]!.toLowerCase().startsWith("x-molpha-")) {
      throw new HttpInputError(400, "X-Molpha-* signer headers are no longer accepted: this server holds no keys. Remove them and sign with your own wallet (prepare_x402_round, begin_session), or run npx @molpha/mcp locally.");
    }
    if (secretShaped(rawHeaders[i + 1] ?? "")) {
      throw new HttpInputError(400, "Wallet secret material is not accepted. Use npx @molpha/mcp locally.");
    }
  }
}
