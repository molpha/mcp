/**
 * Molpha Data tools (decision D12, named verb-first like every tool here): list_data_templates, read_data, and one tool per template of the catalog
 * snapshot this release was built with (src/data-catalog.generated.ts).
 *
 * An unsigned read is the Molpha Data service's own observation: free, rate limited, no signature.
 * A signed read never goes through the service: the template is derived there, the source is re-hashed
 * here, and the round runs through this server's own execute_subscription_round or execute_x402_round,
 * so their dry-run lock, spend caps and treasury checks apply unchanged.
 */
import { z } from "zod";
import { getMolphaContext, type ToolDependencies } from "../clients.js";
import { DATA_CATALOG } from "../data-catalog.generated.js";
import { deriveSource, listTemplates, unsignedRead, type DataRequest, type DataTemplate } from "../data.js";
import { errorResult, jsonResult, type JsonToolResult } from "../mcp.js";
import { registerExecuteSubscriptionRoundTool } from "./execute_subscription_round.js";
import { registerExecuteX402RoundTool } from "./execute_x402_round.js";
import { type ToolServer } from "./types.js";

/** Tool names for the catalog's templates; a template not listed gets `data_<id>`. */
const TOOL_NAMES: Record<string, string> = {
  "account.balance": "get_balance",
  "chain.head": "get_chain_head",
  "curve.priceOracle": "get_curve_oracle_price",
  "dex.pool.price": "get_pool_price",
  "dex.pool.reserves": "get_pool_reserve",
  "dex.pool.snapshot": "get_pool_snapshot",
  "dex.pool.twap": "get_pool_twap",
  "erc4626.sharePrice": "get_vault_share_price",
  "evm.storage": "get_storage_slot",
  "lending.aave.reserve": "get_aave_reserve",
  "lending.aave.totals": "get_aave_totals",
  "lending.morpho.market": "get_morpho_market",
  "lst.rate": "get_lst_rate",
  "oracle.compare": "compare_oracles",
  "position.aave.health": "get_aave_health_factor",
  "position.aave.liquidationDistance": "get_aave_liquidation_distance",
  "position.morpho.health": "get_morpho_health_factor",
  "price.median": "get_median_price",
  "supply.reconcile": "reconcile_supply",
  "token.snapshot": "get_token_snapshot",
  "token.supply": "get_token_supply"
};

export function dataToolName(id: string): string {
  return TOOL_NAMES[id] ?? `data_${id.replace(/[^A-Za-z0-9]/g, "_")}`;
}

/** D8: one default quorum, the tolerance minimum. */
const DEFAULT_SIGNATURES = 3;

const signingInput = {
  attest: z
    .boolean()
    .optional()
    .describe(
      "false (default): the Molpha Data service's own unsigned read, free and rate limited. true: a threshold-signed round of the same source, paid as `payment` says; it spends quota or USDC."
    ),
  payment: z
    .enum(["subscription", "x402"])
    .optional()
    .describe("Signed reads: pay from this signer's subscription (default) or per round with x402 USDC (see execute_x402_round)."),
  signaturesRequired: z.number().int().min(1).max(255).optional().describe(`Signed reads: the quorum (default ${DEFAULT_SIGNATURES}).`),
  chains: z
    .array(z.enum(["evm", "starknet", "solana"]))
    .min(1)
    .optional()
    .describe("Signed reads: build verifier arguments for these chains (default all three)."),
  autoSubmit: z.boolean().optional().describe("Signed reads: also submit the attestation to Solana (needs \"solana\" in chains)."),
  maxAge: z.number().int().nonnegative().optional().describe("Signed reads: the verifier freshness window in seconds."),
  dryRun: z.boolean().optional().describe("Signed reads: preview the round without signing or paying.")
};

/** Where this server cannot sign (hosted, read-only), attest only returns the derived source. */
const deriveOnlyInput = {
  attest: z
    .boolean()
    .optional()
    .describe(
      "false (default): the Molpha Data service's own unsigned read. true: return the derived `source` and its sourceId, for a signed round with the session or x402 tools; this server signs nothing itself."
    )
};

function signingInputFor(dependencies: ToolDependencies): Record<string, z.ZodTypeAny> {
  return dependencies.hosted || dependencies.readOnly ? deriveOnlyInput : signingInput;
}

type SigningArgs = {
  attest?: boolean;
  payment?: "subscription" | "x402";
  signaturesRequired?: number;
  chains?: Array<"evm" | "starknet" | "solana">;
  autoSubmit?: boolean;
  maxAge?: number;
  dryRun?: boolean;
};

