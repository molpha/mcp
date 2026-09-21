/**
 * What execute_subscription_round and execute_x402_round share: the round's
 * inputs, the sourceId guard, and the signed-artifact response (with the
 * optional Solana autoSubmit leg). Only how the round is paid for differs.
 */
import { z } from "zod";
import type { RequestContext } from "../clients.js";
import { resolveSourceId } from "../apiconfig.js";
import { normalizeSignedResult, signedArtifactSchema, toDataUpdateArtifact } from "../artifacts.js";
import { type MolphaConfig } from "../config.js";
import { settle } from "../errors.js";
import { prepareSignedResult, submitSignedResult } from "../submit.js";
import { buildVerifierArgsForChains, type ChainTarget } from "../verifiers.js";
import { submitFailure, submitOutcome, verifierArgs } from "./outputs.js";
import { apiConfigSchema, signaturesRequiredSchema, sourceIdSchema } from "./schemas.js";

export type RoundPayment = "subscription" | "x402";

/**
 * A round tool's response. outputSchema must be a single object, so the live
 * response and the dryRun preview share it: on a live round the signed-artifact
 * fields (signedArtifactSchema) are all present; on a preview, `dryRun` is.
 */
export function roundOutputShape<P extends RoundPayment>(payment: P) {
  return {
    payment: z.literal(payment),
    dryRun: z
      .literal(true)
      .optional()
      .describe("Present on a preview: nothing was signed, paid for, or submitted, and there is no signed artifact."),
    ...signedArtifactSchema.partial().shape,
    trustAnchor: z.string().optional(),
    verifierArgs: verifierArgs().optional(),
    submitted: z
      .union([submitOutcome(), submitFailure()])
      .optional()
      .describe("autoSubmit's Solana submit. A failure keeps the signed artifact above for a submit_attestation retry."),
    autoSubmit: z.string().optional().describe("Preview only: what autoSubmit would do.")
  };
}

export const roundInputSchema = {
  apiConfig: apiConfigSchema,
  signaturesRequired: signaturesRequiredSchema.default(1),
  sourceId: sourceIdSchema
    .optional()
    .describe("Optional guard: the round is refused unless apiConfig derives to this sourceId."),
  maxAge: z.number().int().nonnegative().optional(),
  chains: z.array(z.enum(["evm", "starknet", "solana"])).min(1),
  autoSubmit: z
    .boolean()
    .optional()
    .describe(
      "Submit the signed attestation to Solana in the same call, so a round-trip settle is one call instead of two. Requires \"solana\" in chains. Honours dryRun and the daily execute cap; a failed submit still returns the signed artifact so it can be retried via submit_attestation."
    ),
  dryRun: z.boolean().optional()
};

export interface RoundArgs {
  apiConfig: z.infer<typeof apiConfigSchema>;
  signaturesRequired: number;
  sourceId?: string;
  maxAge?: number;
  chains: ChainTarget[];
  autoSubmit?: boolean;
  dryRun?: boolean;
}

/** Derives the round's sourceId (checking the caller's guard) and validates autoSubmit. */
export function prepareRound({ apiConfig, sourceId, chains, autoSubmit = false }: RoundArgs): string {
  const resolvedSourceId = resolveSourceId(sourceId, apiConfig);

  if (autoSubmit && !chains.includes("solana")) {
    throw new Error(
      "autoSubmit settles on Solana; include \"solana\" in chains (EVM/Starknet have no in-MCP execution path)."
    );
  }

  return resolvedSourceId;
}

export async function buildRoundResult(
  result: Record<string, unknown>,
  chains: ChainTarget[],
  config: MolphaConfig,
  payment: RoundPayment,
  autoSubmit: boolean,
  context?: RequestContext
): Promise<Record<string, unknown>> {
  // Canonicalize once: the gateway emits minimal hex (a one-signer bitmap comes
  // back as "4"), which both the verifier-arg builders and submit_attestation
  // reject at their fixed widths.
  const normalized = normalizeSignedResult(result);
  const artifact = toDataUpdateArtifact(normalized);

  const out: Record<string, unknown> = {
    payment,
    ...artifact,
    trustAnchor:
      "Consume the signed dataUpdate + signature (and verify or forward). Do not trust `value` alone.",
    verifierArgs: buildVerifierArgsForChains(normalized, chains, config)
  };

  if (autoSubmit) {
    // A failed submit must not discard the signed artifact — the caller can
    // retry submit_attestation with the payload it is already holding.
    const submitted = await settle("solana.submitAttestation", async () =>
      submitSignedResult(prepareSignedResult(normalized), context)
    );
    out.submitted = submitted.ok
      ? submitted.value
      : {
          ok: false,
          ...submitted.error,
          retry: "Pass this response to submit_attestation unmodified to retry the Solana submit."
        };
  }

  return out;
}
