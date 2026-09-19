import { getBase58Encoder } from "@solana/kit";
import { parseSolanaPubkey } from "../solana-address.js";
import { PrivySigner, type PrivySignerConfig } from "../signer/backends/privy.js";
import { TurnkeySigner, type TurnkeySignerConfig } from "../signer/backends/turnkey.js";
import type { MolphaSigner } from "../signer/types.js";

export class HttpInputError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type SignerSpec = { backend: "privy"; config: PrivySignerConfig } | { backend: "turnkey"; config: TurnkeySignerConfig };

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

/** rawHeaders retains duplicates that Node's normalized header map can hide. */
export function parseSignerHeaders(rawHeaders: readonly string[]): SignerSpec | undefined {
  const headers = new Map<string, string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase();
    const value = rawHeaders[i + 1] ?? "";
    if (secretShaped(value)) throw new HttpInputError(400, "Wallet secret material is not accepted. Use npx @molpha/mcp locally.");
    if (!name.startsWith("x-molpha-")) continue;
    if (headers.has(name)) throw new HttpInputError(400, "Duplicate signer headers are not accepted.");
    headers.set(name, value.trim());
  }
  const backend = headers.get("x-molpha-signer");
  if (backend === undefined && headers.size === 0) return undefined;
  if (backend !== "privy" && backend !== "turnkey") throw new HttpInputError(400, "X-Molpha-Signer must be privy or turnkey.");
  const fields = backend === "privy"
    ? { appId: "app-id", appSecret: "app-secret", walletId: "wallet-id", address: "wallet-address" }
    : { apiPublicKey: "api-public-key", apiPrivateKey: "api-private-key", organizationId: "organization-id", address: "wallet-address" };
  const config: Record<string, string> = {};
  const allowed = new Set(["x-molpha-signer"]);
  for (const [key, suffix] of Object.entries(fields)) {
    const name = `x-molpha-${backend}-${suffix}`;
    allowed.add(name);
    const value = headers.get(name);
    if (!value) throw new HttpInputError(400, `Missing required header: ${name}.`);
    config[key] = value;
  }
  if ([...headers.keys()].some(name => !allowed.has(name))) throw new HttpInputError(400, "Unexpected or mixed signer headers.");
  try { parseSolanaPubkey(config.address!, "wallet address"); }
  catch { throw new HttpInputError(400, "Signer wallet address must be a valid Solana public key."); }
  return backend === "privy"
    ? { backend, config: config as unknown as PrivySignerConfig }
    : { backend, config: config as unknown as TurnkeySignerConfig };
}

export function signerFromSpec(spec: SignerSpec | undefined): MolphaSigner | undefined {
  if (!spec) return undefined;
  return spec.backend === "privy" ? new PrivySigner(spec.config) : new TurnkeySigner(spec.config);
}
