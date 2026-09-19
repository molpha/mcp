import { z } from "zod";
import { resolveSourceId } from "../apiconfig.js";
import { getMolphaContext, requireMethod, type ToolDependencies } from "../clients.js";
import { settle } from "../errors.js";
import { describeValueEncoding, presentFeed } from "../feed.js";
import { toolHandler } from "../mcp.js";
import { readSubscriptionStatus } from "../subscription.js";
import { chains, feedAccount, settleFailure } from "./outputs.js";
import { apiConfigSchema, signaturesRequiredSchema, sourceIdSchema, submitterSchema } from "./schemas.js";
import { type ToolServer } from "./types.js";

const outputSchema = z.object({
  sourceId: z.string(),
  signaturesRequired: z.number().int(),
  submitter: z.string(),
  feed: z
    .union([feedAccount(), settleFailure()])
    .nullable()
    .describe("null until this submitter's first submit_attestation for (sourceId, signaturesRequired)."),
  valueEncoding: z
    .object({
      attested: z.literal(false),
      source: z.string(),
      valueTransform: z.string().nullable(),
      note: z.string()
    })
    .optional()
    .describe("When apiConfig is passed: the off-chain valueTransform behind the number. Unsigned provenance."),
  note: z.string().optional(),
  subscription: z.object({
    active: z.boolean(),
    owner: z.string().optional(),
    planType: z.unknown().optional(),
    validUntil: z.string().optional().describe("Unix seconds, decimal string."),
    usedRounds: z.number().optional(),
    maxRounds: z.number().optional().describe("0 means no round quota."),
    message: z.string().optional()
  }).optional(),
  chains: chains()
});

export function registerDescribeFeedTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "describe_feed",
    {
      title: "Describe Molpha feed",
      description:
        "Read the Solana feed account for (sourceId, signaturesRequired, submitter) — last committed value, canonicalTimestamp, registryVersion, signersBitmap — and this signer's subscription status. Pass sourceId, or apiConfig to derive it (see derive_source_id). Feeds are keyed per submitter: submitter defaults to this server's signer, so pass another wallet's address to read the feed it maintains. A null feed is normal before that submitter's first submit_attestation. `feed.valueKind` is the attested encoding of the stored bytes (\"value\" = raw payload, \"hash\" = keccak digest), NOT a scale hint: Molpha attests no decimals on-chain. When apiConfig is supplied, `valueEncoding` reports the off-chain valueTransform that produced the number, explicitly flagged as unattested.",
      inputSchema: {
        sourceId: sourceIdSchema.optional(),
        apiConfig: apiConfigSchema.optional(),
        signaturesRequired: signaturesRequiredSchema,
        submitter: submitterSchema
      },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    toolHandler(outputSchema, async (
      {
        sourceId,
        apiConfig,
        signaturesRequired,
        submitter
      }: {
        sourceId?: string;
        apiConfig?: z.infer<typeof apiConfigSchema>;
        signaturesRequired: number;
        submitter?: string;
      }
    ) => {
      const { config, solana, signer, hosted } = await (dependencies.getContext ?? getMolphaContext)();
      const resolvedSourceId = resolveSourceId(sourceId, apiConfig);
      if (!submitter && !signer) throw Object.assign(new Error("Pass submitter explicitly for unsigned hosted feed reads."), { code: "submitter_required" });
      const feedSubmitter = submitter ?? String(signer!.publicKey);

      const [onChainFeed, subscription] = await Promise.all([
        settle("solana.readFeed", async () =>
          requireMethod<[string, number, string], Promise<Record<string, unknown> | null>>(solana, "readFeed")(
            resolvedSourceId,
            signaturesRequired,
            feedSubmitter
          )
        ),
        signer ? readSubscriptionStatus(solana, hosted) : Promise.resolve(undefined)
      ]);

      return {
        sourceId: resolvedSourceId,
        signaturesRequired,
        submitter: feedSubmitter,
        feed: onChainFeed.ok ? presentFeed(onChainFeed.value) : onChainFeed,
        ...(apiConfig ? { valueEncoding: describeValueEncoding(apiConfig.valueTransform) } : {}),
        ...(subscription ? { subscription } : { note: "Signer subscription status is unavailable without managed-signer headers." }),
        chains: {
          solana: "devnet (canonical state)",
          evm: config.evmNetworks,
          starknet: config.starknetNetworks
        }
      };
    })
  );
}
