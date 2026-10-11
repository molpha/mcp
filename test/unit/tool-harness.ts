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
