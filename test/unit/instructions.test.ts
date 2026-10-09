import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { buildInstructions, type InstructionsMode } from "../../src/instructions.js";
import { registerTools } from "../../src/tools/index.js";
import { collectTools } from "./tool-harness.js";

const MAX_LENGTH = 1800;
/** Backticked identifiers that look like tool names but are error codes. */
const NOT_TOOLS = new Set(["dry_run_locked"]);

const DEPENDENCIES = {
  stdio: {},
  "read-only": { readOnly: { reason: "test" } },
  hosted: { hosted: {} }
} as const;

function backtickedToolNames(text: string): string[] {
  return [...text.matchAll(/`([a-z]+(?:_[a-z0-9]+)+)`/g)].map((match) => match[1]!).filter((name) => !NOT_TOOLS.has(name));
}

describe.each(["stdio", "read-only", "hosted"] as InstructionsMode[])("instructions (%s)", (mode) => {
  const text = buildInstructions(mode);

  it("is present and short enough to load on every session", () => {
    expect(text.length).toBeGreaterThan(200);
    expect(text.length).toBeLessThan(MAX_LENGTH);
  });

  it("names only tools this mode registers", () => {
    const registered = new Set(collectTools(DEPENDENCIES[mode]).map((tool) => tool.name));
    const named = backtickedToolNames(text);

    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(registered, `${mode} instructions name ${name}`).toContain(name);
  });

  it("states the testnet scope", () => {
    expect(text).toContain("Solana Devnet and Sepolia");
  });
});

describe("the read-only variant", () => {
  it("never mentions a write tool", () => {
    const text = buildInstructions("read-only");
    for (const write of ["execute_subscription_round", "execute_x402_round", "submit_attestation"]) expect(text).not.toContain(write);
  });
});

describe("over MCP", () => {
  it("returns the instructions from initialize", async () => {
    const server = new McpServer({ name: "molpha-mcp-test", version: "0.0.0" }, { instructions: buildInstructions("stdio") });
    registerTools(server);
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    expect(client.getInstructions()).toBe(buildInstructions("stdio"));
    await client.close();
  });
});
