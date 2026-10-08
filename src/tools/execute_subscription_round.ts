import { z } from "zod";
import { requireSigner, assertActive, getMolphaContext, requireMethod, type ToolDependencies } from "../clients.js";
import { parseUsdcAtomic } from "../config.js";
import { recordSourceSpend, refuseSourcePayment, withSourceSpendSerialization } from "../guardrails.js";
import { toolHandler } from "../mcp.js";
import {
  authorizePayment, createPayer, describeQuote, disabledError, eligibleSetSizeFor, payerAddress, probeSourceTerms,
  sourcePaymentEnabled
} from "../source-payment.js";
import { buildRoundResult, prepareRound, roundInputSchema, roundOutputShape, type RoundArgs } from "./round.js";
import { type ToolServer } from "./types.js";

const sourcePaymentResultSchema = z.object({
  paid: z.boolean().describe("Whether authorizations were signed for the source."),
  reason: z.string().optional().describe("Why nothing was paid, when nothing was."),
  payer: z.string().optional().describe("The payer wallet's public address."),
  network: z.string().optional(),
  authorizations: z.number().int().optional().describe("Authorizations signed: one per node that may fetch."),
  pricePerCallUsdc: z.string().optional(),
  upToUsdc: z.string().optional().describe("The most this round could have cost; only authorizations the nodes spent settle."),
  note: z.string().optional()
});

const outputSchema = z.object({
  ...roundOutputShape("subscription"),
  sourcePayment: sourcePaymentResultSchema.optional(),
  action: z.literal("execute_subscription_round").optional().describe("Preview only."),
  sourceId: z.string().optional().describe("Preview only; a live round carries it in dataUpdate."),
  signaturesRequired: z.number().int().optional().describe("Preview only; a live round carries it in dataUpdate.")
});

export function registerExecuteSubscriptionRoundTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "execute_subscription_round",
    {
      title: "Execute subscription-paid Molpha round",
      description:
        "Run a threshold-signing round paid from this signer's USDC subscription and return the self-contained signed attestation PLUS prebuilt verifier arguments for each requested chain. The round is keyed by sourceId, derived here from apiConfig (see derive_source_id). The signed payload is the trust anchor — verify it or forward it to a contract; do not consume `value` alone. Only the `solana` leg can be settled from this server (via `autoSubmit`, or by passing this tool's output to submit_attestation unmodified); `evm` and `starknet` return contract-ready calldata only — executing verify() there is the agent's job by design (see build_verifier_calldata). Each live call consumes one round of subscription quota. Fails if the gateway refuses the subscription (missing, expired, or out of quota); use execute_x402_round to pay for the round per request instead.",
      inputSchema: {
        ...roundInputSchema,
        encryptSecrets: z
          .record(z.string())
          .optional()
          .describe(
            "Private API secrets referenced as {{secret.<name>}} in apiConfig. Encrypted to each selected node after its key is checked against the on-chain registry; the gateway never sees plaintext."
          ),
        sourcePayment: z
          .object({
            maxSpendUsdc: z
              .string()
              .regex(/^\d+(\.\d{1,6})?$/, "a decimal USDC amount such as 0.04")
              .describe(
                "The most, in USDC, you authorize this round to pay the source in total. The source's own price is read first; if price per fetch x the nodes that may fetch exceeds this, or the server's caps, nothing is signed and the round is refused."
              )
          })
          .strict()
          .optional()
          .describe(
            "Authorize paying a paywalled source (for example a provider's x402 feed) from the payer wallet this server holds. Omit it and a paywalled source is refused with its quote, never paid. Off unless the server is configured with a payer key AND allowed networks. The source is paid directly; Molpha never receives it. Public sources only (not with encryptSecrets). There is no automatic retry once payment is signed: a retry would sign a fresh set. Call quote_source_payment first to see the price."
          )
      },
      outputSchema,
      // Irreversibly consumes prepaid quota, and each call runs a new round.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    toolHandler(outputSchema, async (args: RoundArgs & { encryptSecrets?: Record<string, string>; sourcePayment?: { maxSpendUsdc: string } }) => {
      const { apiConfig, signaturesRequired, maxAge, chains, encryptSecrets, autoSubmit = false, dryRun, sourcePayment } = args;
      const context = await (dependencies.getContext ?? getMolphaContext)();
      requireSigner(context);
      const { config, gateway } = context;
      const isDryRun = dryRun ?? config.guardrails.dryRunDefault;
      const sourceId = prepareRound(args);

      if (sourcePayment) {
        if (!sourcePaymentEnabled(config)) throw disabledError();
        if (encryptSecrets) refuseSourcePayment("Source payment is for public sources: it cannot be combined with encryptSecrets.");
      }

      if (isDryRun) {
        return {
          dryRun: true,
          action: "execute_subscription_round",
          payment: "subscription",
          sourceId,
          signaturesRequired,
          ...(autoSubmit ? { autoSubmit: "would submit the signed attestation to Solana" } : {}),
          ...(sourcePayment
            ? {
                sourcePayment: {
                  paid: false,
                  reason: "Dry run: the source was not probed and nothing was signed. Call quote_source_payment for the price.",
                  payer: payerAddress(config),
                  upToUsdc: sourcePayment.maxSpendUsdc
                }
              }
            : {})
        };
      }

      const requestSignedData = requireMethod<[Record<string, unknown>], Promise<Record<string, unknown>>>(
        gateway,
        "requestSignedData"
      );
      assertActive(context);

      // Paying a source: read its price, vet it against everything, record the spend, and only then let the SDK
      // sign the very terms that were vetted. Nothing is signed if any step refuses.
      let paid: z.infer<typeof sourcePaymentResultSchema> | undefined;
      let payment: Record<string, unknown> | undefined;
      if (sourcePayment) {
        const eligible = await eligibleSetSizeFor(context, signaturesRequired);
        const terms = await probeSourceTerms(apiConfig);
        if (terms === null) {
          paid = { paid: false, reason: "The source did not ask for payment, so none was made." };
        } else {
          const quote = describeQuote(terms, eligible);
          const authorized = parseUsdcAtomic(sourcePayment.maxSpendUsdc, 0n);
          const sp = await withSourceSpendSerialization(async () => {
            const allowed = authorizePayment(config, terms, quote, authorized);
            // Counted when committed, not when it settles: a signed authorization can settle whether or not the
            // round completes, so counting it only on success would let the cap be exceeded.
            recordSourceSpend(BigInt(quote.worstCaseAtomic));
            return allowed;
          });
          payment = {
            // One attempt only: a retry would sign a fresh set, and the cap above covers exactly one.
            maxRetries: 1,
            sourcePayment: { signer: createPayer(sp.payerKey as string), terms }
          };
          paid = {
            paid: true,
            payer: payerAddress(config),
            network: quote.network,
            authorizations: quote.eligibleSetSize,
            pricePerCallUsdc: quote.pricePerCallUsdc,
            upToUsdc: quote.worstCaseUsdc,
            note: "Paid to the source directly. Only authorizations the nodes actually spent settle; check the payer's balance for the exact amount."
          };
        }
      }

      if (context.lifecycle) context.lifecycle.effectStarted = true;
      const result = await requestSignedData({
        apiConfig,
        signaturesRequired,
        ...(maxAge !== undefined ? { maxAge } : {}),
        ...(encryptSecrets ? { encrypt: { secrets: encryptSecrets } } : {}),
        ...(payment ?? {})
      });

      return {
        ...(await buildRoundResult(result, chains, config, "subscription", autoSubmit, context, maxAge)),
        ...(paid ? { sourcePayment: paid } : {})
      };
    })
  );
}
