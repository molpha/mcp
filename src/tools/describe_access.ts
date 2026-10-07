import { z } from "zod";
import { readAccess } from "../access.js";
import { getMolphaContext, type ToolDependencies } from "../clients.js";
import { toolHandler } from "../mcp.js";
import { parseSolanaPubkey } from "../solana-address.js";
import { walletAddressSchema } from "./schemas.js";
import { type ToolServer } from "./types.js";

const outputSchema = z.object({
  address: z.string(),
  owner: z.string().describe("The subscription owner the address was checked under."),
  role: z
    .enum(["owner", "delegate", "none"])
    .describe("`owner`: the address holds the subscription. `delegate`: the owner added it with add_delegate. `none`: it has no access under this owner."),
  subscription: z
    .object({
      owner: z.string(),
      planType: z.unknown(),
      validUntil: z.number().int().describe("Unix seconds at which the subscription term ends."),
      active: z.boolean().describe("Whether validUntil is in the future."),
      maxRounds: z.number().int().describe("Rounds the plan allows per term, across the owner and all delegates."),
      maxSigners: z.number().int().describe("Largest quorum the plan allows."),
      delegateCount: z.number().int(),
      maxDelegates: z.number().int()
    })
    .optional()
    .describe("The owner's Subscription account; absent when the owner has none."),
  delegate: z
    .object({
      account: z.string().describe("The Delegate account, seeds [\"molpha_delegate\", owner, address]."),
      maxDataRequests: z.number().int().describe("Rounds this delegate may request per term.")
    })
    .optional()
    .describe("The address's Delegate account under the owner; absent for the owner itself or when there is none."),
  effectiveMaxRounds: z
    .number()
    .int()
    .optional()
    .describe("Rounds this address may request per term: the smaller of the plan's maxRounds and its own maxDataRequests."),
  canRequestRounds: z.boolean().describe("Whether the address has a role under an active subscription."),
  note: z.string()
});

export function registerDescribeAccessTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "describe_access",
    {
      title: "Describe subscription access",
      description:
        "Read from chain whether a wallet may request subscription rounds, and under what limits: whether it is the subscription owner or a delegate the owner added (`add_delegate`), the plan's term, round and quorum limits, and the delegate's own round limit. Pass `owner` to check a delegate; a delegate account is keyed by owner and delegate, so it cannot be found without the owner. The program records limits, not use: the gateway counts rounds per term off chain, so this does not report remaining quota, and a delegate's limit is enforced by the gateway. An owner revokes a delegate with `remove_delegate`; there is no pause. Signs and spends nothing.",
      inputSchema: {
        address: walletAddressSchema.describe("Base58 wallet to check."),
        owner: walletAddressSchema
          .optional()
          .describe("Base58 subscription owner. Omit to check the address's own subscription.")
      },
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
    },
    toolHandler(outputSchema, async (args: { address: string; owner?: string }) => {
      const context = await (dependencies.getContext ?? getMolphaContext)();
      const address = parseSolanaPubkey(args.address, "address");
      const access = await readAccess(context, address, args.owner ? parseSolanaPubkey(args.owner, "owner") : address);
      const canRequestRounds = access.role !== "none" && access.subscription?.active === true;

      return {
        ...access,
        canRequestRounds,
        note:
          access.role === "none"
            ? access.subscription
              ? "This address is not the subscription owner and has no delegate account under it. The owner grants access with add_delegate."
              : "No subscription exists for this owner. Subscribe from the owner's wallet, or pay per request with x402."
            : canRequestRounds
              ? "Limits are per subscription term and enforced by the gateway, which counts rounds off chain; remaining quota is not on chain."
              : "The subscription term has ended. The owner must extend it before rounds can be requested."
      };
    })
  );
}
