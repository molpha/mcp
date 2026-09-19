import { z } from "zod";
import { signedDataUpdateSchema, signedSignatureSchema, toSignedResult } from "../artifacts.js";
import { loadConfig } from "../config.js";
import { toolHandler } from "../mcp.js";
import { buildVerifierArgsForChains, getVerifierMetadata, type ChainTarget } from "../verifiers.js";
import { verifierArgs, verifierMetadata } from "./outputs.js";
import { type ToolServer } from "./types.js";

const chainSchema = z.enum(["evm", "starknet"]);

const outputSchema = z.object({
  chain: chainSchema,
  verifierArgs: verifierArgs(),
  note: z.string(),
  verifiers: verifierMetadata()
});

export function registerBuildVerifierCalldataTool(server: ToolServer): void {
  server.registerTool(
    "build_verifier_calldata",
    {
      title: "Build Molpha verifier calldata",
      description:
        "Build the verifier address and verify() call args for a signed attestation on EVM or Starknet. This tool does not verify anything: it stops at calldata by design, not by omission. The Molpha verifier is stateless, so the agent (or its contract) executes verify() itself, and the server never submits an EVM/Starknet transaction or vouches for a result it did not verify on-chain. There is no EVM/Starknet execution path anywhere in this MCP server. For Solana, submit the attestation via submit_attestation (or a round tool's autoSubmit) — the program accepts it only if the aggregate signature verifies — and read it back with get_latest_value; there is no separate simulate-verify path. Takes the dataUpdate/signature objects from execute_subscription_round / execute_x402_round verbatim; short hex fields are zero-padded to their canonical widths server-side. Local computation: no wallet, no network call.",
      inputSchema: {
        dataUpdate: signedDataUpdateSchema.passthrough(),
        signature: signedSignatureSchema.passthrough(),
        chain: chainSchema,
        includeAbi: z.boolean().optional()
      },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    toolHandler(outputSchema, (
      {
        dataUpdate,
        signature,
        chain,
        includeAbi = false
      }: {
        dataUpdate: Record<string, unknown>;
        signature: Record<string, unknown>;
        chain: ChainTarget;
        includeAbi?: boolean;
      }
    ) => {
      const config = loadConfig();
      const result = toSignedResult({ dataUpdate, signature });

      return {
        chain,
        verifierArgs: buildVerifierArgsForChains(result, [chain], config),
        note: "Calldata only. Execute verify() on-chain with these args; the MCP server does not assert validity.",
        verifiers: getVerifierMetadata(config, includeAbi)
      };
    })
  );
}
