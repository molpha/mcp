import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { signedArtifactSchema, toDataUpdateArtifact } from "../../src/artifacts.js";
import { registerTools } from "../../src/tools/index.js";
import { callTool, collectTools } from "./tool-harness.js";

const TOOL_NAMES = [
  "build_verifier_calldata",
  "derive_source_id",
  "describe_access",
  "describe_feed",
  "execute_subscription_round",
  "execute_x402_round",
  "get_capabilities",
  "get_latest_value",
  "get_provider",
  "get_x402_status",
  "list_providers",
  "quote_source_payment",
  "submit_attestation"
];

/**
 * The hosted server holds no signer: every operation that needs a signature is split around
 * the caller's own wallet, and nothing that signs on the server is offered.
 */
const HOSTED_TOOL_NAMES = [
  "begin_session",
  "build_verifier_calldata",
  "complete_session",
  "derive_source_id",
  "describe_access",
  "describe_feed",
  "execute_subscription_round",
  "execute_x402_round",
  "get_capabilities",
  "get_latest_value",
  "get_provider",
  "get_x402_status",
  "list_providers",
  "prepare_submit_attestation",
  "prepare_x402_round",
  "quote_source_payment",
  "send_signed_transaction"
];

const READ_ONLY = [
  "build_verifier_calldata",
  "derive_source_id",
  "describe_access",
  "describe_feed",
  "get_capabilities",
  "get_latest_value",
  "get_provider",
  "get_x402_status",
  "list_providers",
  "quote_source_payment"
];

const RETIRED_NAMES = /\b(execute_agent_round|get_agent_status|verify_attestation)\b/;

const readRepoFile = (name: string): string => readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");

/** A signed round result in the flat gateway shape. */
const flatResult = {
  sourceId: `0x${"1".repeat(64)}`,
  value: "66285",
  valuePacked: `0x${"2".repeat(64)}`,
  timestamp: 1714300000,
  registryVersion: 7,
  signaturesRequired: 1,
  signersBitmap: "4",
  s: `0x${"3".repeat(64)}`,
  commitmentAddr: `0x${"4".repeat(40)}`,
  fresh: true
};

describe("tool surface", () => {
  const tools = collectTools();

  it("names every tool verb-first, without the molpha_ prefix", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
  });

  it("speaks sourceId and current tool names, never feedId, molpha_ prefixes, or retired names", () => {
    for (const tool of tools) {
      expect(Object.keys(tool.config.inputSchema)).not.toContain("feedId");
      expect(tool.config.description).not.toMatch(/feedId|molpha_[a-z]/);
      expect(tool.config.description).not.toMatch(RETIRED_NAMES);
    }
  });

  it("gives every tool an object outputSchema", () => {
    for (const tool of tools) {
      expect(tool.config.outputSchema?._def.typeName, tool.name).toBe("ZodObject");
    }
  });

  it("marks exactly the non-mutating tools read-only and states the write hints on the rest", () => {
    for (const tool of tools) {
      const { annotations } = tool.config;
      expect(typeof annotations.openWorldHint, tool.name).toBe("boolean");
      if (READ_ONLY.includes(tool.name)) {
        expect(annotations.readOnlyHint, tool.name).toBe(true);
      } else {
        expect(annotations.readOnlyHint, tool.name).toBe(false);
        expect(typeof annotations.destructiveHint, tool.name).toBe("boolean");
        expect(typeof annotations.idempotentHint, tool.name).toBe("boolean");
      }
    }

    const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.config.annotations]));
    // Spends USDC or prepaid quota, once per call.
    expect(hints.execute_x402_round).toMatchObject({ destructiveHint: true, idempotentHint: false });
    expect(hints.execute_subscription_round).toMatchObject({ destructiveHint: true, idempotentHint: false });
    // The program only accepts a strictly newer attestation for the signer's own feed.
    expect(hints.submit_attestation).toMatchObject({ destructiveHint: false, idempotentHint: true });
    // Local computation only.
    expect(hints.derive_source_id!.openWorldHint).toBe(false);
    expect(hints.build_verifier_calldata!.openWorldHint).toBe(false);
  });

  it("round tools advertise the canonical signed-artifact fields", () => {
    for (const name of ["execute_subscription_round", "execute_x402_round"]) {
      const shape = tools.find((tool) => tool.name === name)!.config.outputSchema.shape;
      for (const field of Object.keys(signedArtifactSchema.shape)) {
        expect(shape, `${name}.${field}`).toHaveProperty(field);
      }
    }
  });
});

