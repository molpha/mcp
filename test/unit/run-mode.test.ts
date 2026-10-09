import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { RequestContext } from "../../src/clients.js";
import { loadConfig } from "../../src/config.js";
import { resolveRunMode } from "../../src/run-mode.js";
import { buildMcpEnvBlock, validateSignerEnv } from "../../src/setup-validation.js";
import { callTool, collectTools } from "./tool-harness.js";

const READ_TOOLS = [
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

describe("resolveRunMode", () => {
  const keypair = JSON.stringify(Array.from(Keypair.generate().secretKey));

  it.each([
    ["the --read-only flag", ["--read-only"], { OWNER_KEYPAIR: keypair }, "read-only"],
    ["SIGNER_BACKEND=none", [], { SIGNER_BACKEND: "none", OWNER_KEYPAIR: keypair }, "read-only"],
    ["no signer configured at all", [], {}, "read-only"],
    ["an unresolved bundle placeholder instead of a keypair", [], { SIGNER_BACKEND: "${user_config.signer_backend}", OWNER_KEYPAIR: "${user_config.owner_keypair}" }, "read-only"],
    ["a keypair and no backend named", [], { OWNER_KEYPAIR: keypair }, "signer"],
    ["the AGENT_KEYPAIR alias", [], { AGENT_KEYPAIR: keypair }, "signer"],
    ["an explicit memory backend without a keypair (an error at first use, never a silent downgrade)", [], { SIGNER_BACKEND: "memory" }, "signer"],
    ["a keychain backend", [], { SIGNER_BACKEND: "keychain", KEYCHAIN_BACKEND: "privy" }, "signer"],
    ["a keychain provider named without a backend", [], { KEYCHAIN_BACKEND: "turnkey" }, "signer"],
    ["a misspelled backend", [], { SIGNER_BACKEND: "memroy" }, "signer"]
  ])("%s", (_label, argv, env, expected) => {
    expect(resolveRunMode(argv, env).mode).toBe(expected);
  });

  it("says why it is read-only", () => {
    expect(resolveRunMode(["--read-only"], {})).toMatchObject({ mode: "read-only", reason: expect.stringContaining("--read-only") });
    expect(resolveRunMode([], {})).toMatchObject({ mode: "read-only", reason: expect.stringContaining("no signer is configured") });
  });
});

describe("the read-only tool surface", () => {
  it("registers exactly the read tools, and none that can only fail without a signer", () => {
    const names = collectTools({ readOnly: { reason: "test" } }).map((tool) => tool.name).sort();
    expect(names).toEqual(READ_TOOLS);
    expect(collectTools({ readOnly: { reason: "test" } }).every((tool) => tool.config.annotations.readOnlyHint === true)).toBe(true);
  });

  it("leaves the default surface at 13 tools", () => {
    expect(collectTools()).toHaveLength(13);
  });
});

describe("setup validation without a signer", () => {
  it("treats SIGNER_BACKEND=none and a bare environment as ok, not as a missing keypair", () => {
    for (const env of [{ SIGNER_BACKEND: "none" }, {}]) {
      const checks = validateSignerEnv(env);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ name: "signer_backend", ok: true, message: expect.stringContaining("read-only") });
    }
  });

  it("still rejects a misspelled backend", () => {
    expect(validateSignerEnv({ SIGNER_BACKEND: "memroy" })[0]).toMatchObject({ ok: false });
  });

  it("emits SIGNER_BACKEND=none for a read-only environment, and keeps keychain only for keychain", () => {
    expect(buildMcpEnvBlock({}).SIGNER_BACKEND).toBe("none");
    expect(buildMcpEnvBlock({ SIGNER_BACKEND: "none" }).SIGNER_BACKEND).toBe("none");
    expect(buildMcpEnvBlock({ SIGNER_BACKEND: "keychain", KEYCHAIN_BACKEND: "privy" }).SIGNER_BACKEND).toBe("keychain");
  });
});

describe("get_capabilities run level", () => {
  function contextFor(env: Record<string, string>): () => Promise<RequestContext> {
    const context = {
      config: loadConfig({ GATEWAY_ENDPOINTS: "http://gateway.test", SOLANA_RPC: "http://solana.test", ...env }),
      gateway: { getNodes: async () => [] },
      solana: { getRegistryVersion: async () => 7 }
    };
    return async () => context as unknown as RequestContext;
  }

  it("is read-only, with no round tools named, when the server holds no signer", async () => {
    const out = await callTool("get_capabilities", {}, { readOnly: { reason: "no signer is configured" }, getContext: contextFor({}) });

    expect(out).toMatchObject({ runLevel: "read-only", runLevelReason: expect.stringContaining("no signer is configured"), payment: { signing: "none" } });
    expect((out.payment as Record<string, unknown>).subscription).toBeUndefined();
    expect((out.payment as Record<string, unknown>).x402).toBeUndefined();
  });

  it("is dry-run under MOLPHA_DRY_RUN=true and live otherwise", async () => {
    expect(await callTool("get_capabilities", {}, { getContext: contextFor({ MOLPHA_DRY_RUN: "true" }) })).toMatchObject({
      runLevel: "dry-run",
      payment: { signing: "server" }
    });
    expect(await callTool("get_capabilities", {}, { getContext: contextFor({}) })).toMatchObject({ runLevel: "live" });
  });

  it("is live on the hosted server whatever MOLPHA_DRY_RUN says, because its tools never read it", async () => {
    const out = await callTool("get_capabilities", {}, { hosted: {}, getContext: contextFor({ MOLPHA_DRY_RUN: "true" }) });

    expect(out).toMatchObject({ runLevel: "live", payment: { signing: "caller" } });
  });
});
