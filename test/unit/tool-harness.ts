import { z } from "zod";
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

export function collectTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  registerTools({
    registerTool: (name: string, config: RegisteredTool["config"], handler: RegisteredTool["handler"]) => {
      tools.push({ name, config, handler });
    }
  });
  return tools;
}

/**
 * Calls a tool the way the SDK does — input parsed against its inputSchema — and
 * insists on a structured success whose text block carries the same JSON.
 */
export async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = collectTools().find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`no tool named ${name}`);
  }

  const result = await tool.handler(z.object(tool.config.inputSchema).parse(args));
  if (result.isError || !result.structuredContent) {
    throw new Error(`${name} failed: ${result.content.map((block) => block.text).join("\n")}`);
  }
  if (JSON.stringify(JSON.parse(result.content[0]!.text)) !== JSON.stringify(result.structuredContent)) {
    throw new Error(`${name}: text block and structuredContent differ`);
  }
  tool.config.outputSchema.parse(result.structuredContent);
  return result.structuredContent;
}