describe("hosted tool surface", () => {
  const tools = collectTools({ hosted: {} });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  it("offers the keyless set and nothing that signs on the server", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(HOSTED_TOOL_NAMES);
    for (const tool of tools) {
      const inputs = Object.keys(tool.config.inputSchema);
      for (const serverSide of ["autoSubmit", "encryptSecrets", "dryRun"]) {
        expect(inputs, `${tool.name}.${serverSide}`).not.toContain(serverSide);
      }
      expect(tool.config.outputSchema?._def.typeName, tool.name).toBe("ZodObject");
      expect(tool.config.description, tool.name).not.toMatch(/X-Molpha|signer header|OWNER_KEYPAIR/i);
    }
  });

  it("takes the caller's wallet as an address wherever the stdio server would use its own signer", () => {
    expect(Object.keys(byName.prepare_x402_round!.config.inputSchema)).toContain("payer");
    expect(Object.keys(byName.prepare_submit_attestation!.config.inputSchema)).toContain("payer");
    expect(Object.keys(byName.begin_session!.config.inputSchema)).toEqual(expect.arrayContaining(["address", "owner"]));
    expect(Object.keys(byName.execute_subscription_round!.config.inputSchema)).toContain("sessionToken");
    expect(Object.keys(byName.execute_x402_round!.config.inputSchema).sort()).toEqual(["challenge", "signedTransaction"]);
    expect(Object.keys(byName.send_signed_transaction!.config.inputSchema).sort()).toEqual(["challenge", "signedTransaction"]);
  });

  it("marks the steps that prepare as read-only and the steps that spend as destructive", () => {
    const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.config.annotations]));
    for (const name of ["prepare_x402_round", "prepare_submit_attestation", "begin_session", "describe_access"]) {
      expect(hints[name]!.readOnlyHint, name).toBe(true);
    }
    expect(hints.execute_x402_round).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(hints.execute_subscription_round).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(hints.send_signed_transaction).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(hints.complete_session).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("documents every hosted tool in docs/hosted-http.md", () => {
    const doc = readRepoFile("docs/hosted-http.md");
    for (const name of HOSTED_TOOL_NAMES) {
      expect(doc, name).toContain(`\`${name}\``);
    }
    expect(doc).not.toMatch(/X-Molpha-Privy|X-Molpha-Turnkey/);
  });
});

describe("published metadata", () => {
  // sync-version propagates the version only; tool names are kept in step by hand.
  it("lists the registered tools in manifest.json", () => {
    const manifest = JSON.parse(readRepoFile("manifest.json")) as { tools: Array<{ name: string; description: string }> };
    expect(manifest.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
    for (const tool of manifest.tools) {
      expect(tool.description, tool.name).not.toBe("");
    }
  });

  it("documents every tool in the README tool table", () => {
    const readme = readRepoFile("README.md");
    for (const name of TOOL_NAMES) {
      expect(readme).toContain(`| \`${name}\` |`);
    }
  });

  it("does not mention retired tool names", () => {
    for (const file of ["README.md", "manifest.json", "server.json"]) {
      expect(readRepoFile(file), file).not.toMatch(RETIRED_NAMES);
    }
  });
});

describe("over MCP", () => {
  async function connect(): Promise<Client> {
    const server = new McpServer({ name: "molpha-mcp-test", version: "0.0.0" });
    registerTools(server);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("advertises self-contained output schemas and annotations", async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(READ_ONLY.includes(tool.name));
      // A $ref appears when one zod instance is reused inside a schema; not every client resolves it.
      expect(JSON.stringify(tool.outputSchema), tool.name).not.toContain("$ref");
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain("$ref");
    }
    await client.close();
  });

  it("returns structuredContent the client validates, alongside the same JSON as text", async () => {
    const client = await connect();

    const result = await client.callTool({
      name: "derive_source_id",
      arguments: { apiConfig: { url: "https://api.example.com/price", responseParser: "$.price" } }
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      sourceId: "0x2f00de126dd0f45e8a7f0a9854139d64e47b2f9707235406dc1c9c32d6fb9582"
    });
    const [text] = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(text!.text)).toEqual(result.structuredContent);
    await client.close();
  });
});

