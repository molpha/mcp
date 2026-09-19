import { z } from "zod";
import { getMolphaContext, requireMethod } from "../clients.js";
import { toolHandler } from "../mcp.js";
import { buildRoundResult, prepareRound, roundInputSchema, roundOutputShape, type RoundArgs } from "./round.js";
import { type ToolServer } from "./types.js";

const outputSchema = z.object({
  ...roundOutputShape("subscription"),
  action: z.literal("execute_subscription_round").optional().describe("Preview only."),
  sourceId: z.string().optional().describe("Preview only; a live round carries it in dataUpdate."),
  signaturesRequired: z.number().int().optional().describe("Preview only; a live round carries it in dataUpdate.")
});

export function registerExecuteSubscriptionRoundTool(server: ToolServer): void {
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
          )
      },
      outputSchema,
      // Irreversibly consumes prepaid quota, and each call runs a new round.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    toolHandler(outputSchema, async (args: RoundArgs & { encryptSecrets?: Record<string, string> }) => {
      const { apiConfig, signaturesRequired, maxAge, chains, encryptSecrets, autoSubmit = false, dryRun } = args;
      const { config, gateway } = await getMolphaContext();
      const isDryRun = dryRun ?? config.guardrails.dryRunDefault;
      const sourceId = prepareRound(args);

      if (isDryRun) {
        return {
          dryRun: true,
          action: "execute_subscription_round",
          payment: "subscription",
          sourceId,
          signaturesRequired,
          ...(autoSubmit ? { autoSubmit: "would submit the signed attestation to Solana" } : {})
        };
      }

      const requestSignedData = requireMethod<[Record<string, unknown>], Promise<Record<string, unknown>>>(
        gateway,
        "requestSignedData"
      );
      const result = await requestSignedData({
        apiConfig,
        signaturesRequired,
        ...(maxAge !== undefined ? { maxAge } : {}),
        ...(encryptSecrets ? { encrypt: { secrets: encryptSecrets } } : {})
      });

      return buildRoundResult(result, chains, config, "subscription", autoSubmit);
    })
  );
}
