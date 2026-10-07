import { z } from "zod";
import { requireChallengeKeys, sealChallenge } from "../../challenge.js";
import { getMolphaContext, type ToolDependencies } from "../../clients.js";
import { toolHandler } from "../../mcp.js";
import { parseSolanaPubkey } from "../../solana-address.js";
import { prepareSignedResult } from "../../submit.js";
import { prepareSubmit } from "../../submit-prepare.js";
import { walletAddressSchema } from "../schemas.js";
import { signedResultSchema } from "../submit_attestation.js";
import { type ToolServer } from "../types.js";

export const SUBMIT_CHALLENGE = "submit";
/** A Solana blockhash is good for about a minute; a challenge that outlived it would be useless. */
const CHALLENGE_SECONDS = 90;

const outputSchema = z.object({
  action: z.literal("submit_attestation"),
  unsignedTransaction: z
    .string()
    .describe("Base64 Solana v0 transaction with `payer` as fee payer and only signer. Sign it; then broadcast it yourself or pass it to send_signed_transaction."),
  challenge: z.string().describe("Opaque; pass it to send_signed_transaction unchanged."),
  summary: z.object({
    chain: z.literal("solana"),
    action: z.literal("submit_attestation"),
    sourceId: z.string(),
    signaturesRequired: z.number().int(),
    registryVersion: z.number().int(),
    submitter: z.string().describe("The payer: it pays the SOL fee and the feed is keyed to it."),
    feed: z.string().describe("Feed PDA the transaction writes; created on the first submit.")
  }),
  expiresAt: z.number().int().describe("Unix seconds after which send_signed_transaction refuses the challenge."),
  lastValidBlockHeight: z.number().int().describe("The transaction's blockhash expires after this block height."),
  next: z.string()
});

export function registerPrepareSubmitAttestationTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "prepare_submit_attestation",
    {
      title: "Prepare a Solana attestation submit",
      description:
        "Step 1 of writing a signed attestation to Solana from a wallet this server does not hold. Builds the program's submit_attestation transaction for (sourceId, signaturesRequired, payer) — the feed account is created on the first submit — and returns it unsigned. `payer` pays the SOL fee and rent and becomes the feed's submitter; it is the transaction's only signer. Pass the output of execute_subscription_round or execute_x402_round as `result`, unmodified. Sign `unsignedTransaction` with the payer's wallet, then either broadcast it yourself or call send_signed_transaction with `challenge` and the signed transaction. The program verifies the aggregate signature and accepts only an attestation newer than the one the feed holds. Nothing is signed or sent here. EVM/Starknet execution is out of scope (see build_verifier_calldata).",
      inputSchema: {
        result: signedResultSchema,
        payer: walletAddressSchema.describe("Base58 wallet that signs and pays for the submit; the feed is keyed to it.")
      },
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    toolHandler(outputSchema, async (args: { result: Record<string, unknown>; payer: string }) => {
      const keys = requireChallengeKeys(dependencies.hosted?.challengeKeys);
      const payer = parseSolanaPubkey(args.payer, "payer");
      const context = await (dependencies.getContext ?? getMolphaContext)();
      const { prepared, transaction } = await prepareSubmit(context, prepareSignedResult(args.result), payer);
      const expiresAt = Math.floor(Date.now() / 1000) + CHALLENGE_SECONDS;

      return {
        action: "submit_attestation",
        unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
        challenge: sealChallenge(keys, SUBMIT_CHALLENGE, prepared, expiresAt),
        summary: {
          chain: "solana",
          action: "submit_attestation",
          sourceId: prepared.sourceId,
          signaturesRequired: prepared.signaturesRequired,
          registryVersion: prepared.registryVersion,
          submitter: prepared.payer,
          feed: prepared.feed
        },
        expiresAt,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        next: "Sign unsignedTransaction as the payer, then broadcast it yourself or call send_signed_transaction with this challenge and the signed transaction."
      };
    })
  );
}
