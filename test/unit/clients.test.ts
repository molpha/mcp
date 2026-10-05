import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { createGateway } from "../../src/clients.js";
import { loadConfig } from "../../src/config.js";
import type { MolphaSigner } from "../../src/signer/types.js";

const signer = {
  publicKey: address("GcdayuLaLyrdmUu324nahyv33G5poQdLUEZ1nEytDeP"),
  isAvailable: async () => true,
  signMessage: vi.fn(async () => new Uint8Array(64).fill(7)),
  signTransaction: async (tx: unknown) => tx,
  signAllTransactions: async (txs: unknown) => txs
} as unknown as MolphaSigner;

describe("createGateway", () => {
  it("hands the wallet to the SDK gateway as the RequestAuth signer", async () => {
    const gateway = createGateway(loadConfig({}), {}, signer) as unknown as {
      defaultSigner?: (message: Uint8Array) => Promise<Uint8Array>;
    };
    expect(typeof gateway.defaultSigner).toBe("function");
    const message = new Uint8Array(32).fill(1);
    expect(await gateway.defaultSigner!(message)).toEqual(new Uint8Array(64).fill(7));
    expect(signer.signMessage).toHaveBeenCalledWith(message);
  });

  it("has no signer without a wallet", () => {
    const gateway = createGateway(loadConfig({}), {}) as unknown as { defaultSigner?: unknown };
    expect(gateway.defaultSigner).toBeUndefined();
  });
});
