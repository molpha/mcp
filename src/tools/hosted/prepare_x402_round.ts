import { z } from "zod";
import { requireChallengeKeys, sealChallenge } from "../../challenge.js";
import { getMolphaContext, type ToolDependencies } from "../../clients.js";
import { toolHandler } from "../../mcp.js";
import { parseSolanaPubkey } from "../../solana-address.js";
import { prepareX402Round, type X402PaidRound } from "../../x402.js";
import { prepareRound, roundInputSchema, type RoundArgs } from "../round.js";
import { walletAddressSchema } from "../schemas.js";
import { type ToolServer } from "../types.js";

/** What prepare_x402_round seals for execute_x402_round. */
export interface X402Challenge {
  round: X402PaidRound;
  chains: RoundArgs["chains"];
  maxAge?: number;
}

export const X402_CHALLENGE = "x402";

const inputSchema = {
  apiConfig: roundInputSchema.apiConfig,
  signaturesRequired: roundInputSchema.signaturesRequired,
  payer: walletAddressSchema.describe(
    "Base58 wallet that pays for the round and signs the returned transaction. It needs the round price in USDC; the facilitator pays the network fee."
  ),
  sourceId: roundInputSchema.sourceId,
  maxAge: roundInputSchema.maxAge,
  chains: roundInputSchema.chains
};

const outputSchema = z.object({
  payment: z.literal("x402"),
  unsignedTransaction: z
    .string()
    .describe("Base64 Solana v0 transaction. Sign it as `payer` and do not broadcast it: the gateway's facilitator co-signs and submits it."),
  challenge: z.string().describe("Opaque; pass it to execute_x402_round unchanged."),
  summary: z
    .object({
      amountAtomicUsdc: z.string().describe("USDC base units the transaction transfers: the protocol round price."),
      mint: z.string().describe("The protocol USDC mint."),
      payTo: z.string().describe("The protocol treasury owner (ProtocolConfig PDA), not the gateway."),
      payToAta: z.string().describe("The treasury's USDC account: the transfer's destination."),
      payer: z.string(),
      payerAta: z.string().describe("The payer's USDC account: the transfer's source."),
      feePayer: z.string().describe("The facilitator, which pays the network fee."),
      memo: z.string().describe("The request's commitment, carried in the transaction's Memo instruction."),
      network: z.string().describe("CAIP-2 id of the Solana cluster."),
      gateway: z.object({ endpoint: z.string(), pda: z.string() }),
      sourceId: z.string()
    })
    .describe("What the transaction does, verified against this server's own chain reads. Check it against your wallet's view before signing."),
  payerBalanceAtomicUsdc: z.string(),
  expiresAt: z.number().int().describe("Unix seconds after which execute_x402_round refuses the challenge."),
  lastValidBlockHeight: z.number().int().describe("The transaction's blockhash expires after this block height."),
  next: z.string()
});

interface Args extends Omit<RoundArgs, "autoSubmit" | "dryRun"> {
  payer: string;
}

export function registerPrepareX402RoundTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "prepare_x402_round",
    {
      title: "Prepare an x402-paid Molpha round",
      description:
        "Step 1 of a pay-per-request round for a wallet this server does not hold. Quotes the round, checks the gateway's payment requirements against this server's own chain reads (payTo is the protocol treasury owner — the ProtocolConfig PDA, not the gateway; asset the protocol USDC mint; amount the protocol round price; network the SOLANA_RPC cluster; memo the request's commitment), refuses above the MOLPHA_X402_MAX_PRICE_USDC per-round cap or the payer's USDC balance, and returns an unsigned USDC transfer from `payer` to that treasury. Nothing is signed, paid, or broadcast here. Sign `unsignedTransaction` with the payer's wallet (sign only — do not send), then call execute_x402_round with `challenge` and the signed transaction before `expiresAt`. Private API secrets are not supported on this path.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    toolHandler(outputSchema, async (args: Args) => {
      const keys = requireChallengeKeys(dependencies.hosted?.challengeKeys);
      const { apiConfig, signaturesRequired, maxAge, chains } = args;
      const payer = parseSolanaPubkey(args.payer, "payer");
      const context = await (dependencies.getContext ?? getMolphaContext)();

      const { round, transaction, payerAta, payToAta, payerBalanceAtomicUsdc } = await prepareX402Round(
        context,
        { apiConfig, signaturesRequired, sourceId: prepareRound(args), ...(maxAge !== undefined ? { maxAge } : {}) },
        payer
      );
      const expiresAt = Math.floor(Date.now() / 1000) + round.accepted.maxTimeoutSeconds;
      const sealed: X402Challenge = { round, chains, ...(maxAge !== undefined ? { maxAge } : {}) };

      return {
        payment: "x402",
        unsignedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
        challenge: sealChallenge(keys, X402_CHALLENGE, sealed, expiresAt),
        summary: {
          amountAtomicUsdc: round.amountAtomicUsdc,
          mint: round.asset,
          payTo: round.payTo,
          payToAta,
          payer: round.payer,
          payerAta,
          feePayer: round.feePayer,
          memo: round.memo,
          network: round.network,
          gateway: { endpoint: round.endpoint, pda: round.gatewayPda },
          sourceId: `0x${round.sourceId}`
        },
        payerBalanceAtomicUsdc,
        expiresAt,
        lastValidBlockHeight: round.lastValidBlockHeight,
        next: "Sign unsignedTransaction as the payer without broadcasting it, then call execute_x402_round with this challenge and the signed transaction."
      };
    })
  );
}
