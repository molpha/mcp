/** MOLPHA_DRY_RUN=true is a lock: a call cannot opt out of it with `dryRun: false`. */
import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../../src/clients.js";
import { loadConfig } from "../../src/config.js";
import { resolveDryRun } from "../../src/guardrails.js";
import { callTool, callToolError } from "./tool-harness.js";

const apiConfig = { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate", valueTransform: "mul(1e8)" };
const signer = Keypair.generate().publicKey.toBase58();

describe("resolveDryRun", () => {
  const locked = { maxExecutesPerDay: 100, dryRunDefault: true };
  const open = { maxExecutesPerDay: 100, dryRunDefault: false };

  it("follows the call when the server is not locked, and defaults to live", () => {
    expect(resolveDryRun(undefined, open)).toBe(false);
    expect(resolveDryRun(false, open)).toBe(false);
    expect(resolveDryRun(true, open)).toBe(true);
  });

  it("is a dry run whenever the server is locked, and refuses an explicit opt-out", () => {
    expect(resolveDryRun(undefined, locked)).toBe(true);
    expect(resolveDryRun(true, locked)).toBe(true);
    expect(() => resolveDryRun(false, locked)).toThrowError(expect.objectContaining({ code: "dry_run_locked" }));
  });
});

function lockedContext(): { dependencies: { getContext: () => Promise<RequestContext> }; gateway: { requestSignedData: ReturnType<typeof vi.fn> }; solana: { submitAttestation: ReturnType<typeof vi.fn> } } {
  const gateway = { requestSignedData: vi.fn() };
  const solana = { submitAttestation: vi.fn() };
  const context = {
    config: loadConfig({ GATEWAY_ENDPOINTS: "http://gateway.test", SOLANA_RPC: "http://solana.test", MOLPHA_DRY_RUN: "true" }),
    gateway,
    solana,
    signer: { publicKey: signer }
  };
  return { dependencies: { getContext: async () => context as unknown as RequestContext }, gateway, solana };
}

describe("a locked server", () => {
  it("refuses dryRun: false on execute_subscription_round without touching the gateway", async () => {
    const { dependencies, gateway } = lockedContext();

    expect(await callToolError("execute_subscription_round", { apiConfig, chains: ["solana"], dryRun: false }, dependencies)).toMatchObject({
      code: "dry_run_locked",
      remediation: expect.stringContaining("MOLPHA_DRY_RUN")
    });
    expect(gateway.requestSignedData).not.toHaveBeenCalled();
  });

  it("refuses dryRun: false on submit_attestation without touching the chain", async () => {
    const { dependencies, solana } = lockedContext();
    const result = {
      sourceId: "1".repeat(64),
      value: "66285",
      valuePacked: "2".repeat(64),
      timestamp: 1714300000,
      registryVersion: 7,
      signaturesRequired: 1,
      signersBitmap: "4",
      s: "3".repeat(64),
      commitmentAddr: "4".repeat(40)
    };

    expect(await callToolError("submit_attestation", { result, dryRun: false }, dependencies)).toMatchObject({
      code: "dry_run_locked"
    });
    expect(solana.submitAttestation).not.toHaveBeenCalled();
  });

  it("refuses dryRun: false on execute_x402_round", async () => {
    const { dependencies } = lockedContext();

    expect(await callToolError("execute_x402_round", { apiConfig, chains: ["solana"], dryRun: false }, dependencies)).toMatchObject({
      code: "dry_run_locked"
    });
  });

  it("still previews when the call says nothing about dryRun", async () => {
    const { dependencies, gateway } = lockedContext();

    expect(await callTool("execute_subscription_round", { apiConfig, chains: ["solana"] }, dependencies)).toMatchObject({
      dryRun: true,
      action: "execute_subscription_round"
    });
    expect(gateway.requestSignedData).not.toHaveBeenCalled();
  });
});
