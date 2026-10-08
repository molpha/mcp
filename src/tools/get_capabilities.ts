import { z } from "zod";
import { getMolphaContext, getMolphaProgramId, requireMethod, type ToolDependencies } from "../clients.js";
import { settle } from "../errors.js";
import { toolHandler } from "../mcp.js";
import { getVerifierMetadata } from "../verifiers.js";
import { evaluatePolicy } from "../source-payment.js";
import { chains, settleFailure, verifierMetadata } from "./outputs.js";
import { paymentPolicySchema } from "./quote_source_payment.js";
import { type ToolServer } from "./types.js";

const outputSchema = z.object({
  programId: z.string(),
  runLevel: z
    .enum(["read-only", "dry-run", "live"])
    .describe(
      "What this server will do. `read-only`: no signer, only the read tools are offered. `dry-run`: writes are previewed and cannot be made live from a tool call. `live`: writes sign and spend (or, on the hosted server, return work for the caller's wallet to sign)."
    ),
  runLevelReason: z.string().describe("Why the server is at this level, and what changes it."),
  registryVersion: z.number().int().optional().describe("Absent when the registry could not be read."),
  signingScheme: z.string(),
  chains: chains(),
  gateways: z.array(
    z.object({
      url: z.string(),
      gatewayAuthority: z.string().describe("Configured authority, or a note that it is discovered via GET /v1/info.")
    })
  ),
  nodeCount: z.number().int(),
  nodes: z.union([
    z.array(
      z
        .object({
          index: z.number().int().optional().describe("Registry index: the node's signers-bitmap bit."),
          peerId: z.string().optional(),
          address: z.string().optional(),
          signingKey: z.string().optional()
        })
        .passthrough()
    ),
    settleFailure()
  ]),
  solanaRpc: z.string(),
  sourcePayment: paymentPolicySchema
    .describe("Whether this server can pay a paywalled source (a provider's x402 feed) and under what limits. Off unless a payer wallet and an allowed network are configured."),
  verifiers: verifierMetadata(),
  payment: z.object({
    subscription: z.literal("execute_subscription_round").optional().describe("Absent on a read-only server, which has no round tools."),
    x402: z.literal("execute_x402_round").optional().describe("Absent on a read-only server, which has no round tools."),
    x402Caps: z.object({ maxPriceUsdcAtomic: z.string(), maxSpendPerDayUsdcAtomic: z.string().optional(), dailyCapsEnabled: z.boolean().optional() }),
    signing: z
      .enum(["server", "caller", "none"])
      .describe("`server`: this server holds a signer and each operation is one call. `caller`: it holds none, and each operation is split around a signature from the caller's own wallet (see `steps`). `none`: it holds none and offers no write tools."),
    steps: z
      .object({
        subscription: z.array(z.string()),
        x402: z.array(z.string()),
        solanaSubmit: z.array(z.string())
      })
      .optional()
      .describe("With `signing: caller`: the tools to call, in order, for each operation. The caller's wallet signs between the first and the last.")
  })
});

export function registerGetCapabilitiesTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "get_capabilities",
    {
      title: "Get Molpha capabilities",
      description:
        "Returns the current Molpha verification surface: program id, active registryVersion, registered node set, gateway endpoints and their authorities, supported chains, signing scheme, the round tool for each payment path, and x402 spend caps. Call first to learn where a signed result can be verified.",
      inputSchema: {
        includeAbi: z.boolean().optional().describe("Include the EVM verifier ABI in the response.")
      },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    toolHandler(outputSchema, async ({ includeAbi = false }: { includeAbi?: boolean }) => {
      const { config, gateway, solana, hosted } = await (dependencies.getContext ?? getMolphaContext)();
      const [nodesResult, registryVersionResult] = await Promise.all([
        settle("gateway.getNodes", async () => requireMethod<[], Promise<unknown[]>>(gateway, "getNodes")()),
        settle("solana.getRegistryVersion", async () =>
          requireMethod<[], Promise<number>>(solana, "getRegistryVersion")()
        )
      ]);

      const nodes = nodesResult.ok ? nodesResult.value : [];
      const registryVersion = registryVersionResult.ok ? registryVersionResult.value : undefined;
      const verifiers = getVerifierMetadata(config, includeAbi);
      const { runLevel, runLevelReason } = deriveRunLevel(dependencies, config.guardrails.dryRunDefault);

      return {
        programId: getMolphaProgramId(),
        runLevel,
        runLevelReason,
        registryVersion,
        signingScheme: "PoP-Schnorr (secp256k1, two-nonce binding)",
        chains: {
          solana: "devnet (canonical state)",
          evm: config.evmNetworks,
          starknet: config.starknetNetworks
        },
        gateways: config.gatewayEndpoints.map((url, index) => ({
          url,
          gatewayAuthority: config.gatewayAuthorities[index] ?? "discovered via GET /v1/info"
        })),
        nodeCount: Array.isArray(nodes) ? nodes.length : 0,
        nodes: nodesResult.ok ? nodes : nodesResult,
        solanaRpc: hosted ? new URL(config.solanaRpc).origin : config.solanaRpc,
        sourcePayment: evaluatePolicy(config),
        verifiers,
        payment: {
          ...(dependencies.readOnly ? {} : { subscription: "execute_subscription_round", x402: "execute_x402_round" }),
          x402Caps: {
            maxPriceUsdcAtomic: config.x402.maxPriceUsdcAtomic.toString(),
            ...(config.x402.dailyCapsEnabled === false ? { dailyCapsEnabled: false } : { maxSpendPerDayUsdcAtomic: config.x402.maxSpendPerDayUsdcAtomic.toString() })
          },
          ...(dependencies.hosted
            ? {
                signing: "caller",
                steps: {
                  subscription: ["begin_session", "complete_session", "execute_subscription_round"],
                  x402: ["prepare_x402_round", "execute_x402_round"],
                  solanaSubmit: ["prepare_submit_attestation", "send_signed_transaction"]
                }
              }
            : { signing: dependencies.readOnly ? "none" : "server" })
        }
      };
    })
  );
}

/**
 * Hosted first: its tools never read MOLPHA_DRY_RUN, so reporting `dry-run` from it would claim a protection
 * that does not apply. Then read-only, then the config.
 */
function deriveRunLevel(
  dependencies: ToolDependencies,
  dryRunLocked: boolean
): { runLevel: "read-only" | "dry-run" | "live"; runLevelReason: string } {
  if (dependencies.hosted) {
    return {
      runLevel: "live",
      runLevelReason: "Hosted server: it holds no key. Every write is prepared here and signed by the caller's own wallet."
    };
  }
  if (dependencies.readOnly) {
    return {
      runLevel: "read-only",
      runLevelReason: `Read-only: ${dependencies.readOnly.reason}. Only the read tools are offered. To enable writes, the user configures a signer (see the setup docs) and restarts the server.`
    };
  }
  if (dryRunLocked) {
    return {
      runLevel: "dry-run",
      runLevelReason: "MOLPHA_DRY_RUN=true: write tools preview and a call cannot turn that off. To go live, the user sets MOLPHA_DRY_RUN=false in the server config and restarts it."
    };
  }
  return {
    runLevel: "live",
    runLevelReason: "Write tools sign and spend. Set MOLPHA_DRY_RUN=true to lock them to previews."
  };
}
