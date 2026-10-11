import { z } from "zod";
import { getMolphaContext, type ToolDependencies } from "../../clients.js";
import { toolHandler } from "../../mcp.js";
import { executeSessionRound } from "../../session.js";
import { buildRoundResult, prepareRound, roundInputSchema, roundOutputShape, type RoundArgs } from "../round.js";
import { type ToolServer } from "../types.js";
import { gatewayEndpointSchema } from "./begin_session.js";

const inputSchema = {
  sessionToken: z.string().min(1).describe("The `sessionToken` complete_session returned."),
  apiConfig: roundInputSchema.apiConfig,
  signaturesRequired: roundInputSchema.signaturesRequired,
  sourceId: roundInputSchema.sourceId,
  maxAge: roundInputSchema.maxAge,
  chains: roundInputSchema.chains,
  gatewayEndpoint: gatewayEndpointSchema.optional()
};

const outputSchema = z.object(roundOutputShape("subscription"));

interface Args extends Omit<RoundArgs, "autoSubmit" | "dryRun"> {
  sessionToken: string;
  gatewayEndpoint?: string;
}

export function registerExecuteSessionRoundTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "execute_subscription_round",
    {
      title: "Execute subscription-paid Molpha round",
      description:
        "Run a threshold-signing round paid from a USDC subscription, authorized by a sign-in session (begin_session, then complete_session) instead of a key held by this server, and return the self-contained signed attestation PLUS prebuilt verifier arguments for each requested chain. The round is keyed by sourceId, derived here from apiConfig (see derive_source_id). The signed payload is the trust anchor — verify it or forward it to a contract; do not consume `value` alone. Each call consumes one round of the subscription's quota for the term (and of the delegate's own limit, when a delegate signed in). `session_invalid` means the token is unknown, expired or revoked: sign in again. A `forbidden` answer means the subscription is missing, expired or out of quota, or the delegate was removed (see describe_access). Private API secrets are not supported on the hosted server.",
      inputSchema,
      outputSchema,
      // Irreversibly consumes prepaid quota, and each call runs a new round.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    toolHandler(outputSchema, async (args: Args) => {
      const { sessionToken, apiConfig, signaturesRequired, maxAge, chains, gatewayEndpoint } = args;
      const context = await (dependencies.getContext ?? getMolphaContext)();
      const result = await executeSessionRound(context, {
        sessionToken,
        apiConfig,
        signaturesRequired,
        sourceId: prepareRound(args),
        gatewayEndpoint
      });
      return buildRoundResult(result, chains, context.config, "subscription", false, context, maxAge);
    })
  );
}
