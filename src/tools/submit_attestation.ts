import { z } from "zod";
import { signedAttestationSchema } from "../artifacts.js";
import { requireSigner, assertActive, getMolphaContext, type ToolDependencies } from "../clients.js";
import { prepareSignedResult, previewSubmit, submitSignedResult } from "../submit.js";
import { toolHandler } from "../mcp.js";
import { submitOutcome } from "./outputs.js";
import { type ToolServer } from "./types.js";

/** The flat gateway/SDK shape. */
const flatResultSchema = z.object({
  sourceId: z.string().min(1),
  value: z.string().optional(),
  valuePacked: z.string().optional(),
  timestamp: z.number().int(),
  registryVersion: z.number().int(),
  signaturesRequired: z.number().int(),
  signersBitmap: z.string().min(1),
  s: z.string().min(1),
  commitmentAddr: z.string().min(1),
  fresh: z.boolean().optional()
});

// The artifact shape is the round tools' output, accepted verbatim: extra keys
// (`value`, `payment`, `trustAnchor`, `verifierArgs`) ride along on a pasted
// round response, and passthrough keeps that from being a validation error.
const signedResultSchema = z.union([
  signedAttestationSchema.passthrough(),
  flatResultSchema.passthrough()
]);

const outputSchema = z.object({
  ...submitOutcome().partial().shape,
  action: z.literal("submit_attestation"),
  dryRun: z.literal(true).optional().describe("Present on a preview: nothing was sent."),
  summary: z
    .object({
      chain: z.literal("solana"),
      action: z.literal("submit_attestation"),
      sourceId: z.string(),
      signaturesRequired: z.number().int(),
      registryVersion: z.number().int(),
      submitter: z.string()
    })
    .optional()
    .describe("Preview only: the write a live call would make. A live call returns the submit outcome fields instead.")
});

export function registerSubmitAttestationTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "submit_attestation",
    {
      title: "Submit Molpha attestation to Solana",
      description:
        "Submit a signed attestation to Solana via the program's submit_attestation, writing the feed account for (sourceId, signaturesRequired, this signer) — created on the first submit. The program verifies the aggregate signature and accepts only an attestation newer than the one the feed holds, so resubmitting the same payload changes nothing. Pass the output of execute_subscription_round or execute_x402_round through unmodified — both the artifact shape ({ dataUpdate, signature }) and the flat shape ({ sourceId, s, commitmentAddr, timestamp }) are accepted, and short hex fields are zero-padded server-side. Permissionless on-chain; the owner key pays SOL fees and becomes the feed's submitter. EVM/Starknet execution is deliberately out of scope (see build_verifier_calldata) — use the verifier args from the round tools and call verify() yourself.",
      inputSchema: {
        result: signedResultSchema,
        dryRun: z.boolean().optional()
      },
      outputSchema,
      // Only ever advances this signer's own feed: the program rejects an attestation
      // that is not strictly newer, so a repeat call has no further effect.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    toolHandler(outputSchema, async (
      {
        result,
        dryRun
      }: {
        result: Record<string, unknown>;
        dryRun?: boolean;
      }
    ) => {
      const context = await (dependencies.getContext ?? getMolphaContext)();
      requireSigner(context);
      const { config, signer } = context;
      const isDryRun = dryRun ?? config.guardrails.dryRunDefault;
      const prepared = prepareSignedResult(result);

      if (isDryRun) {
        return previewSubmit("submit_attestation", prepared, String(signer.publicKey));
      }

      return submitSignedResult(prepared, context);
    })
  );
}