const outputSchema = z.object({
  mode: z.enum(["unsigned", "signed", "derived"]).describe(
    "unsigned: the service's observation; signed: a threshold-signed round (see `round`); derived: the source only, for a server that cannot sign here."
  ),
  template: z.string().nullable().optional(),
  params: z.record(z.unknown()).nullable().optional(),
  sourceId: z.string(),
  source: z.record(z.unknown()).describe("The canonical source document, re-hashed here to sourceId."),
  facts: z.record(z.string()).nullable().optional().describe("What the template read when it derived the source (decimals, tokens)."),
  value: z.string().optional().describe("Unsigned reads: the value, rendered. Never consume it alone for settlement."),
  data: z.record(z.unknown()).optional(),
  read: z.record(z.unknown()).optional(),
  payload: z.string().nullable().optional(),
  layout: z.array(z.unknown()).optional(),
  fields: z.record(z.string()).optional().describe("Decoded from payload by the service: recomputed, not signed."),
  round: z.record(z.unknown()).optional().describe("Signed reads: the round tool's full output (attestation, verifierArgs, payment)."),
  next: z.string().optional()
});

type RoundTool = { inputSchema: Record<string, z.ZodTypeAny>; handler: (args: Record<string, unknown>) => Promise<JsonToolResult> };

/** The round tool's own registration, captured, so a signed read runs exactly that tool's code. */
function roundTool(payment: "subscription" | "x402", dependencies: ToolDependencies): RoundTool {
  let captured: RoundTool | undefined;
  const capture: ToolServer = {
    registerTool: (_name: string, config: { inputSchema: Record<string, z.ZodTypeAny> }, handler: RoundTool["handler"]) => {
      captured = { inputSchema: config.inputSchema, handler };
    }
  };
  if (payment === "x402") registerExecuteX402RoundTool(capture, dependencies);
  else registerExecuteSubscriptionRoundTool(capture, dependencies);
  return captured!;
}

async function runDataRead(req: DataRequest, args: SigningArgs, dependencies: ToolDependencies): Promise<JsonToolResult> {
  const { config } = await (dependencies.getContext ?? getMolphaContext)();
  const templateOf = (r: DataRequest) => ("template" in r ? r.template : null);

  if (!args.attest) {
    const env = await unsignedRead(config, req);
    return jsonResult(
      {
        mode: "unsigned",
        template: env.template,
        params: env.params,
        sourceId: env.source.sourceId,
        source: env.source.config,
        facts: env.facts,
        value: env.data.value,
        data: env.data,
        read: env.read,
        payload: env.payload,
        ...(env.layout ? { layout: env.layout } : {}),
        ...(env.fields ? { fields: env.fields } : {}),
        next: "This is the service's own unsigned read. For a value a contract can verify, call again with attest: true."
      },
      outputSchema
    );
  }

  const derived = await deriveSource(config, req);
  const base = {
    template: derived.template ?? templateOf(req),
    params: derived.params ?? null,
    sourceId: derived.sourceId,
    source: derived.source,
    facts: derived.facts ?? null
  };
  if (dependencies.hosted || dependencies.readOnly) {
    return jsonResult(
      {
        mode: "derived",
        ...base,
        next: dependencies.hosted
          ? "This hosted server signs nothing itself: run this source with execute_session_round (after begin_session/complete_session) or prepare_x402_round, passing `source` unchanged."
          : `This server holds no signer (${dependencies.readOnly!.reason}): configure one, or run this source on a server that has one.`
      },
      outputSchema
    );
  }

  const tool = roundTool(args.payment ?? "subscription", dependencies);
  const roundArgs = z.object(tool.inputSchema).parse({
    source: derived.source,
    sourceId: derived.sourceId,
    signaturesRequired: args.signaturesRequired ?? DEFAULT_SIGNATURES,
    chains: args.chains ?? ["evm", "starknet", "solana"],
    ...(args.autoSubmit !== undefined ? { autoSubmit: args.autoSubmit } : {}),
    ...(args.maxAge !== undefined ? { maxAge: args.maxAge } : {}),
    ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {})
  });
  const result = await tool.handler(roundArgs);
  // A failed round is the round tool's own error, with whatever it already did (a paid round keeps its artifact).
  if (result.isError || !result.structuredContent) return result;
  return jsonResult({ mode: "signed", ...base, round: result.structuredContent }, outputSchema);
}

function handle<T>(fn: (args: T) => Promise<JsonToolResult>): (args: T) => Promise<JsonToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (error) {
      return errorResult(error);
    }
  };
}

/**
 * Where this server signs, a data tool with attest: true spends quota or USDC. On a hosted or read-only server it
 * only returns the derived source, so there the tools are read-only.
 */
