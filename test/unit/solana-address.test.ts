import { describe, expect, it } from "vitest";
import { parseSolanaPubkey, validateSolanaPubkey } from "../../src/solana-address.js";

describe("parseSolanaPubkey", () => {
  it("trims whitespace before decoding", () => {
    const key = parseSolanaPubkey(" 3g4kdSXTfQFF9hiGEHPcQygvZijMATuxZQvhHjVzcChU\n", "PRIVY_WALLET_ADDRESS");
    expect(key).toBe("3g4kdSXTfQFF9hiGEHPcQygvZijMATuxZQvhHjVzcChU");
  });

  it("names the env var when decoding fails", () => {
    expect(() => parseSolanaPubkey("<base58-solana-address>", "TURNKEY_WALLET_ADDRESS")).toThrow(
      'TURNKEY_WALLET_ADDRESS must be a valid Solana address'
    );
  });
});

describe("validateSolanaPubkey", () => {
  it("rejects placeholders", () => {
    const result = validateSolanaPubkey("<base58-solana-address>", "PRIVY_WALLET_ADDRESS");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("PRIVY_WALLET_ADDRESS");
    }
  });
});
