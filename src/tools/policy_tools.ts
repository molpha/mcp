import { z } from "zod";
import { getMolphaContext, type ToolDependencies } from "../clients.js";
import { checkSourceDeterminism } from "../determinism.js";
import { toolHandler } from "../mcp.js";
import { requireSdkExport } from "../sdk.js";
import { parseSource, type ParsedSourceLike } from "../source.js";
import { sourceSchema } from "./schemas.js";
import { type ToolServer } from "./types.js";

/** A simulation is one evaluation on the gateway, no fetch: a slow answer means the gateway is unwell. */
const SIMULATE_TIMEOUT_MS = 15_000;

/** What each analysis warning means (node-client docs/policy.md, Analysis). */
const WARNING_TEXT: Record<string, string> = {
  exactComposite:
    "A policy with several candidates in exact mode: every signer must read byte-identical values from every venue, which live venues rarely give. Use tolerance aggregation for a live composite.",
  independenceNone: "independence is none: two candidates may read the same host or chain, so one outage can disqualify both.",
  fallbackReachable:
    "A conclusive result can equal the fallback value, so a consumer cannot tell them apart from the value alone. Add an assertion that keeps the result out of the fallback's range (for -1: $out >= 0).",
  fallbackTolerance:
    "A fallback in tolerance mode is signed only when at least signaturesRequired nodes are inconclusive with the same fallback word, and only when the redundancy buffer is below signaturesRequired.",
  readsCandidateField: "The transform reads a candidate input's field directly instead of $agg, so the policy's combination is bypassed."
};

const analysisOutput = z.object({
  sourceId: z.string(),
  analysis: z
    .record(z.unknown())
    .describe(
      "The SDK's analyzeSource: inputs (kind, chain, host, whether a candidate), policy (candidates with roles and rule counts, combine, independence, inconclusiveIf count, fallback values and whether a result can reach them), output, aggregation, expression size, fetches per node and warnings. The same facts as the nodes' own source.Analyze."
    ),
  warnings: z.array(z.object({ code: z.string(), path: z.string(), meaning: z.string() })),
  fallbackWords: z
    .array(z.string())
    .describe("The 32-byte words (0x hex) a signed fallback can be: a value among them under this sourceId is the policy's fallback for an INCONCLUSIVE result."),
  determinismWarnings: z.array(z.string()).optional(),
  note: z.string()
});

const simulatedInputSchema = z
  .object({
    body: z.string().optional().describe("An http response body, decoded with the source's own decode block, as a node decodes what it fetched (at most 1 MiB)."),
    bodyHex: z.boolean().optional().describe("The body is hex (a binary response)."),
    fields: z
      .record(
        z.object({
          type: z.enum(["decimal", "string", "bool", "bytes", "null"]),
          value: z.string().describe("Decimals as strings (\"65000.12\"), bools as \"true\"/\"false\", bytes as 0x hex.")
        })
      )
      .optional()
      .describe("The input's decoded fields by name. A chain input is given this way."),
    block: z.number().int().positive().optional().describe("The block or slot a chain input was read at (fields form)."),
    error: z.enum(["fetch", "decode"]).optional().describe("The input failed: fetch (could not be read) or decode (its body did not decode).")
  })
  .describe("Exactly one of body, fields and error.");

const simulationOutput = z.object({
  gateway: z.string().describe("The gateway that ran the simulation."),
  simulation: z
    .record(z.unknown())
    .describe(
      "sourceId; source (canonical); inputs (name, kind, block, error, decoded fields); value (encoded, display, type, decimals) or error (stage, input, message); and policy (candidates with qualified, rule, error, value; n; agg; outcome conclusive or inconclusive; reason; signed: the fallback is the value)."
    ),
  note: z.string()
});

function analysisOf(parsed: ParsedSourceLike): { analysis: Record<string, unknown>; fallbackWords: string[] } {
  const analyze = requireSdkExport<(src: ParsedSourceLike) => Record<string, unknown>>("analyzeSource");
  const words = requireSdkExport<(src: ParsedSourceLike) => string[]>("fallbackWords");
  return { analysis: analyze(parsed), fallbackWords: words(parsed) };
}

