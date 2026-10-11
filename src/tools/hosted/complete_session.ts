import { z } from "zod";
import { getMolphaContext, type ToolDependencies } from "../../clients.js";
import { toolHandler } from "../../mcp.js";
import { completeSession, type SignatureEncoding } from "../../session.js";
import { type ToolServer } from "../types.js";

const outputSchema = z.object({
  sessionToken: z
    .string()
    .describe("Bearer token for execute_subscription_round. Treat it as a credential: it admits rounds on this subscription until it expires."),
  gatewayEndpoint: z.string().describe("The gateway that issued the token; the only place it is valid."),
  sessionId: z.string().describe("Identifies the session in the gateway's records; not a credential."),
  authority: z.string().describe("The wallet that signed in."),
  owner: z.string().describe("The subscription owner it acts under."),
  role: z.string().describe("`owner` or `delegate`."),
  expiresAt: z.number().int().describe("Unix seconds at which the token stops working; sign in again for a new one."),
  note: z.string()
});

export function registerCompleteSessionTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "complete_session",
    {
      title: "Complete a gateway sign-in",
      description:
        "Step 2 of signing in: exchanges begin_session's message, signed by the wallet, for a session token. The signature must be the address's Ed25519 signature over the exact UTF-8 bytes of the message (base58, base64 or hex); a signature over a prefixed or wrapped message, such as `solana sign-offchain-message` produces, is refused with `invalid_signature`. The gateway then checks on chain that the signer is the subscription owner or its delegate. The token is short-lived (about 30 minutes, never past the subscription term), scoped to one wallet and one gateway, and passed to execute_subscription_round. It passes through this server on each call and is never stored here; to keep it off this server entirely, call the gateway's POST /v1/round/execute directly with `Authorization: Bearer`. A session only identifies the caller: the gateway re-reads the subscription and delegate from chain for every round, so removing the delegate ends its access whatever tokens it holds.",
      inputSchema: {
        challenge: z.string().min(1).describe("The `challenge` begin_session returned, unchanged."),
        signature: z.string().min(1).describe("The wallet's signature over begin_session's `message`."),
        signatureEncoding: z
          .enum(["base58", "base64", "hex"])
          .optional()
          .describe("How `signature` is encoded. Omit to detect it.")
      },
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    toolHandler(outputSchema, async (args: { challenge: string; signature: string; signatureEncoding?: SignatureEncoding }) => {
      const context = await (dependencies.getContext ?? getMolphaContext)();
      return {
        ...(await completeSession(context, args)),
        note: "Pass sessionToken (and gatewayEndpoint, when several gateways are configured) to execute_subscription_round."
      };
    })
  );
}
