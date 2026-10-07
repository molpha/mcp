import { describe, expect, it } from "vitest";
import { getBase58Decoder } from "@solana/kit";
import { refuseCredentialHeaders, secretShaped } from "../../src/http/credentials.js";
import { getSharedRuntime, createRequestContext } from "../../src/clients.js";
import { loadHttpConfig, IpLimiter } from "../../src/http/server.js";

const address = "11111111111111111111111111111111";
const legacy = {
  privy: { "app-id": "app", "app-secret": "canary-app-secret", "wallet-id": "wallet", "wallet-address": address },
  turnkey: { "api-public-key": "02" + "ab".repeat(32), "api-private-key": "ab".repeat(32), "organization-id": "org", "wallet-address": address }
};
function legacyHeaders(backend: keyof typeof legacy): string[] {
  return ["X-Molpha-Signer", backend, ...Object.entries(legacy[backend]).flatMap(([field, value]) => [`X-Molpha-${backend}-${field}`, value])];
}

describe("the hosted server takes no credentials", () => {
  it("builds its context without a signer, whatever signer settings the environment holds", () => {
    const runtime = getSharedRuntime({ SIGNER_BACKEND: "memory", OWNER_KEYPAIR: "/does/not/exist", PRIVY_APP_SECRET: "canary", SOLANA_RPC: "http://localhost:8899" });
    expect(runtime.config.ownerKeypair).toBeUndefined();
    expect(runtime.config.guardrails.dailyCapsEnabled).toBe(false);
    const context = createRequestContext(runtime);
    expect(context.signer).toBeUndefined();
    expect(context.hosted).toBe(true);
  });

  it("accepts ordinary request headers, including a bearer token for nothing in particular", () => {
    expect(() => refuseCredentialHeaders([])).not.toThrow();
    expect(() => refuseCredentialHeaders(["Content-Type", "application/json", "Accept", "application/json", "Authorization", "Bearer abc", "User-Agent", "agent/1"])).not.toThrow();
  });

  for (const backend of ["privy", "turnkey"] as const) {
    it(`refuses the old ${backend} signer headers, whole or in part, without echoing them`, () => {
      const headers = legacyHeaders(backend);
      for (const input of [headers, headers.slice(0, 2), headers.slice(2, 4), headers.map((value, i) => (i % 2 === 0 ? value.toLowerCase() : value))]) {
        try {
          refuseCredentialHeaders(input);
          throw new Error("not refused");
        } catch (error) {
          expect(error).toMatchObject({ status: 400 });
          expect(String(error)).toContain("no longer accepted");
          expect(String(error)).not.toContain("canary");
        }
      }
    });
  }

  for (const secret of [JSON.stringify(Array(64).fill(42)), JSON.stringify(Array(32).fill(42)), getBase58Decoder().decode(new Uint8Array(64).fill(42))]) {
    it(`refuses wallet secret material in any header (${secret.slice(0, 4)}…)`, () => {
      expect(secretShaped(secret)).toBe(true);
      for (const name of ["Authorization", "X-Api-Key", "Other"]) {
        expect(() => refuseCredentialHeaders(["Accept", "application/json", name, secret])).toThrow("Wallet secret");
      }
    });
  }

  it("does not mistake an address, a hash or a signature-length hex string for a wallet secret", () => {
    for (const value of [address, "ab".repeat(32), "ab".repeat(64), "[1,2,3]", "Bearer molpha_sess_" + "A".repeat(43)]) {
      expect(secretShaped(value)).toBe(false);
    }
  });
});

describe("HTTP configuration and limiter", () => {
  it("uses strict defaults with explicit self-hosted overrides", () => {
    expect(loadHttpConfig({})).toMatchObject({ host: "127.0.0.1", port: 8402, burst: 60, refillPerSecond: 1, rateLimit: true });
    expect(loadHttpConfig({})).not.toHaveProperty("challengeKeys");
    expect(loadHttpConfig({ MOLPHA_HTTP_RATE_LIMIT: "false" }, 1234)).toMatchObject({ port: 1234, rateLimit: false });
    expect(loadHttpConfig({ PORT: "3000" }).port).toBe(3000);
    expect(loadHttpConfig({ MOLPHA_HTTP_PORT: "8402", PORT: "3000" }).port).toBe(8402);
    expect(loadHttpConfig({ VERCEL: "1" }).host).toBe("0.0.0.0");
    expect(loadHttpConfig({
      VERCEL_URL: "molpha-mcp-abc123.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "https://mcp.molpha.io"
    }).allowedHosts).toEqual(expect.arrayContaining(["mcp.molpha.io", "molpha-mcp-abc123.vercel.app"]));
    expect(loadHttpConfig({
      VERCEL_URL: "molpha-mcp-abc123.vercel.app"
    }).allowedOrigins).toEqual(expect.arrayContaining(["https://mcp.molpha.io", "https://molpha-mcp-abc123.vercel.app"]));
    expect(getSharedRuntime({ MOLPHA_HTTP_DAILY_CAPS: "true" }).config.x402.dailyCapsEnabled).toBe(true);
    expect(() => loadHttpConfig({}, 65536)).toThrow();
    expect(() => loadHttpConfig({ MOLPHA_HTTP_RATE_LIMIT: "maybe" })).toThrow();
  });
  it("loads the challenge secret, and fails startup on one that is unusable", () => {
    expect(loadHttpConfig({ MOLPHA_HTTP_CHALLENGE_SECRET: "5a".repeat(32) }).challengeKeys?.current.id).toMatch(/^[0-9a-f]{8}$/);
    expect(() => loadHttpConfig({ MOLPHA_HTTP_CHALLENGE_SECRET: "too-short" })).toThrow(/MOLPHA_HTTP_CHALLENGE_SECRET/);
  });
  it("refuses to start with the private-API override the hosted server can no longer honour", () => {
    expect(() => loadHttpConfig({ MOLPHA_HTTP_ALLOW_ENCRYPT_SECRETS: "true" })).toThrow(/MOLPHA_HTTP_ALLOW_ENCRYPT_SECRETS/);
    expect(() => loadHttpConfig({ MOLPHA_HTTP_ALLOW_ENCRYPT_SECRETS: "false" })).not.toThrow();
  });
  it("refills, isolates IPs, and bounds memory without evicting active clients", () => {
    const limiter = new IpLimiter(1, 1, 2);
    expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.take("a", 500)).toBe(false);
    expect(limiter.take("b", 500)).toBe(true);
    expect(limiter.take("c", 500)).toBe(false);
    expect(limiter.take("a", 1000)).toBe(true);
    expect(limiter.take("c", 301001)).toBe(true);
  });
});
