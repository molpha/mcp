/**
 * Molpha Data tools (decision D12, named verb-first like every tool here).
 *
 * Reading and signing are separate tools, so every server offers the same read tools with the same
 * annotations:
 *
 * - list_data_templates, read_data and one tool per template of the catalog snapshot this release was
 *   built with (src/data-catalog.generated.ts) are read-only everywhere: the Molpha Data service's own
 *   unsigned read, with the source it read (re-hashed here) and its sourceId.
 * - execute_data_round, on a server that signs, runs a template (or a raw source) as a threshold-signed
 *   round. The template is derived at the service, the source is re-hashed here, and the round runs
 *   through this server's own execute_subscription_round or execute_x402_round, so their dry-run lock,
 *   spend caps and treasury checks apply unchanged. Where the server cannot sign, the read tools' `source`
 *   goes to the session or x402 tools instead.
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

const readOnlyAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

const readOutput = z.object({
  template: z.string().nullable().optional(),
  params: z.record(z.unknown()).nullable().optional(),
  sourceId: z.string(),
  source: z.record(z.unknown()).describe("The canonical source document, re-hashed here to sourceId. Pass it unchanged to sign it."),
  facts: z.record(z.string()).nullable().optional().describe("What the template read when it derived the source (decimals, tokens)."),
  value: z.string().describe("The value, rendered. Unsigned: decide with it, never settle with it."),
  data: z.record(z.unknown()),
  read: z.record(z.unknown()),
  payload: z.string().nullable().optional(),
  layout: z.array(z.unknown()).optional(),
  fields: z.record(z.string()).optional().describe("Decoded from payload by the service: recomputed, not signed."),
  next: z.string()
});

const signedOutput = z.object({
  template: z.string().nullable().optional(),
  params: z.record(z.unknown()).nullable().optional(),
  sourceId: z.string(),
  source: z.record(z.unknown()),
  facts: z.record(z.string()).nullable().optional(),
  round: z.record(z.unknown()).describe("The round tool's full output: the signed attestation, verifierArgs, payment, or a dryRun preview.")
});

function nextFor(dependencies: ToolDependencies): string {
  if (dependencies.hosted) {
    return "Unsigned: the Molpha Data service's own read. To sign it, pass `source` unchanged to execute_subscription_round (after begin_session/complete_session) or prepare_x402_round.";
  }
  if (dependencies.readOnly) {
    return "Unsigned: the Molpha Data service's own read. This server holds no signer; to sign the value, run `source` on a server that has one.";
  }
  return "Unsigned: the Molpha Data service's own read. For a value a contract can verify, call execute_data_round with the same template and params (or pass `source` to execute_subscription_round).";
}

async function readUnsigned(req: DataRequest, dependencies: ToolDependencies): Promise<JsonToolResult> {
  const { config } = await (dependencies.getContext ?? getMolphaContext)();
  const env = await unsignedRead(config, req);
  return jsonResult(
    {
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
      next: nextFor(dependencies)
    },
    readOutput
  );
}

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

function handle<T>(fn: (args: T) => Promise<JsonToolResult>): (args: T) => Promise<JsonToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (error) {
      return errorResult(error);
    }
  };
}

function paramSchema(p: DataTemplate["params"][number]): z.ZodTypeAny {
  const s = p.enum && p.enum.length > 0 ? z.enum(p.enum as [string, ...string[]]) : z.string().min(1);
  const doc = p.default ? `${p.doc} (default ${p.default})` : p.doc;
  return (p.required ? s : s.optional()).describe(doc);
}

function requestOf(args: { template?: string; params?: Record<string, string>; source?: Record<string, unknown> }): DataRequest {
  if ((args.template ? 1 : 0) + (args.source ? 1 : 0) !== 1) throw new Error("Send either template (with params) or source.");
  return args.template ? { template: args.template, params: args.params ?? {} } : { source: args.source! };
}

const requestInput = {
  template: z.string().optional().describe("Template id from list_data_templates, e.g. \"dex.pool.price\" (optionally @version)."),
  params: z.record(z.string()).optional().describe("The template's parameters, all strings, e.g. {chain: \"ethereum\", pool: \"0x…\"}."),
  source: z.record(z.unknown()).optional().describe("A raw source document instead of a template (see derive_source_id).")
};

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
        "List the on-chain data templates Molpha Data offers: token supply and balances, pool prices, TWAPs and reserves, LST rates, vault share prices, lending rates, totals and health factors, oracle cross-checks and more. Each has a read tool of its own (named in `tool`) and parameters; read_data takes any of them by id, or a raw source. Reads the service's catalog; signs and spends nothing.",
      inputSchema: {
        chain: z.string().optional().describe("Only templates for this chain: alias (ethereum, base, solana, starknet) or CAIP-2 id."),
        class: z.string().optional().describe("Only templates whose class contains this text, e.g. \"lending\".")
      },
      outputSchema: catalogOutput,
      annotations: readOnlyAnnotations
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
        "Read a Molpha Data template (see list_data_templates) or a raw source document, unsigned: the service's own read, free and rate limited, with the source it read so you can see exactly what was asked. Every source the service returns is re-hashed here and refused if it does not match its sourceId. For a signed value, call execute_data_round with the same input. Signs and spends nothing.",
      inputSchema: requestInput,
      outputSchema: readOutput,
      annotations: readOnlyAnnotations
    },
    handle(async (args: { template?: string; params?: Record<string, string>; source?: Record<string, unknown> }) =>
      readUnsigned(requestOf(args), dependencies)
    )
  );

  for (const t of DATA_CATALOG) {
    const inputSchema: Record<string, z.ZodTypeAny> = {};
    for (const p of t.params) inputSchema[p.name] = paramSchema(p);
    const caveats = t.caveats?.length ? ` Caveats: ${t.caveats.join(" ")}` : "";
    server.registerTool(
      dataToolName(t.id),
      {
        title: t.title,
        description: `${t.summary} Returns ${t.returns}.${caveats} Template ${t.ref} (Molpha Data). An unsigned read with the source it read; for a signed value call execute_data_round with template "${t.id}" and the same params. Signs and spends nothing.`,
        inputSchema,
        outputSchema: readOutput,
        annotations: readOnlyAnnotations
      },
      handle(async (args: Record<string, unknown>) => {
        const params: Record<string, string> = {};
        for (const p of t.params) {
          const v = args[p.name];
          if (typeof v === "string" && v !== "") params[p.name] = v;
        }
        return readUnsigned({ template: t.ref, params }, dependencies);
      })
    );
  }

  // Signing needs a signer held by this server.
  if (dependencies.hosted || dependencies.readOnly) return;

  server.registerTool(
    "execute_data_round",
    {
      title: "Sign a Molpha Data template",
      description:
        "Run a Molpha Data template (or a raw source) as a threshold-signed round and return the signed attestation and verifier arguments. The service derives the source from the template and params; this server re-hashes it (a mismatch is refused before anything is signed) and runs it through execute_subscription_round (default) or execute_x402_round (payment: \"x402\"), with their dry-run lock, spend caps and treasury checks. Each live call spends a round of subscription quota or an x402 payment. `round` is that tool's output: pass it to submit_attestation or build_verifier_calldata unmodified.",
      inputSchema: {
        ...requestInput,
        payment: z.enum(["subscription", "x402"]).optional().describe("Pay from this signer's subscription (default) or per round with x402 USDC."),
        signaturesRequired: z.number().int().min(1).max(255).optional().describe(`The quorum (default ${DEFAULT_SIGNATURES}).`),
        chains: z.array(z.enum(["evm", "starknet", "solana"])).min(1).optional().describe("Build verifier arguments for these chains (default all three)."),
        autoSubmit: z.boolean().optional().describe("Also submit the attestation to Solana (needs \"solana\" in chains)."),
        maxAge: z.number().int().nonnegative().optional().describe("The verifier freshness window in seconds, as in execute_subscription_round. Not a template parameter: those go in `params`."),
        dryRun: z.boolean().optional().describe("Preview the round without signing or paying.")
      },
      outputSchema: signedOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    handle(
      async (
        args: {
          template?: string;
          params?: Record<string, string>;
          source?: Record<string, unknown>;
          payment?: "subscription" | "x402";
          signaturesRequired?: number;
          chains?: Array<"evm" | "starknet" | "solana">;
          autoSubmit?: boolean;
          maxAge?: number;
          dryRun?: boolean;
        }
      ) => {
        const req = requestOf(args);
        const { config } = await (dependencies.getContext ?? getMolphaContext)();
        const derived = await deriveSource(config, req);
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
        return jsonResult(
          {
            template: derived.template ?? ("template" in req ? req.template : null),
            params: derived.params ?? null,
            sourceId: derived.sourceId,
            source: derived.source,
            facts: derived.facts ?? null,
            round: result.structuredContent
          },
          signedOutput
        );
      }
    )
  );
}
