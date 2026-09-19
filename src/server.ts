#!/usr/bin/env node
import "./env.js";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";
import { serverVersion } from "./version.js";

try {
  const { values } = parseArgs({ options: { http: { type: "boolean" }, port: { type: "string" }, help: { type: "boolean" } }, strict: true });
  if (values.help) {
    console.log("Usage: molpha-mcp [--http [--port 8402]]\nDefault transport: stdio. HTTP endpoint: /mcp; health: /healthz. Vercel sets VERCEL=1 and starts HTTP automatically.");
  } else if (values.http || process.env.VERCEL === "1") {
    const { createHostedHttpServer, loadHttpConfig } = await import("./http/server.js");
    const hosted = createHostedHttpServer({ config: loadHttpConfig(process.env, values.port === undefined ? undefined : Number(values.port)) });
    await new Promise<void>((resolve, reject) => {
      hosted.server.once("error", reject);
      hosted.server.listen(hosted.config.port, hosted.config.host, resolve);
    });
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void hosted.close().then(() => process.exit(0), () => process.exit(1));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } else {
    if (values.port !== undefined) throw new Error("--port requires --http");
    const server = new McpServer({ name: "molpha-mcp", version: serverVersion });
    registerTools(server);
    await server.connect(new StdioServerTransport());
  }
} catch (error) {
  // Hosted startup failures must not print configuration/provider secrets.
  console.error(process.argv.includes("--http") ? "Hosted HTTP startup failed. Check server configuration and port availability." : error instanceof Error ? error.message : "Startup failed");
  process.exitCode = 1;
}