describe("derive_source_id", () => {
  const derive = collectTools().find((tool) => tool.name === "derive_source_id")!;

  const call = (apiConfig: Record<string, unknown>) => callTool("derive_source_id", { apiConfig });

  it("matches the SDK/node sourceId vector without any wallet configured", async () => {
    const out = await call({ url: "https://api.example.com/price", responseParser: "$.price" });

    expect(out.sourceId).toBe("0x2f00de126dd0f45e8a7f0a9854139d64e47b2f9707235406dc1c9c32d6fb9582");
    expect(out.canonicalJson).toBe(
      '{"url":"https://api.example.com/price","method":"GET","headers":{},"responseParser":"$.price","valueTransform":""}'
    );
  });

  it("is independent of header insertion order", async () => {
    const base = { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate" };
    const a = await call({ ...base, headers: { "Z-Header": "z", "A-Header": "a" } });
    const b = await call({ ...base, headers: { "A-Header": "a", "Z-Header": "z" } });

    expect(a.sourceId).toBe(b.sourceId);
    expect(a.canonicalJson).toContain('"headers":{"A-Header":"a","Z-Header":"z"}');
  });

  it("states the derivation, and that it is not JCS, in its description", () => {
    expect(derive.config.description).toContain("keccak256");
    expect(derive.config.description).toContain("url, method, headers, responseParser, valueTransform");
    expect(derive.config.description).toContain("not RFC 8785 (JCS)");
  });
});

describe("build_verifier_calldata", () => {
  const tool = collectTools().find((candidate) => candidate.name === "build_verifier_calldata")!;
  const { dataUpdate, signature } = toDataUpdateArtifact(flatResult);

  it("builds calldata from a round's dataUpdate/signature verbatim, with no wallet configured", async () => {
    const evm = await callTool("build_verifier_calldata", { dataUpdate, signature, chain: "evm" });
    const starknet = await callTool("build_verifier_calldata", { dataUpdate, signature, chain: "starknet" });

    expect(evm).toMatchObject({
      chain: "evm",
      verifierArgs: {
        evm: {
          args: {
            attestation: {
              payload: {
                value: flatResult.valuePacked,
                sourceId: flatResult.sourceId,
                registryVersion: 7,
                signaturesRequired: 1
              },
              signature: { signersBitmap: "4" }
            },
            maxAge: "0"
          }
        }
      }
    });
    // The verifier's payload names the round time `timestamp` (the SDK this server was first built against
    // said `canonicalTimestamp`); the value is the same either way.
    const evmPayload = (evm.verifierArgs as { evm: { args: { attestation: { payload: Record<string, unknown> } } } }).evm.args.attestation.payload;
    expect(String(evmPayload.timestamp ?? evmPayload.canonicalTimestamp)).toBe(String(flatResult.timestamp));
    expect(String(evm.note)).toContain("no freshness check");
    const evmBounded = await callTool("build_verifier_calldata", { dataUpdate, signature, chain: "evm", maxAge: 300 });
    expect(evmBounded).toMatchObject({ verifierArgs: { evm: { args: { maxAge: "300" } } } });
    expect((evm.verifierArgs as Record<string, unknown>).errors).toBeUndefined();
    expect(starknet).toMatchObject({ chain: "starknet", verifierArgs: { starknet: { args: { attestation: { payload: { registry_version: 7 } }, maxAge: 0 } } } });
    const bounded = await callTool("build_verifier_calldata", { dataUpdate, signature, chain: "starknet", maxAge: 300 });
    expect(bounded).toMatchObject({ verifierArgs: { starknet: { args: { maxAge: 300 } } } });
    expect(String(bounded.note)).not.toContain("no freshness check");
  });

  it("takes the canonical attestation shape as input", () => {
    const input = tool.config.inputSchema;
    expect(input.dataUpdate!.safeParse(dataUpdate).success).toBe(true);
    expect(input.signature!.safeParse(signature).success).toBe(true);
    expect(input.signature!.safeParse({ s: signature.signature }).success).toBe(false);
  });

  it("says it does not verify", () => {
    expect(tool.config.description).toMatch(/does not verify anything/);
  });
});
