import { z } from "zod";
import { getMolphaContext, type ToolDependencies } from "../clients.js";
import { toolHandler } from "../mcp.js";
import { type ToolServer } from "./types.js";

/** The catalog is static configuration on the gateway: a slow answer means the gateway is unwell, so do not wait long. */
const REQUEST_TIMEOUT_MS = 10_000;

/** What a gateway said about a provider that is not one of its own. */
class ProviderNotFound extends Error {}

/**
 * GETs a path from the first configured gateway that answers and returns its `data`. A gateway that does not
 * serve the provider catalog (an older release) is skipped, so a mixed list still finds one that does.
 */
async function gatewayGet(endpoints: string[], path: string): Promise<{ gateway: string; data: unknown }> {
  const failures: string[] = [];
  for (const base of endpoints) {
    const url = `${base.replace(/\/+$/, "")}${path}`;
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const text = await res.text();
      let body: { status?: string; data?: unknown; error?: string } = {};
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        // Not JSON: an older gateway answering with its own 404 page, or a proxy.
      }
      if (res.ok && body.data !== undefined) return { gateway: base, data: body.data };
      if (res.status === 404 && body.error === "provider not found") throw new ProviderNotFound(body.error);
      failures.push(res.status === 404 ? `${base}: does not serve the provider catalog` : `${base}: HTTP ${res.status}`);
    } catch (error) {
      if (error instanceof ProviderNotFound) throw error;
      failures.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No configured gateway answered ${path} (${failures.join("; ")}).`);
}

const providerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  flows: z.array(z.string()).describe("Access flows the gateway can serve for this provider now: `api_key` or `x402`."),
  feedCount: z.number().int()
});

const listOutputSchema = z.object({
  gateway: z.string().describe("The gateway that answered."),
  providers: z.array(providerSummarySchema)
});

export function registerListProvidersTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "list_providers",
    {
      title: "List integrated data providers",
      description:
        "List the data providers the Molpha gateway integrates (for example TickerLayer market data) and, for each, the access flows it can serve right now: `api_key` (the gateway operator pays the provider; you send no credential) and/or `x402` (you pay the provider directly, per node fetch, in USDC). Each provider has ready-made feeds. Call get_provider for one provider's feeds and terms. Reads the gateway's catalog; signs and spends nothing. The list is empty when the gateway has no provider enabled.",
      inputSchema: {},
      outputSchema: listOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
    },
    toolHandler(listOutputSchema, async () => {
      const { config } = await (dependencies.getContext ?? getMolphaContext)();
      const { gateway, data } = await gatewayGet(config.gatewayEndpoints, "/v1/providers");
      const providers = (data as { providers?: unknown }).providers;
      return { gateway, providers: Array.isArray(providers) ? providers : [] };
    })
  );
}

const flowSchema = z
  .object({
    kind: z.string().describe("`api_key` or `x402`."),
    baseUrl: z.string(),
    pathPrefix: z.string().optional(),
    credential: z.record(z.unknown()).optional().describe("api_key flow: the gateway holds the key; you send none."),
    x402: z.record(z.unknown()).optional().describe("x402 flow: scheme, network, asset and the provider's own price list."),
    feeds: z.array(z.record(z.unknown())).optional().describe("Ready-made feeds. Each has a complete `apiConfig` and its `sourceId`.")
  })
  .passthrough();

const getOutputSchema = z.object({
  gateway: z.string(),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  docsUrl: z.string().optional(),
  termsUrl: z.string().optional(),
  disclosure: z.string().describe("How a value from this provider must be described to its users."),
  aggregation: z
    .object({ mode: z.string(), minSignatures: z.number().int(), reason: z.string() })
    .describe("The aggregation the provider's feeds require."),
  flows: z.array(flowSchema),
  operations: z.array(z.record(z.unknown())).optional(),
  howToUse: z.string()
});

export function registerGetProviderTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "get_provider",
    {
      title: "Describe an integrated provider",
      description:
        "Describe one integrated provider: its access flows, the aggregation its feeds require, how to describe its values, and ready-made feeds. Each feed carries a COMPLETE `apiConfig` and its `sourceId`: pass the `apiConfig` unchanged to execute_subscription_round (use signaturesRequired of at least 3: provider feeds use median tolerance aggregation). Do not add headers, a key or a payment to it; anything you change moves the sourceId and, on a provider's host, is refused. On the `api_key` flow the gateway pays the provider, so nothing else is needed. On the `x402` flow the provider charges per fetch: call quote_source_payment for the price, then pass sourcePayment.maxSpendUsdc to execute_subscription_round. Narrow the answer with `flow` and `feed`. Reads the gateway's catalog; signs and spends nothing.",
      inputSchema: {
        provider: z.string().min(1).describe("Provider id from list_providers, e.g. `tickerlayer`."),
        flow: z.enum(["api_key", "x402"]).optional().describe("Return only this access flow."),
        feed: z.string().optional().describe("Return only the feed with this id, e.g. `btcusd`."),
        includeOperations: z.boolean().optional().describe("Also list every route the gateway acts on (24 for TickerLayer). Off by default: the feeds are what you run.")
      },
      outputSchema: getOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
    },
    toolHandler(
      getOutputSchema,
      async (args: { provider: string; flow?: "api_key" | "x402"; feed?: string; includeOperations?: boolean }) => {
        const { config } = await (dependencies.getContext ?? getMolphaContext)();
        let found: { gateway: string; data: unknown };
        try {
          found = await gatewayGet(config.gatewayEndpoints, `/v1/providers/${encodeURIComponent(args.provider)}`);
        } catch (error) {
          if (error instanceof ProviderNotFound) {
            throw new Error(`No provider "${args.provider}" on the configured gateway. Call list_providers for the ids it serves.`);
          }
          throw error;
        }
        const detail = found.data as Record<string, unknown> & { flows?: Array<Record<string, unknown>>; operations?: unknown[] };

        let flows = (detail.flows ?? []).filter((f) => args.flow === undefined || f.kind === args.flow);
        if (args.feed !== undefined) {
          const available = (detail.flows ?? []).flatMap((f) => ((f.feeds as Array<{ id: string }> | undefined) ?? []).map((feed) => feed.id));
          if (!available.includes(args.feed)) {
            throw new Error(`Provider "${args.provider}" has no feed "${args.feed}". Its feeds: ${[...new Set(available)].join(", ")}.`);
          }
          flows = flows.map((f) => ({ ...f, feeds: ((f.feeds as Array<{ id: string }> | undefined) ?? []).filter((feed) => feed.id === args.feed) }));
        }
        if (args.flow !== undefined && flows.length === 0) {
          throw new Error(`Provider "${args.provider}" does not serve the ${args.flow} flow on this gateway. It serves: ${(detail.flows ?? []).map((f) => f.kind).join(", ") || "none"}.`);
        }

        const kinds = flows.map((f) => f.kind);
        const howToUse = [
          "Pass a feed's apiConfig, unchanged, to execute_subscription_round with signaturesRequired >= 3.",
          kinds.includes("api_key") ? "api_key flow: the gateway operator pays the provider; send no key and no payment." : "",
          kinds.includes("x402")
            ? "x402 flow: you pay the provider per node fetch. Call quote_source_payment first, then pass sourcePayment.maxSpendUsdc (the most you authorize) to execute_subscription_round."
            : "",
          "Describe results as attested provider quotes, as the disclosure says: Molpha attests what the endpoint returned, not that the price is correct."
        ].filter(Boolean).join(" ");

        return {
          gateway: found.gateway,
          id: detail.id,
          name: detail.name,
          description: detail.description,
          ...(detail.docsUrl !== undefined ? { docsUrl: detail.docsUrl } : {}),
          ...(detail.termsUrl !== undefined ? { termsUrl: detail.termsUrl } : {}),
          disclosure: detail.disclosure,
          aggregation: detail.aggregation,
          flows,
          ...(args.includeOperations ? { operations: detail.operations ?? [] } : {}),
          howToUse
        };
      }
    )
  );
}
