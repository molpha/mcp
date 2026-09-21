#!/usr/bin/env node
import "./env.js";
import { parseArgs } from "node:util";
import { serverVersion } from "./version.js";

const hosted = process.argv.includes("--http") || process.env.VERCEL === "1";

try {
  // Vercel may inject argv flags; ignore unknowns so listen() still runs.
  const { values } = parseArgs({
    options: { http: { type: "boolean" }, port: { type: "string" }, help: { type: "boolean" } },
    strict: false,
    allowPositionals: true
  });
  if (values.help) {
    console.log("Usage: molpha-mcp [--http [--port 8402]]\nDefault transport: stdio. HTTP endpoint: /mcp; health: /healthz. Vercel sets VERCEL=1 and starts HTTP automatically.");
  } else if (values.http || process.env.VERCEL === "1") {
    const { createHostedHttpServer, loadHttpConfig } = await import("./http/server.js");
    const app = createHostedHttpServer({ config: loadHttpConfig(process.env, values.port === undefined ? undefined : Number(values.port)) });
    await new Promise<void>((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(app.config.port, app.config.host, resolve);
    });
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void app.close().then(() => process.exit(0), () => process.exit(1));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } else {
    if (values.port !== undefined) throw new Error("--port requires --http");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { registerTools } = await import("./tools/index.js");
    const server = new McpServer({ name: "molpha-mcp", version: serverVersion });
    registerTools(server);
    await server.connect(new StdioServerTransport());
  }
} catch (error) {
  // Hosted startup failures must not print configuration/provider secrets.
  console.error(hosted ? "Hosted HTTP startup failed. Check server configuration and port availability." : error instanceof Error ? error.message : "Startup failed");
  process.exit(1);
}
