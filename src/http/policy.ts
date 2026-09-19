import { z } from "zod";
import type { RequestLifecycle } from "../clients.js";
import type { JsonToolResult } from "../mcp.js";
import type { ToolServer } from "../tools/types.js";

const messages: Record<string, string> = {
  authentication_required: "Supply X-Molpha-Signer and managed-signer headers, or use npx @molpha/mcp locally.",
  submitter_required: "Pass submitter explicitly for unsigned hosted feed reads.",
  invalid_request: "Invalid tool request. Check the tool input schema.",
  guardrail_exceeded: "The configured execution or spending limit was exceeded.",
  determinism_rejected: "Source configuration did not pass determinism checks.",
  invalid_config: "Server configuration is unavailable or invalid.",
  missing_config: "Required server configuration is unavailable.",
  subscription_inactive: "The signer subscription is unavailable or inactive.",
  payment_required: "The gateway rejected the payment requirements.",
  payment_outcome_unknown: "A payment may have settled. Reconcile the transfer before retrying.",
  round_timeout: "The upstream request timed out. A submitted operation may still complete; do not retry blindly.",
  unauthorized: "Managed signer or gateway authentication failed.",
  forbidden: "Managed signer or gateway policy denied this operation.",
  rate_limited: "The upstream service rate limited this request.",
  internal_error: "The upstream service is unavailable or the operation failed.",
  output_schema_mismatch: "The upstream result did not match the expected output schema. Do not retry a paid operation without reconciliation."
};

export function safeError(error: unknown): Record<string, unknown> {
  const value = record(error);
  const status = typeof value?.status === "number" ? value.status : undefined;
  const code = status === 429 ? "rate_limited" : typeof value?.code === "string" && Object.hasOwn(messages, value.code) ? value.code : "internal_error";
  return { code, message: messages[code], ...(status ? { status } : {}),
    ...(code === "payment_outcome_unknown" ? {
      details: safeReconciliation(record(value?.details)),
      remediation: "Check the payer's transfers for this memo before attempting another payment."
    } : {}) };
}

export function safeReconciliation(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["payer", "payTo", "asset"]) {
    if (typeof value?.[key] === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value[key])) out[key] = value[key];
  }
  for (const key of ["memo", "sourceId"]) {
    if (typeof value?.[key] === "string" && /^(?:0x)?[a-fA-F0-9]{64}$/.test(value[key])) out[key] = value[key];
  }
  if (typeof value?.amountAtomicUsdc === "string" && /^\d+$/.test(value.amountAtomicUsdc)) out.amountAtomicUsdc = value.amountAtomicUsdc;
  if (typeof value?.canonicalTimestamp === "number") out.canonicalTimestamp = value.canonicalTimestamp;
  return out;
}

function sanitizeNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeNested);
  const obj = record(value);
  if (!obj) return value;
  if (typeof obj.code === "string" && typeof obj.message === "string") {
    return { ...safeError(obj), ...(obj.ok === false ? { ok: false } : {}),
      ...(obj.retry !== undefined ? { retry: "Reconcile any submitted operation before retrying." } : {}) };
  }
  return Object.fromEntries(Object.entries(obj).map(([key, item]) => [key,
    key === "error" && typeof item === "string" ? "Upstream details unavailable."
      : key === "errors" && Array.isArray(item) ? item.map(() => ({ target: "verifier", message: "Verifier arguments unavailable." })) : sanitizeNested(item)]));
}

export function sanitizeToolResult(result: JsonToolResult, lifecycle?: RequestLifecycle): JsonToolResult {
  if (result.isError) {
    let error: unknown;
    try { error = JSON.parse(result.content[result.content.length - 1]?.text ?? "{}"); } catch { /* generic error */ }
    let sanitized = safeError(error);
    if (lifecycle?.reconciliation && ["internal_error", "output_schema_mismatch", "round_timeout"].includes(String(sanitized.code))) {
      sanitized = safeError({ code: "payment_outcome_unknown", details: lifecycle.reconciliation });
    }
    return { isError: true, content: [{ type: "text", text: JSON.stringify(sanitized) }] };
  }
  const structured = sanitizeNested(result.structuredContent) as Record<string, unknown>;
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export interface HostedTool {
  schema: z.AnyZodObject;
}
export function hostedToolServer(server: ToolServer, catalog: Map<string, HostedTool>, onResult: (name: string, result: JsonToolResult) => void, lifecycle?: RequestLifecycle): ToolServer {
  return { registerTool(name, config, handler) {
    catalog.set(name, { schema: z.object(config.inputSchema) });
    return server.registerTool(name, {
      ...config,
      description: `${config.description}\nHosted mode: signer headers are request-scoped. Unsigned feed reads require submitter; unsigned x402 calls quote only; subscription and submission require signer headers. Daily caps are disabled by default; use provider policies.`,
      outputSchema: config.outputSchema.extend({ warnings: z.array(z.string()).optional() })
    }, async (args: Record<string, unknown>) => {
      let result: JsonToolResult;
      try { result = sanitizeToolResult(await handler(args), lifecycle); }
      catch { result = { isError: true, content: [{ type: "text", text: JSON.stringify(safeError(undefined)) }] }; }
      const headers = record(record(args.apiConfig)?.headers);
      if (!result.isError && headers && Object.keys(headers).some(key => /authorization|cookie|api[-_]?key|token|secret/i.test(key))) {
        const warnings = ["Source API credentials in headers are exposed to the hosted server and downstream hops. Use self-hosted mode for private APIs."];
        result.structuredContent = { ...result.structuredContent, warnings };
        result.content = [{ type: "text", text: JSON.stringify(result.structuredContent) }];
      }
      onResult(name, result);
      return result;
    });
  } };
}
