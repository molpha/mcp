import { z } from "zod";
import { getMolphaContext, requireMethod, type ToolDependencies } from "../clients.js";
import { decodeFeedValue, describeValueEncoding, presentFeed } from "../feed.js";
import { toCanonicalHex } from "../hex.js";
import { toolHandler } from "../mcp.js";
import { guardSourceId, parseSource } from "../source.js";
import { feedAccount, valueEncoding } from "./outputs.js";
import { signaturesRequiredSchema, sourceIdSchema, sourceSchema, submitterSchema } from "./schemas.js";
import { type ToolServer } from "./types.js";

const outputSchema = z.object({
  sourceId: z.string(),
  signaturesRequired: z.number().int(),
  submitter: z.string(),
  feed: feedAccount()
    .nullable()
    .describe("null until this submitter's first submit_attestation for (sourceId, signaturesRequired)."),
  valueEncoding: valueEncoding()
    .optional()
    .describe("When `source` is passed: the source's declared output and the stored value rendered by it.")
});

export function registerGetLatestValueTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "get_latest_value",
    {
      title: "Get latest Molpha feed value",
      description:
        "Read the latest attested value stored on Solana for (sourceId, signaturesRequired, submitter). submitter defaults to this server's signer — feeds are keyed per submitter, so pass another wallet's address to read the feed it maintains; null means that submitter has not submitted this source at this quorum yet. Pass sourceId, or `source` (the source document, which derives it). `valueKind` says whether the stored bytes are the signed value (\"value\") or the keccak256 of a checked preimage (\"hash\") — it is not a scale hint, and the feed account stores no decimals. The scale is declared by the source's output: pass `source` and `valueEncoding` reports it (attested: the output is part of the sourceId every signature covers) and renders the stored value by it (`valueEncoding.decodedValue`); with only a sourceId the scale is not known.",
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
      const { solana, signer } = await (dependencies.getContext ?? getMolphaContext)();
      const readFeed = requireMethod<[string, number, string], Promise<Record<string, unknown> | null>>(
        solana,
        "readFeed"
      );
      const parsed = source === undefined ? undefined : parseSource(source);
      if (!parsed && sourceId === undefined) throw new Error("either sourceId or source is required");
      const canonicalSourceId = parsed ? guardSourceId(sourceId, parsed) : toCanonicalHex(sourceId!, 32, "sourceId");
      if (!submitter && !signer) throw Object.assign(new Error("Pass submitter explicitly: this server has no signer to default to."), { code: "submitter_required" });
      const feedSubmitter = submitter ?? String(signer!.publicKey);

      const feed = presentFeed(await readFeed(canonicalSourceId, signaturesRequired, feedSubmitter));
      const decodedValue = parsed && feed ? decodeFeedValue(feed.value, parsed.output) : undefined;

      return {
        sourceId: canonicalSourceId,
        signaturesRequired,
        submitter: feedSubmitter,
        feed,
        ...(parsed
          ? { valueEncoding: { ...describeValueEncoding(parsed.output), ...(decodedValue !== undefined ? { decodedValue } : {}) } }
          : {})
      };
    })
  );
}
