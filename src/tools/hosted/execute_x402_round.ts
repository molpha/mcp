import { VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { openChallenge, requireChallengeKeys } from "../../challenge.js";
import { getMolphaContext, type ToolDependencies } from "../../clients.js";
import { toolHandler } from "../../mcp.js";
import { executePreparedX402Round } from "../../x402.js";
import { x402PaymentReceipt } from "../outputs.js";
import { buildRoundResult, roundOutputShape } from "../round.js";
import { type ToolServer } from "../types.js";
import { X402_CHALLENGE, type X402Challenge } from "./prepare_x402_round.js";

const inputSchema = {
  challenge: z.string().min(1).describe("The `challenge` prepare_x402_round returned, unchanged."),
  signedTransaction: z
    .string()
    .min(1)
    .describe("prepare_x402_round's `unsignedTransaction`, signed by the payer and base64 encoded. It must not have been broadcast.")
};

const outputSchema = z.object({
  ...roundOutputShape("x402"),
  paymentReceipt: x402PaymentReceipt().optional().describe("The USDC payment the round settled.")
});

export function registerExecutePreparedX402RoundTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "execute_x402_round",
    {
      title: "Execute a prepared x402-paid Molpha round",
      description:
        "Step 2 of a pay-per-request round: sends the payment prepare_x402_round built, once the payer's own wallet has signed it, and returns the self-contained signed attestation PLUS prebuilt verifier arguments for each chain requested at prepare time, and the payment receipt. The signed transaction is accepted only if it is byte-for-byte the prepared one carrying the payer's valid signature; anything else is refused before any payment is sent. This call pays: the USDC transfer settles when the round completes. A prepared payment buys one round — calling again with the same challenge is refused by the gateway, so prepare a new one for another round. `payment_expired` means the challenge or its blockhash lapsed (about a minute): call prepare_x402_round again. The signed payload is the trust anchor — do not consume `value` alone.",
      inputSchema,
      outputSchema,
      // Irreversibly transfers USDC.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    toolHandler(outputSchema, async (args: { challenge: string; signedTransaction: string }) => {
      const keys = requireChallengeKeys(dependencies.hosted?.challengeKeys);
      const { round, chains, maxAge } = openChallenge<X402Challenge>(keys, X402_CHALLENGE, args.challenge, "payment_expired");
      const signed = decodeTransaction(args.signedTransaction);
      const context = await (dependencies.getContext ?? getMolphaContext)();

      // Past this height no validator will accept the payment, so the gateway could only fail it.
      if ((await context.connection.getBlockHeight()) > round.lastValidBlockHeight) {
        throw Object.assign(new Error("the prepared payment's blockhash has expired; prepare it again"), { code: "payment_expired" });
      }

      const { result, payment } = await executePreparedX402Round(context, round, signed);
      return {
        ...(await buildRoundResult(result, chains, context.config, "x402", false, context, maxAge)),
        paymentReceipt: payment
      };
    })
  );
}

function decodeTransaction(encoded: string): VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(Buffer.from(encoded, "base64"));
  } catch {
    throw Object.assign(new Error("signedTransaction is not a base64-encoded Solana transaction"), {
      code: "signed_transaction_mismatch"
    });
  }
}
