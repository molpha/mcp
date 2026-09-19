import { describe, expect, it } from "vitest";
import { getBase58Decoder } from "@solana/kit";
import { parseSignerHeaders, secretShaped } from "../../src/http/signers.js";
import { getSharedRuntime, createRequestContext } from "../../src/clients.js";
import { loadHttpConfig, IpLimiter } from "../../src/http/server.js";

const address = "11111111111111111111111111111111";
const providers = {
  privy: { "app-id": "app", "app-secret": "canary-app-secret", "wallet-id": "wallet", "wallet-address": address },
  turnkey: { "api-public-key": "02" + "ab".repeat(32), "api-private-key": "ab".repeat(32), "organization-id": "org", "wallet-address": address }
};
function headers(backend: keyof typeof providers): string[] {
  return ["X-Molpha-Signer", backend, ...Object.entries(providers[backend]).flatMap(([field, value]) => [`X-Molpha-${backend}-${field}`, value])];
}

describe("managed signer headers", () => {
  it("allows unsigned requests without consulting environment credentials", () => {
    expect(parseSignerHeaders([])).toBeUndefined();
    const runtime = getSharedRuntime({ SIGNER_BACKEND: "memory", OWNER_KEYPAIR: "/does/not/exist", PRIVY_APP_SECRET: "canary", SOLANA_RPC: "http://localhost:8899" });
    expect(runtime.config.ownerKeypair).toBeUndefined();
    expect(runtime.config.guardrails.dailyCapsEnabled).toBe(false);
    expect(createRequestContext(runtime).signer).toBeUndefined();
  });
  for (const backend of ["privy", "turnkey"] as const) {
    it(`accepts complete ${backend} credentials`, () => expect(parseSignerHeaders(headers(backend))?.backend).toBe(backend));
    for (const field of Object.keys(providers[backend])) {
      it(`rejects missing ${backend} ${field}`, () => {
        const input = headers(backend);
        input.splice(input.indexOf(`X-Molpha-${backend}-${field}`), 2);
        expect(() => parseSignerHeaders(input)).toThrow("Missing required header");
      });
    }
    it(`rejects duplicate ${backend} headers case-insensitively`, () => expect(() => parseSignerHeaders([...headers(backend), "x-molpha-signer", backend])).toThrow("Duplicate"));
    it(`rejects invalid ${backend} wallet address without echo`, () => {
      const input = headers(backend); input[input.length - 1] = "CANARY_INVALID_ADDRESS";
      try { parseSignerHeaders(input); throw new Error("not rejected"); }
      catch (error) { expect(String(error)).toContain("valid Solana"); expect(String(error)).not.toContain("CANARY"); }
    });
    for (const secret of [JSON.stringify(Array(64).fill(42)), getBase58Decoder().decode(new Uint8Array(64).fill(42))]) {
      for (let index = 1; index < headers(backend).length; index += 2) {
        it(`rejects ${backend} secret shape in header ${index}, format ${secret[0]}`, () => {
          const input = headers(backend); input[index] = secret;
          expect(() => parseSignerHeaders(input)).toThrow("npx @molpha/mcp");
        });
      }
      it(`rejects secret material in arbitrary headers (${backend}, ${secret[0]})`, () => expect(() => parseSignerHeaders(["Other", secret])).toThrow("Wallet secret"));
    }
  }
  it("rejects unsupported and orphaned credentials", () => {
    expect(() => parseSignerHeaders(["X-Molpha-Signer", "memory"])).toThrow();
    expect(() => parseSignerHeaders(["X-Molpha-Privy-App-Id", "app"])).toThrow();
  });
  it("does not mistake a 32-byte Turnkey API credential for a wallet secret", () => expect(secretShaped("ab".repeat(32))).toBe(false));
});

describe("HTTP configuration and limiter", () => {
  it("uses strict defaults with explicit self-hosted overrides", () => {
    expect(loadHttpConfig({})).toMatchObject({ host: "127.0.0.1", port: 8402, burst: 60, refillPerSecond: 1, allowEncryptSecrets: false, rateLimit: true });
    expect(loadHttpConfig({ MOLPHA_HTTP_ALLOW_ENCRYPT_SECRETS: "true", MOLPHA_HTTP_RATE_LIMIT: "false" }, 1234)).toMatchObject({ port: 1234, allowEncryptSecrets: true, rateLimit: false });
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
