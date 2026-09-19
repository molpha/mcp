import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { stringifyToolJson, toolHandler } from "../../src/mcp.js";

describe("stringifyToolJson", () => {
  it("serializes SDK-native values into MCP text JSON", () => {
    const json = stringifyToolJson({
      bigintValue: 42n,
      publicKey: new PublicKey("11111111111111111111111111111111"),
      bnValue: new BN("12345678901234567890"),
      bytes: new Uint8Array([0, 1, 254, 255])
    });

    expect(JSON.parse(json)).toEqual({
      bigintValue: "42",
      publicKey: "11111111111111111111111111111111",
      bnValue: "12345678901234567890",
      bytes: "0001feff"
    });
  });
});

describe("toolHandler", () => {
  const schema = z.object({ amount: z.string(), note: z.string().optional() });

  it("returns the JSON-safe result as structuredContent and as the same JSON text", async () => {
    const result = await toolHandler(schema, () => ({ amount: 5n, note: undefined }))({});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ amount: "5" });
    expect(Object.keys(result.structuredContent!)).toEqual(["amount"]);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("keeps a result that misses its outputSchema, flagged as an error rather than dropped", async () => {
    const result = await toolHandler(schema, () => ({ amount: 5, signed: "artifact" }))({});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ amount: 5, signed: "artifact" });
    expect(JSON.parse(result.content[1]!.text)).toMatchObject({
      code: "output_schema_mismatch",
      message: expect.stringMatching(/amount: Expected string/)
    });
  });

  it("reports a thrown error as a normalized error without structuredContent", async () => {
    const result = await toolHandler(schema, () => {
      throw new Error("Subscription expired");
    })({});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: "subscription_inactive" });
  });
});
