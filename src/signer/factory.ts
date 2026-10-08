import { loadOwnerKeypair, resolveEnvString } from "../config.js";
import type { MolphaConfig } from "../config.js";
import { MemorySigner } from "./backends/memory.js";
import { PrivySigner } from "./backends/privy.js";
import { TurnkeySigner } from "./backends/turnkey.js";
import type { MolphaSigner } from "./types.js";

export async function createSigner(config: MolphaConfig): Promise<MolphaSigner> {
  const backend = resolveEnvString(process.env["SIGNER_BACKEND"]) ?? "memory";

  if (backend === "keychain") {
    return createKeychainSigner();
  }

  if (backend === "none") {
    throw new Error("SIGNER_BACKEND=none runs the server without a signer, so there is nothing to sign with.");
  }

  if (backend !== "memory") {
    throw new Error(`Unknown SIGNER_BACKEND="${backend}". Supported values: memory, keychain, none`);
  }

  return MemorySigner.fromSecretKey(loadOwnerKeypair(config));
}

function createKeychainSigner(): MolphaSigner {
  const provider = resolveEnvString(process.env["KEYCHAIN_BACKEND"]);

  if (provider === "privy") {
    return new PrivySigner({
      appId: requireEnv("PRIVY_APP_ID"),
      appSecret: requireEnv("PRIVY_APP_SECRET"),
      walletId: requireEnv("PRIVY_WALLET_ID"),
      address: requireEnv("PRIVY_WALLET_ADDRESS"),
    });
  }

  if (provider === "turnkey") {
    return new TurnkeySigner({
      apiPublicKey: requireEnv("TURNKEY_API_PUBLIC_KEY"),
      apiPrivateKey: requireEnv("TURNKEY_API_PRIVATE_KEY"),
      organizationId: requireEnv("TURNKEY_ORGANIZATION_ID"),
      address: requireEnv("TURNKEY_WALLET_ADDRESS"),
    });
  }

  throw new Error(
    `Unknown KEYCHAIN_BACKEND="${provider ?? ""}". Supported values: privy, turnkey`
  );
}

function requireEnv(name: string): string {
  const value = resolveEnvString(process.env[name]);
  if (!value) throw new Error(`${name} is required for SIGNER_BACKEND=keychain`);
  return value;
}
