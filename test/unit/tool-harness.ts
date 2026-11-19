import { z } from "zod";
import { type ToolDependencies } from "../../src/clients.js";
import { type JsonToolResult } from "../../src/mcp.js";
import { registerTools } from "../../src/tools/index.js";

export interface RegisteredTool {
  name: string;
  config: {
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
    outputSchema: z.AnyZodObject;
    annotations: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
  };
  handler: (args: Record<string, unknown>) => Promise<JsonToolResult>;
}

/** The stdio tool set, or the hosted one when `dependencies.hosted` is set. */
export function collectTools(dependencies: ToolDependencies = {}): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  registerTools(
    {
      registerTool: (name: string, config: RegisteredTool["config"], handler: RegisteredTool["handler"]) => {
        tools.push({ name, config, handler });
      }
    },
    dependencies
  );
  return tools;
}

/** Calls a tool with schema-parsed input and returns whatever it answered, error or not. */
export async function callToolRaw(
  name: string,
  args: Record<string, unknown>,
  dependencies: ToolDependencies = {}
): Promise<{ tool: RegisteredTool; result: JsonToolResult }> {
  const tool = collectTools(dependencies).find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`no tool named ${name}`);
  }
  return { tool, result: await tool.handler(z.object(tool.config.inputSchema).parse(args)) };
}

/** The normalized error a tool call failed with. */
export async function callToolError(
  name: string,
  args: Record<string, unknown>,
  dependencies: ToolDependencies = {}
): Promise<Record<string, unknown>> {
  const { result } = await callToolRaw(name, args, dependencies);
  if (!result.isError) {
    throw new Error(`${name} succeeded: ${result.content.map((block) => block.text).join("\n")}`);
  }
  return JSON.parse(result.content[result.content.length - 1]!.text) as Record<string, unknown>;
}

/**
 * Calls a tool the way the SDK does — input parsed against its inputSchema — and
 * insists on a structured success whose text block carries the same JSON.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  dependencies: ToolDependencies = {}
): Promise<Record<string, unknown>> {
  const { tool, result } = await callToolRaw(name, args, dependencies);
  if (result.isError || !result.structuredContent) {
    throw new Error(`${name} failed: ${result.content.map((block) => block.text).join("\n")}`);
  }
  if (JSON.stringify(JSON.parse(result.content[0]!.text)) !== JSON.stringify(result.structuredContent)) {
    throw new Error(`${name}: text block and structuredContent differ`);
  }
  tool.config.outputSchema.parse(result.structuredContent);
  return result.structuredContent;
}

/** Molpha Data read tools, on every server: list_data_templates, read_data and one tool per template. */
export const DATA_READ_TOOL_NAMES = [
  "compare_oracles",
  "get_aave4_health_factor",
  "get_aave4_hub",
  "get_aave4_spoke",
  "get_aave_health_factor",
  "get_aave_liquidation_distance",
  "get_aave_reserve",
  "get_aave_totals",
  "get_balance",
  "get_bea_series",
  "get_bls_series",
  "get_chain_head",
  "get_compound_market",
  "get_curve_oracle_price",
  "get_drand_randomness",
  "get_eia_series",
  "get_ekubo_price",
  "get_euler_vault",
  "get_fluid_token",
  "get_fx_reference_rate",
  "get_kamino_reserve",
  "get_lei_status",
  "get_lst_market_deviation",
  "get_lst_rate",
  "get_marginfi_bank",
  "get_median_price",
  "get_morpho_health_factor",
  "get_morpho_market",
  "get_oracle_staleness",
  "get_pool_price",
  "get_pool_reserve",
  "get_pool_snapshot",
  "get_pool_twap",
  "get_pool_twap_deviation",
  "get_reference_rate",
  "get_sky_savings_rate",
  "get_stablecoin_depeg",
  "get_storage_slot",
  "get_token_controls",
  "get_token_snapshot",
  "get_token_supply",
  "get_treasury_avg_rate",
  "get_treasury_debt",
  "get_vault_share_price",
  "get_vesu_market",
  "list_data_templates",
  "read_data",
  "reconcile_supply"
];

/** The Molpha Data write tool, offered only where the server signs. */
export const DATA_WRITE_TOOL_NAMES = ["execute_data_round"];

/** Every Molpha Data tool of a signing server. */
export const DATA_TOOL_NAMES = [...DATA_READ_TOOL_NAMES, ...DATA_WRITE_TOOL_NAMES].sort();
