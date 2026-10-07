import { VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { openChallenge, requireChallengeKeys } from "../../challenge.js";
import { getMolphaContext, type ToolDependencies } from "../../clients.js";
import { toolHandler } from "../../mcp.js";
import { sendPreparedSubmit, type PreparedSubmit } from "../../submit-prepare.js";
import { submitOutcome } from "../outputs.js";
import { type ToolServer } from "../types.js";
import { SUBMIT_CHALLENGE } from "./prepare_submit_attestation.js";

const outputSchema = submitOutcome();

export function registerSendSignedTransactionTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "send_signed_transaction",
    {
      title: "Send a prepared, signed Solana transaction",
      description:
        "Step 2 of prepare_submit_attestation, for a wallet that can sign but not broadcast: sends the prepared transaction once the payer has signed it, waits for confirmation, and returns the feed written and the transaction signature. It sends only a transaction this server prepared — byte for byte, carrying the payer's valid signature — and nothing else; it is not a general relay. `transaction_expired` means the challenge or its blockhash lapsed (about a minute): prepare again. A wallet that can broadcast does not need this tool.",
      inputSchema: {
        challenge: z.string().min(1).describe("The `challenge` prepare_submit_attestation returned, unchanged."),
        signedTransaction: z
          .string()
          .min(1)
          .describe("prepare_submit_attestation's `unsignedTransaction`, signed by the payer and base64 encoded.")
      },
      outputSchema,
      // Only ever advances the payer's own feed: the program rejects an attestation that is not strictly newer.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    toolHandler(outputSchema, async (args: { challenge: string; signedTransaction: string }) => {
      const keys = requireChallengeKeys(dependencies.hosted?.challengeKeys);
      const prepared = openChallenge<PreparedSubmit>(keys, SUBMIT_CHALLENGE, args.challenge, "transaction_expired");
      let signed: VersionedTransaction;
      try {
        signed = VersionedTransaction.deserialize(Buffer.from(args.signedTransaction, "base64"));
      } catch {
        throw Object.assign(new Error("signedTransaction is not a base64-encoded Solana transaction"), {
          code: "signed_transaction_mismatch"
        });
      }
      return sendPreparedSubmit(await (dependencies.getContext ?? getMolphaContext)(), prepared, signed);
    })
  );
}
