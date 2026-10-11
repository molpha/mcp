import { type z } from "zod";
import { normalizeError } from "./errors.js";

export interface JsonToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * A success carries the same JSON twice: `structuredContent`, validated against
 * the tool's outputSchema, and a text block for clients without
 * structured-content support.
 */
export function jsonResult(value: unknown, outputSchema?: z.ZodTypeAny): JsonToolResult {
  const structured = toJsonSafe(value);
  const text = JSON.stringify(structured, null, 2) ?? "null";

  if (!isRecord(structured)) {
    return mismatchResult(text, "tool returned a non-object result");
  }

  const checked = outputSchema?.safeParse(structured);
  if (checked && !checked.success) {
    return mismatchResult(
      text,
      checked.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
    );
  }

  return { content: [{ type: "text", text }], structuredContent: structured };
}

export function errorResult(error: unknown): JsonToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: stringifyToolJson(normalizeError(error))
      }
    ]
  };
}

export function toolHandler<TArgs>(
  outputSchema: z.ZodTypeAny,
  handler: (args: TArgs) => Promise<unknown> | unknown
): (args: TArgs) => Promise<JsonToolResult> {
  return async (args) => {
    let value: unknown;
    try {
      value = await handler(args);
    } catch (error) {
      return errorResult(error);
    }
    return jsonResult(value, outputSchema);
  };
}

export function stringifyToolJson(value: unknown): string {
  return JSON.stringify(toJsonSafe(value), null, 2) ?? "null";
}

/**
 * The MCP SDK replaces a result that fails its outputSchema with a bare error,
 * which would discard work already done — for a paid round, the signed artifact.
 * Output validation is skipped for `isError` results, so the full JSON still
 * reaches the caller alongside the mismatch.
 */
function mismatchResult(text: string, detail: string): JsonToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text },
      {
        type: "text",
        text: stringifyToolJson({
          code: "output_schema_mismatch",
          message: `The result above does not match this tool's outputSchema (${detail}). It is returned in full; nothing was retried or discarded.`
        })
      }
    ]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value !== "object") {
    return value;
  }

  if (value instanceof Uint8Array) {
    return bytesToHex(value);
  }

  if (isPublicKeyLike(value)) {
    return value.toBase58();
  }

  if (isBnLike(value)) {
    return (value as { toString: (radix?: number) => string }).toString(10);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const out = value.map((item) => toJsonSafe(item, seen));
    seen.delete(value);
    return out;
  }

  // Undefined members are dropped, as JSON.stringify would, so structuredContent
  // and the text block carry the same keys.
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      out[key] = toJsonSafe(item, seen);
    }
  }

  seen.delete(value);
  return out;
}

function isPublicKeyLike(value: object): value is { toBase58: () => string } {
  return value.constructor.name === "PublicKey" && "toBase58" in value && typeof value.toBase58 === "function";
}

function isBnLike(value: object): boolean {
  return (
    value.constructor.name === "BN" &&
    "toString" in value &&
    typeof value.toString === "function" &&
    "words" in value
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
