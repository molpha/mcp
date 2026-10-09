#!/usr/bin/env node
import "./env.js";
import { parseArgs } from "node:util";
import { createHostedHttpServer, loadHttpConfig } from "./http/server.js";
import { serverVersion } from "./version.js";

const hosted = process.argv.includes("--http") || process.env.VERCEL === "1";

function fail(error: unknown): never {
  // Hosted startup failures must not print configuration/provider secrets.
  console.error(hosted ? "Hosted HTTP startup failed. Check server configuration and port availability." : error instanceof Error ? error.message : "Startup failed");
  process.exit(1);
}

try {
  // Vercel may inject argv flags; ignore unknowns so listen() still runs.
  // Important: Vercel patches Server.listen during module evaluation and only
  // waits ~1s — the hosted path must call listen() synchronously with no
  // top-level await in this module (an `await` anywhere makes evaluation async).
  const { values } = parseArgs({
    options: { http: { type: "boolean" }, port: { type: "string" }, help: { type: "boolean" }, "read-only": { type: "boolean" } },
    strict: false,
    allowPositionals: true
  });
  if (values.help) {
    console.log("Usage: molpha-mcp [--read-only] [--http [--port 8402]]\nDefault transport: stdio. --read-only (or SIGNER_BACKEND=none, or no signer configured) offers only the read tools. HTTP endpoint: /mcp; health: /healthz. Vercel sets VERCEL=1 and starts HTTP automatically.");
  } else if (values.http || process.env.VERCEL === "1") {
    const app = createHostedHttpServer({ config: loadHttpConfig(process.env, values.port === undefined ? undefined : Number(values.port)) });
    app.server.listen(app.config.port, app.config.host);
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
    void (async () => {
      const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const { registerTools } = await import("./tools/index.js");
      const { getReadOnlyContext } = await import("./clients.js");
      const { resolveRunMode } = await import("./run-mode.js");
      const runMode = resolveRunMode(process.argv.slice(2));
      const { buildInstructions } = await import("./instructions.js");
      const server = new McpServer(
        { name: "molpha-mcp", version: serverVersion },
        { instructions: buildInstructions(runMode.mode === "read-only" ? "read-only" : "stdio") }
      );
      if (runMode.mode === "read-only") {
        // stderr only: stdout carries the protocol. A downgrade must never be silent.
        console.error(`molpha-mcp: running read-only: ${runMode.reason}. Write tools are not offered.`);
        registerTools(server, { readOnly: { reason: runMode.reason }, getContext: getReadOnlyContext });
      } else {
        registerTools(server);
      }
      await server.connect(new StdioServerTransport());
    })().catch(fail);
  }
} catch (error) {
  fail(error);
}