export function registerAnalyzeSourceTool(server: ToolServer, _dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "analyze_source",
    {
      title: "Analyze a Molpha source",
      description:
        "Describe what a source can do without fetching or evaluating it: its inputs (kind, chain, host), and for a source with a policy its candidates, how they combine, the INCONCLUSIVE reasons it can reach, the fallback words it would sign, and warnings (a composite in exact mode, candidates that may share a host, a result that can equal the fallback). " +
        "Also returns the determinism warnings derive_source_id gives. Local and free: no network, no wallet. To see what the source does with particular data, call simulate_source.",
      inputSchema: { source: sourceSchema },
      outputSchema: analysisOutput,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    toolHandler(analysisOutput, async ({ source }: { source: z.infer<typeof sourceSchema> }) => {
      const parsed = parseSource(source);
      const { analysis, fallbackWords } = analysisOf(parsed);
      const determinism = await checkSourceDeterminism(parsed);
      const raw = (analysis.warnings as { code: string; path: string }[] | undefined) ?? [];
      return {
        sourceId: parsed.idHex,
        analysis,
        warnings: raw.map((w) => ({ ...w, meaning: WARNING_TEXT[w.code] ?? w.code })),
        fallbackWords,
        determinismWarnings: determinism.warnings.length > 0 ? determinism.warnings : undefined,
        note: "Nothing was fetched or evaluated. A source without a policy has policy null and no fallback words."
      };
    })
  );
}

export function registerSimulateSourceTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "simulate_source",
    {
      title: "Simulate a Molpha source",
      description:
        "Evaluate a source over inputs you supply, with the nodes' own evaluator, on the configured gateway (POST /v1/source/simulate): the policy, transform, assertions and output encoding, exactly what a node does after reading its inputs. " +
        "Give every input of the source one way: body (an http response, decoded with the source's decode block), fields (decoded fields; a chain input also gives block), or error (fetch or decode). " +
        "Nothing is fetched, signed or charged, and no wallet is needed: use it to check a policy against data, for example a venue down (error: fetch) or a stale price, before paying for a round. " +
        "The answer is the value nodes would sign or the stage the source refused at, and for a policy each candidate's qualification, the combined value, the outcome (conclusive or inconclusive) and its reason; signed: true means the policy's fallback is the value. " +
        "timestampMs (unix ms on the 100 ms grid) sets the round time freshness rules read; absent takes the gateway's clock. A private source ({{secret.NAME}}) is not simulated.",
      inputSchema: {
        source: sourceSchema,
        inputs: z.record(simulatedInputSchema).describe("What every input of the source returned, by input name."),
        timestampMs: z.number().int().positive().optional()
      },
      outputSchema: simulationOutput,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    toolHandler(
      simulationOutput,
      async ({
        source,
        inputs,
        timestampMs
      }: {
        source: z.infer<typeof sourceSchema>;
        inputs: Record<string, z.infer<typeof simulatedInputSchema>>;
        timestampMs?: number;
      }) => {
        // Validated here first, so a bad source fails with its path before any request.
        const parsed = parseSource(source);
        const { config } = await (dependencies.getContext ?? getMolphaContext)();
        const body = JSON.stringify({ source: parsed.doc, inputs, ...(timestampMs !== undefined ? { timestampMs } : {}) });
        const failures: string[] = [];
        for (const base of config.gatewayEndpoints) {
          const gateway = base.replace(/\/+$/, "");
          let res: Response;
          try {
            res = await fetch(`${gateway}/v1/source/simulate`, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body,
              signal: AbortSignal.timeout(SIMULATE_TIMEOUT_MS)
            });
          } catch (error) {
            failures.push(`${gateway}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
          }
          const text = await res.text();
          let answer: { data?: Record<string, unknown>; error?: string } = {};
          try {
            answer = JSON.parse(text) as typeof answer;
          } catch {
            // An older gateway's own 404 page, or a proxy.
          }
          if (res.ok && answer.data) {
            return {
              gateway,
              simulation: answer.data,
              note: "Nothing was fetched, signed or charged. A live round reads its inputs itself; this shows what the source does with the inputs given."
            };
          }
          if (res.status === 400 || res.status === 422) {
            // The request itself is refused; another gateway would say the same.
            throw Object.assign(new Error(answer.error ?? `simulate_source refused (HTTP ${res.status})`), { code: "invalid_request" });
          }
          failures.push(res.status === 404 || res.status === 405 ? `${gateway}: does not serve /v1/source/simulate` : `${gateway}: HTTP ${res.status}${answer.error ? ` (${answer.error})` : ""}`);
        }
        throw new Error(`No configured gateway simulated the source (${failures.join("; ")}).`);
      }
    )
  );
}
