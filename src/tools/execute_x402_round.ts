import { z } from "zod";
import { getMolphaContext, requireSigner, type ToolDependencies } from "../clients.js";
import { toolHandler } from "../mcp.js";
import { executeX402Round, previewX402Round, quoteX402Round } from "../x402.js";
import { buildRoundResult, prepareRound, roundInputSchema, roundOutputShape, type RoundArgs } from "./round.js";
import { type ToolServer } from "./types.js";

const outputSchema = z.object({
  ...roundOutputShape("x402"),
  paymentReceipt: z
    .object({
      endpoint: z.string(),
      network: z.string().describe("CAIP-2 id of the Solana cluster."),
      payer: z.string(),
      payTo: z.string().describe("The gateway authority."),
      asset: z.string().describe("USDC mint."),
      amountAtomicUsdc: z.string(),
      feePayer: z.string(),
      memo: z.string().describe("This round's commitment; find the transfer by it when reconciling."),
      transaction: z.string().optional().describe("Settlement transaction, when the gateway reports one.")
    })
    .optional()
    .describe("Live rounds: the USDC payment the round settled."),
  // Preview only: the verified quote, nothing signed.
  action: z.literal("execute_x402_round").optional(),
  sourceId: z.string().optional().describe("Preview only; a live round carries it in dataUpdate."),
  gateway: z.object({ endpoint: z.string(), authority: z.string(), pda: z.string() }).optional(),
  network: z.string().optional(),
  asset: z.string().optional(),
  priceAtomicUsdc: z.string().optional(),
  feePayer: z.string().optional(),
  memo: z.string().optional(),
  payer: z.string().optional(),
  payerUsdcAta: z.string().optional(),
  payerBalanceAtomicUsdc: z.string().optional(),
  shortfallAtomicUsdc: z.string().optional(),
  spentTodayAtomicUsdc: z.string().optional(),
  note: z.string().optional(),
  quoteOnly: z.literal(true).optional(),
  endpoint: z.string().optional(),
  paymentRequired: z.object({ x402Version: z.literal(2), accepts: z.array(z.record(z.unknown())) }).optional()
});

export function registerExecuteX402RoundTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "execute_x402_round",
    {
      title: "Execute x402-paid Molpha round",
      description:
        "Run a threshold-signing round paid per request with an x402 USDC payment — no subscription needed — and return the self-contained signed attestation PLUS prebuilt verifier arguments for each requested chain, and the payment receipt. Before signing, the server checks the gateway's payment requirements against its own chain reads (payTo is the gateway authority, asset the protocol USDC mint, amount the protocol round price, network the SOLANA_RPC cluster, memo this round's commitment); it then signs a USDC transfer from the signer's own token account, refusing above the MOLPHA_X402_MAX_PRICE_USDC per-round and MOLPHA_X402_MAX_SPEND_PER_DAY_USDC daily caps. The gateway's facilitator pays the network fee. Each live call pays for a new round; `dryRun: true` quotes and verifies the payment without signing. Call get_x402_status first to see the quoted price. The round is keyed by sourceId, derived here from apiConfig (see derive_source_id). The signed payload is the trust anchor — do not consume `value` alone. Only the `solana` leg can be settled from this server (via `autoSubmit`, or submit_attestation); `evm` and `starknet` return calldata only (see build_verifier_calldata). Private API secrets are not supported on this path — use execute_subscription_round.",
      inputSchema: roundInputSchema,
      outputSchema,
      // Irreversibly transfers USDC, and each call pays for a new round.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    toolHandler(outputSchema, async (args: RoundArgs) => {
      const { apiConfig, signaturesRequired, maxAge, chains, autoSubmit = false, dryRun } = args;
      const context = await (dependencies.getContext ?? getMolphaContext)();
      const isDryRun = dryRun ?? context.config.guardrails.dryRunDefault;
      const round = {
        apiConfig,
        signaturesRequired,
        sourceId: prepareRound(args),
        ...(maxAge !== undefined ? { maxAge } : {})
      };

      if (!context.signer) return quoteX402Round(context, round);
      requireSigner(context);

      if (isDryRun) {
        return {
          payment: "x402",
          ...(await previewX402Round(context, round)),
          ...(autoSubmit ? { autoSubmit: "would submit the signed attestation to Solana" } : {})
        };
      }

      const { result, payment } = await executeX402Round(context, round);
      return {
        ...(await buildRoundResult(result, chains, context.config, "x402", autoSubmit, context)),
        paymentReceipt: payment
      };
    })
  );
}
