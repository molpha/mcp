import { z } from "zod";

/**
 * A Molpha source document. Deliberately a permissive object, not a recursive schema of the whole format:
 * the transform is an expression tree with a few dozen operators, and a schema for it makes a fragile,
 * enormous tool JSON Schema that clients render badly. The document is validated where it is used, by the
 * SDK's `parseSource` (the same rules the gateway and nodes apply), and a rejection names the field's path.
 */
export const sourceSchema = z
  .record(z.unknown())
  .describe(
    [
      "A Molpha source document: what a feed reads, how the reads become one value, and how that value becomes the 32 signed bytes. sourceId = keccak256 of its canonical JSON; derive_source_id validates a source and has a worked example.",
      "Shape: {v:\"1\", inputs:{<name>:Input}, transform:Expr, assert:Expr[], output:{type,decimals}, aggregation:null|{mode:\"tolerance\",rule:\"median\",maxDeviationBps,maxAgeMs}}.",
      "Every key is present (an absent optional is null) and EVERY NUMBER IS A STRING (\"8\", never 8).",
      "1-4 inputs of kind http|evm|starknet|svm, each a read plus an explicit decoder; transform is a JSON AST over exact decimals; output.type is int256|uint256|bool|bytes32|string32|keccak256.",
      "aggregation null is exact mode; a tolerance aggregation needs output.type int256 and signaturesRequired >= 3.",
      "{{secret.NAME}} may stand only in an http input's URL after the host, a header value or body.text. A source payment or provider credential needs exactly one http input."
    ].join(" ")
  );

export type SourceSchema = z.infer<typeof sourceSchema>;

/** A full-width sourceId; tools echo it back `0x`-prefixed. */
export const sourceIdSchema = z
  .string()
  .regex(/^(0[xX])?[0-9a-fA-F]{64}$/, "expected a 32-byte sourceId as 64 hex chars (0x optional)")
  .describe("32-byte sourceId as hex (0x optional), from derive_source_id or a round's attestation.payload.");

export const signaturesRequiredSchema = z.number().int().positive().max(255);

/** Solana feeds are keyed per submitter, so feed reads name whose feed they mean. */
export const submitterSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "expected a base58 Solana address")
  .optional()
  .describe("Base58 wallet whose feed to read. Defaults to this server's signer, when it holds one; required on the hosted server and on a read-only one.");

/** A wallet the caller controls and names explicitly; the hosted server holds no wallet of its own. */
export const walletAddressSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "expected a base58 Solana address");
