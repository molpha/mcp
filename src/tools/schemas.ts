import { z } from "zod";

/**
 * Median tolerance mode. Part of the sourceId, so it is omitted for exact mode:
 * `mode: "exact"` is rejected because writing it would change the source's identity.
 */
export const aggregationSchema = z
  .object({
    mode: z.literal("tolerance"),
    rule: z.literal("median"),
    maxDeviationBps: z
      .number()
      .int()
      .min(0)
      .max(0xffff_ffff)
      .describe("Basis points a node's observation may sit from the lower-median reference before it is excluded."),
    maxAgeMs: z.number().int().positive().describe("Observations older than this (ms) at signing time are excluded."),
    numeric: z
      .object({
        type: z.literal("int256"),
        decimals: z.number().int().min(0).max(255).describe("The transformed value is scaled by 10^decimals, rounded half to even.")
      })
      .strict()
  })
  .strict();

/** Shared apiConfig input shape for tools that accept a declarative source. */
export const apiConfigSchema = z.object({
  url: z.string().min(1),
  method: z.enum(["GET", "POST"]).optional(),
  headers: z.record(z.string()).optional(),
  responseParser: z.string().min(1),
  valueTransform: z.string().optional(),
  aggregation: aggregationSchema
    .optional()
    .describe(
      "Opt in to median tolerance mode so independent nodes need not fetch a byte-identical value. Needs signaturesRequired >= 3 and changes the sourceId. The signed value is a signed int256 scaled by 10^numeric.decimals, so leave valueTransform empty (a multiply: transform truncates to an integer first). Omit for exact mode."
    )
});

export type ApiConfigSchema = z.infer<typeof apiConfigSchema>;

/** A full-width sourceId; tools echo it back `0x`-prefixed. */
export const sourceIdSchema = z
  .string()
  .regex(/^(0[xX])?[0-9a-fA-F]{64}$/, "expected a 32-byte sourceId as 64 hex chars (0x optional)")
  .describe("32-byte sourceId as hex (0x optional), from derive_source_id or a round's dataUpdate.");

export const signaturesRequiredSchema = z.number().int().positive().max(255);

/** Solana feeds are keyed per submitter, so feed reads name whose feed they mean. */
export const submitterSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "expected a base58 Solana address")
  .optional()
  .describe("Base58 wallet whose feed to read. Defaults to this server's signer.");