function annotationsFor(dependencies: ToolDependencies) {
  return dependencies.hosted || dependencies.readOnly
    ? { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
    : { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
}

function paramSchema(p: DataTemplate["params"][number]): z.ZodTypeAny {
  const s = p.enum && p.enum.length > 0 ? z.enum(p.enum as [string, ...string[]]) : z.string().min(1);
  const doc = p.default ? `${p.doc} (default ${p.default})` : p.doc;
  return (p.required ? s : s.optional()).describe(doc);
}

export function registerDataTools(server: ToolServer, dependencies: ToolDependencies = {}): void {
  const catalogOutput = z.object({
    from: z.enum(["service", "snapshot"]).describe("service: the live catalog; snapshot: this release's copy, when the service did not answer."),
    templates: z.array(z.record(z.unknown())),
    note: z.string().optional()
  });
  server.registerTool(
    "list_data_templates",
    {
      title: "List Molpha Data templates",
      description:
        "List the on-chain data templates Molpha Data offers: token supply and balances, pool prices, TWAPs and reserves, LST rates, vault share prices, lending rates, totals and health factors, oracle cross-checks and more. Each has a tool of its own (named in `tool`) and parameters; read_data takes any of them by id, or a raw source. Reads the service's catalog; signs and spends nothing.",
      inputSchema: {
        chain: z.string().optional().describe("Only templates for this chain: alias (ethereum, base, solana, starknet) or CAIP-2 id."),
        class: z.string().optional().describe("Only templates whose class contains this text, e.g. \"lending\".")
      },
      outputSchema: catalogOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
    },
    handle(async (args: { chain?: string; class?: string }) => {
      const { config } = await (dependencies.getContext ?? getMolphaContext)();
      const withTool = (t: DataTemplate) => ({ ...t, tool: dataToolName(t.id) });
      try {
        const templates = await listTemplates(config, args);
        return jsonResult({ from: "service", templates: templates.map(withTool) }, catalogOutput);
      } catch (error) {
        if (args.chain) throw error;
        const cls = args.class?.toLowerCase();
        const templates = DATA_CATALOG.filter((t) => !cls || t.class.toLowerCase().includes(cls)).map(withTool);
        return jsonResult(
          { from: "snapshot", templates, note: `Molpha Data did not answer (${error instanceof Error ? error.message : String(error)}); this is this release's copy of the catalog.` },
          catalogOutput
        );
      }
    })
  );

  server.registerTool(
    "read_data",
    {
      title: "Read on-chain data through Molpha Data",
      description:
        "Read a Molpha Data template (see list_data_templates) or a raw source document. Unsigned by default: the service's own read, free and rate limited, with the source it read so you can see exactly what was asked. With attest: true the same source runs as a threshold-signed round on this server (execute_subscription_round, or execute_x402_round with payment: \"x402\"), with the same dry-run lock and spend caps, and returns the signed attestation and verifier arguments. Every source the service returns is re-hashed here and refused if it does not match its sourceId.",
      inputSchema: {
        template: z.string().optional().describe("Template id from list_data_templates, e.g. \"dex.pool.price\" (optionally @version)."),
        params: z.record(z.string()).optional().describe("The template's parameters, all strings, e.g. {chain: \"ethereum\", pool: \"0x…\"}."),
        source: z.record(z.unknown()).optional().describe("A raw source document instead of a template (see derive_source_id)."),
        ...signingInputFor(dependencies)
      },
      outputSchema,
      annotations: annotationsFor(dependencies)
    },
    handle(async (args: { template?: string; params?: Record<string, string>; source?: Record<string, unknown> } & SigningArgs) => {
      if ((args.template ? 1 : 0) + (args.source ? 1 : 0) !== 1) throw new Error("Send either template (with params) or source.");
      const req: DataRequest = args.template ? { template: args.template, params: args.params ?? {} } : { source: args.source! };
      return runDataRead(req, args, dependencies);
    })
  );

  for (const t of DATA_CATALOG) {
    const inputSchema: Record<string, z.ZodTypeAny> = {};
    for (const p of t.params) inputSchema[p.name] = paramSchema(p);
    Object.assign(inputSchema, signingInputFor(dependencies));
    const caveats = t.caveats?.length ? ` Caveats: ${t.caveats.join(" ")}` : "";
    server.registerTool(
      dataToolName(t.id),
      {
        title: t.title,
        description: `${t.summary} Returns ${t.returns}.${caveats} Template ${t.ref} (Molpha Data). Unsigned by default; attest: true runs a threshold-signed round of the same source on this server (see read_data).`,
        inputSchema,
        outputSchema,
        annotations: annotationsFor(dependencies)
      },
      handle(async (args: Record<string, unknown> & SigningArgs) => {
        const params: Record<string, string> = {};
        for (const p of t.params) {
          const v = args[p.name];
          if (typeof v === "string" && v !== "") params[p.name] = v;
        }
        return runDataRead({ template: t.ref, params }, args, dependencies);
      })
    );
  }
}
