import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { buildMcpEnvBlock, validateSignerEnv } from "../../src/setup-validation.js";

describe("validateSignerEnv", () => {
  it("requires OWNER_KEYPAIR for memory backend", () => {
    const checks = validateSignerEnv({ SIGNER_BACKEND: "memory" });
    expect(checks.find((check) => check.name === "owner_keypair")?.ok).toBe(false);
  });

  it("accepts inline OWNER_KEYPAIR JSON for memory backend", () => {
    const secret = JSON.stringify(Array.from(Keypair.generate().secretKey));
    const checks = validateSignerEnv({
      SIGNER_BACKEND: "memory",
      OWNER_KEYPAIR: secret
    });

    const ownerCheck = checks.find((check) => check.name === "owner_keypair");
    expect(ownerCheck?.ok).toBe(true);
    expect(ownerCheck?.message).toBe("OWNER_KEYPAIR=<inline-json-keypair>");
  });

  it("rejects invalid inline OWNER_KEYPAIR JSON", () => {
    const checks = validateSignerEnv({
      SIGNER_BACKEND: "memory",
      OWNER_KEYPAIR: "[1,2,3]"
    });

    const ownerCheck = checks.find((check) => check.name === "owner_keypair");
    expect(ownerCheck?.ok).toBe(false);
    expect(ownerCheck?.message).toContain("inline JSON is invalid");
  });

  it("requires privy vars for keychain privy backend", () => {
    const checks = validateSignerEnv({
      SIGNER_BACKEND: "keychain",
      KEYCHAIN_BACKEND: "privy"
    });

    expect(checks.find((check) => check.name === "keychain_backend")?.ok).toBe(true);
    expect(checks.find((check) => check.name === "privy_app_id")?.ok).toBe(false);
    expect(checks.find((check) => check.name === "privy_app_secret")?.ok).toBe(false);
  });

  it("rejects invalid turnkey wallet addresses", () => {
    const checks = validateSignerEnv({
      SIGNER_BACKEND: "keychain",
      KEYCHAIN_BACKEND: "turnkey",
      TURNKEY_API_PUBLIC_KEY: "pub",
      TURNKEY_API_PRIVATE_KEY: "priv",
      TURNKEY_ORGANIZATION_ID: "org",
      TURNKEY_WALLET_ADDRESS: "<base58-solana-address>"
    });

    const walletCheck = checks.find((check) => check.name === "turnkey_wallet_address");
    expect(walletCheck?.ok).toBe(false);
    expect(walletCheck?.message).toContain("TURNKEY_WALLET_ADDRESS");
  });

  it("builds memory env block with absolute owner keypair path", () => {
    const env = buildMcpEnvBlock({
      SIGNER_BACKEND: "memory",
      OWNER_KEYPAIR: "/tmp/owner.json",
      SOLANA_RPC: "https://api.devnet.solana.com"
    });

    expect(env.SIGNER_BACKEND).toBe("memory");
    expect(env.OWNER_KEYPAIR).toBe("/tmp/owner.json");
    expect(env.SOLANA_RPC).toBe("https://api.devnet.solana.com");
  });
});
