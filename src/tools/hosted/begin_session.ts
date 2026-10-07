import { z } from "zod";
import { getMolphaContext, type ToolDependencies } from "../../clients.js";
import { toolHandler } from "../../mcp.js";
import { beginSession } from "../../session.js";
import { parseSolanaPubkey } from "../../solana-address.js";
import { walletAddressSchema } from "../schemas.js";
import { type ToolServer } from "../types.js";

export const gatewayEndpointSchema = z
  .string()
  .url()
  .describe("Gateway base URL the session is with. Required only when this server is configured with several gateways.");

const outputSchema = z.object({
  message: z
    .string()
    .describe("The exact text to sign as a UTF-8 message with `address`: no prefix, no envelope, no trailing newline. It is not a transaction and moves no funds."),
  challenge: z.string().describe("Opaque; pass it to complete_session unchanged."),
  gatewayEndpoint: z.string().describe("The gateway the session will be with."),
  address: z.string(),
  owner: z.string().describe("The subscription owner the session is for."),
  expiresAt: z.number().int().describe("Unix seconds after which the gateway refuses the signed message."),
  next: z.string()
});

export function registerBeginSessionTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "begin_session",
    {
      title: "Begin a gateway sign-in",
      description:
        "Step 1 of signing in to a Molpha gateway with a wallet this server does not hold, to run subscription rounds. Returns a short Sign-In-With-Solana text message for `address` to sign. The message names the gateway, the program and the subscription owner, says it moves no funds, and expires in about five minutes; this server checks it states the configured gateway's terms before returning it. `address` must be the subscription owner, or a delegate the owner added — then pass the owner's address as `owner` (see describe_access). Sign `message` with the wallet's message-signing function (not a transaction), then call complete_session with `challenge` and the signature. Nothing is signed or stored here.",
      inputSchema: {
        address: walletAddressSchema.describe("Base58 wallet that will sign in: the subscription owner or one of its delegates."),
        owner: walletAddressSchema.optional().describe("Base58 subscription owner. Required for a delegate; omit when `address` is the owner."),
        gatewayEndpoint: gatewayEndpointSchema.optional()
      },
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true }
    },
    toolHandler(outputSchema, async (args: { address: string; owner?: string; gatewayEndpoint?: string }) => {
      const context = await (dependencies.getContext ?? getMolphaContext)();
      const begun = await beginSession(context, {
        address: parseSolanaPubkey(args.address, "address"),
        owner: args.owner ? parseSolanaPubkey(args.owner, "owner") : undefined,
        gatewayEndpoint: args.gatewayEndpoint
      });
      return {
        ...begun,
        next: "Sign `message` as UTF-8 text with the address's wallet, then call complete_session with this challenge and the signature."
      };
    })
  );
}
