import { z } from "zod";
import { guardSourceId, parseSource } from "../source.js";
import { toCanonicalHex } from "../hex.js";
import { getMolphaContext, requireMethod, type ToolDependencies } from "../clients.js";
import { settle } from "../errors.js";
import { decodeFeedValue, describeValueEncoding, presentFeed } from "../feed.js";
import { toolHandler } from "../mcp.js";
import { readSubscriptionStatus } from "../subscription.js";
import { chains, feedAccount, settleFailure, valueEncoding } from "./outputs.js";
import { signaturesRequiredSchema, sourceIdSchema, sourceSchema, submitterSchema } from "./schemas.js";
import { type ToolServer } from "./types.js";

const outputSchema = z.object({
  sourceId: z.string(),
  signaturesRequired: z.number().int(),
  submitter: z.string(),
  feed: z
    .union([feedAccount(), settleFailure()])
    .nullable()
    .describe("null until this submitter's first submit_attestation for (sourceId, signaturesRequired)."),
  valueEncoding: valueEncoding()
    .optional()
    .describe("When `source` is passed: how to read the stored 32 bytes, from the source's declared output (type and decimals), which the sourceId commits to."),
  note: z.string().optional(),
  subscription: z.object({
    active: z.boolean(),
    owner: z.string().optional(),
    planType: z.unknown().optional(),
    validUntil: z.string().optional().describe("Unix seconds, decimal string."),
    maxRounds: z.number().optional().describe("The plan's round quota; 0 means none. Rounds used are tracked by the gateway, not on-chain."),
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
        "Read the Solana feed account for (sourceId, signaturesRequired, submitter) — last committed value, timestamp, registryVersion, signersBitmap — and this signer's subscription status. Pass sourceId, or `source` (the source document) to derive it (see derive_source_id). Feeds are keyed per submitter: submitter defaults to this server's signer, so pass another wallet's address to read the feed it maintains. A null feed is normal before that submitter's first submit_attestation. `feed.valueKind` says whether the stored bytes are the signed value itself (\"value\") or the keccak256 of a preimage that was checked when it was submitted (\"hash\"); it is NOT a scale hint, and the feed account stores no decimals. The scale is declared by the source: when `source` is supplied, `valueEncoding` reports its output (type and decimals, committed by the sourceId and so attested) and `valueEncoding.decodedValue` renders the stored 32 bytes by it. With only a sourceId the scale cannot be known: pass the source.",
      inputSchema: {
        sourceId: sourceIdSchema.optional(),
        source: sourceSchema.optional(),
        signaturesRequired: signaturesRequiredSchema,
        submitter: submitterSchema
      },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    toolHandler(outputSchema, async (
      {
        sourceId,
        source,
        signaturesRequired,
        submitter
      }: {
        sourceId?: string;
        source?: z.infer<typeof sourceSchema>;
        signaturesRequired: number;
        submitter?: string;
      }
    ) => {
      const { config, solana, signer, hosted } = await (dependencies.getContext ?? getMolphaContext)();
      const parsed = source === undefined ? undefined : parseSource(source);
      if (!parsed && sourceId === undefined) throw new Error("either sourceId or source is required");
      const resolvedSourceId = parsed ? guardSourceId(sourceId, parsed) : toCanonicalHex(sourceId!, 32, "sourceId");
      if (!submitter && !signer) throw Object.assign(new Error("Pass submitter explicitly: this server has no signer to default to."), { code: "submitter_required" });
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

      const presented = onChainFeed.ok ? presentFeed(onChainFeed.value) : onChainFeed;
      const decodedValue =
        parsed && presented && !("ok" in presented) ? decodeFeedValue(presented.value, parsed.output) : undefined;

      return {
        sourceId: resolvedSourceId,
        signaturesRequired,
        submitter: feedSubmitter,
        feed: presented,
        ...(parsed
          ? {
              valueEncoding: {
                ...describeValueEncoding(parsed.output),
                ...(decodedValue !== undefined ? { decodedValue } : {})
              }
            }
          : {}),
        ...(subscription ? { subscription } : { note: "No subscription status: this server holds no signer. See describe_access for a wallet's subscription." }),
        chains: {
          solana: "devnet (canonical state)",
          evm: config.evmNetworks,
          starknet: config.starknetNetworks
        }
      };
    })
  );
}
