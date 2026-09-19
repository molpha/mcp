import { z } from "zod";
import { getMolphaContext, getMolphaProgramId, requireMethod } from "../clients.js";
import { settle } from "../errors.js";
import { toolHandler } from "../mcp.js";
import { getVerifierMetadata } from "../verifiers.js";
import { chains, settleFailure, verifierMetadata } from "./outputs.js";
import { type ToolServer } from "./types.js";

const outputSchema = z.object({
  programId: z.string(),
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
  verifiers: verifierMetadata(),
  payment: z.object({
    subscription: z.literal("execute_subscription_round"),
    x402: z.literal("execute_x402_round"),
    x402Caps: z.object({ maxPriceUsdcAtomic: z.string(), maxSpendPerDayUsdcAtomic: z.string() })
  })
});

export function registerGetCapabilitiesTool(server: ToolServer): void {
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
      const { config, gateway, solana } = await getMolphaContext();
      const [nodesResult, registryVersionResult] = await Promise.all([
        settle("gateway.getNodes", async () => requireMethod<[], Promise<unknown[]>>(gateway, "getNodes")()),
        settle("solana.getRegistryVersion", async () =>
          requireMethod<[], Promise<number>>(solana, "getRegistryVersion")()
        )
      ]);

      const nodes = nodesResult.ok ? nodesResult.value : [];
      const registryVersion = registryVersionResult.ok ? registryVersionResult.value : undefined;
      const verifiers = getVerifierMetadata(config, includeAbi);

      return {
        programId: getMolphaProgramId(),
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
        solanaRpc: config.solanaRpc,
        verifiers,
        payment: {
          subscription: "execute_subscription_round",
          x402: "execute_x402_round",
          x402Caps: {
            maxPriceUsdcAtomic: config.x402.maxPriceUsdcAtomic.toString(),
            maxSpendPerDayUsdcAtomic: config.x402.maxSpendPerDayUsdcAtomic.toString()
          }
        }
      };
    })
  );
}
