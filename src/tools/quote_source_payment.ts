import { z } from "zod";
import { getMolphaContext, type ToolDependencies } from "../clients.js";
import { toolHandler } from "../mcp.js";
import { describeQuote, eligibleSetSizeFor, evaluatePolicy, probeSourceTerms } from "../source-payment.js";
import { apiConfigSchema, signaturesRequiredSchema } from "./schemas.js";
import { type ToolServer } from "./types.js";

export const sourceQuoteSchema = z.object({
  network: z.string().describe("CAIP-2 network the source wants to be paid on."),
  asset: z.string().describe("Token contract (USDC)."),
  payTo: z.string().describe("The source's own payee. Molpha is never the payee of a source payment."),
  pricePerCallAtomic: z.string(),
  pricePerCallUsdc: z.string(),
  maxTimeoutSeconds: z.number().int(),
  requiresPaymentIdentifier: z.boolean(),
  eligibleSetSize: z.number().int().describe("Nodes that may fetch this round, so authorizations signed: every one that fetches is paid for."),
  worstCaseAtomic: z.string(),
  worstCaseUsdc: z.string().describe("Price per call x eligibleSetSize: the most this round can cost.")
});

export const paymentPolicySchema = z.object({
  enabled: z.boolean(),
  payer: z.string().optional().describe("The payer wallet's public address."),
  allowedNetworks: z.array(z.string()),
  networkAllowed: z.boolean().optional(),
  assetAllowed: z.boolean().optional().describe("Whether the source's token is USDC on that network."),
  perRoundCapUsdc: z.string(),
  dailyCapUsdc: z.string(),
  spentTodayUsdc: z.string(),
  wouldPay: z.boolean().describe("Whether this server would pay this round as configured."),
  reasons: z.array(z.string()).describe("Why not, when it would not.")
});

const outputSchema = z.object({
  source: z.string(),
  paywalled: z.boolean(),
  quote: sourceQuoteSchema.optional(),
  policy: paymentPolicySchema,
  note: z.string()
});

export function registerQuoteSourcePaymentTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "quote_source_payment",
    {
      title: "Quote the cost of a paywalled source",
      description:
        "Before paying for a round, read what it would cost. Makes ONE unpaid request to the source (a price fetch, not a data fetch) and returns the source's own price, network and payee, how many nodes will fetch (and so be paid for), the WORST CASE total (price per fetch x those nodes), and whether this server is configured to pay it: its payer, allowed networks and spend caps. Use it with a provider's x402 feed from get_provider, then pass sourcePayment.maxSpendUsdc to execute_subscription_round to authorize paying. Returns `paywalled: false` for a source that is free. Signs and spends nothing.",
      inputSchema: {
        apiConfig: apiConfigSchema,
        signaturesRequired: signaturesRequiredSchema.default(3).describe("The quorum you will request: it sets how many nodes may fetch. Provider feeds need at least 3.")
      },
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
    },
    toolHandler(outputSchema, async (args: { apiConfig: z.infer<typeof apiConfigSchema>; signaturesRequired: number }) => {
      const context = await (dependencies.getContext ?? getMolphaContext)();
      const terms = await probeSourceTerms(args.apiConfig);
      if (terms === null) {
        return {
          source: args.apiConfig.url,
          paywalled: false,
          policy: evaluatePolicy(context.config),
          note: "The source did not ask for payment: running it costs nothing beyond subscription quota."
        };
      }

      const eligible = await eligibleSetSizeFor(context, args.signaturesRequired);
      const quote = describeQuote(terms, eligible);
      const policy = evaluatePolicy(context.config, quote);
      return {
        source: args.apiConfig.url,
        paywalled: true,
        quote,
        policy,
        note: policy.wouldPay
          ? `This server would pay: pass sourcePayment.maxSpendUsdc of at least ${quote.worstCaseUsdc} to execute_subscription_round. You pay the source directly; Molpha never receives it. Only authorizations the nodes actually spend settle.`
          : "This server would not pay this round as configured: see policy.reasons. Nothing has been signed or spent."
      };
    })
  );
}
