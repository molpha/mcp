import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  claudeCodeCommand,
  clientSnippets,
  codexToml,
  cursorDeeplink,
  locatePackage,
  npxLauncher,
  serverEntry,
  setupPrompt,
  vscodeDeeplink
} from "../../src/install-config.js";
import { buildMcpEnvBlock, snippetEnv } from "../../src/setup-validation.js";

const CANARIES = {
  PRIVY_APP_SECRET: "privy-secret-canary-7f3a",
  TURNKEY_API_PRIVATE_KEY: "turnkey-private-canary-91bc",
  MOLPHA_SOURCE_PAYER_KEY: "c0ffee".repeat(10) + "c0ff"
};
const solanaAddress = Keypair.generate().publicKey.toBase58();

function allText(env: NodeJS.ProcessEnv): string {
  const entry = serverEntry(npxLauncher("9.9.9"), snippetEnv(env, undefined));
  return [JSON.stringify(buildMcpEnvBlock(env)), ...Object.values(clientSnippets(entry)), cursorDeeplink(entry), vscodeDeeplink(entry)].join("\n");
}

describe("snippets copied from a real environment", () => {
  it("never contain a secret, whichever signer is configured", () => {
    const privy = {
      SIGNER_BACKEND: "keychain", KEYCHAIN_BACKEND: "privy", PRIVY_APP_ID: "app-id", PRIVY_APP_SECRET: CANARIES.PRIVY_APP_SECRET,
      PRIVY_WALLET_ID: "wallet-id", PRIVY_WALLET_ADDRESS: solanaAddress, MOLPHA_SOURCE_PAYER_KEY: CANARIES.MOLPHA_SOURCE_PAYER_KEY
    };
    const turnkey = {
      SIGNER_BACKEND: "keychain", KEYCHAIN_BACKEND: "turnkey", TURNKEY_API_PUBLIC_KEY: "pub", TURNKEY_API_PRIVATE_KEY: CANARIES.TURNKEY_API_PRIVATE_KEY,
      TURNKEY_ORGANIZATION_ID: "org", TURNKEY_WALLET_ADDRESS: solanaAddress, MOLPHA_SOURCE_PAYER_KEY: CANARIES.MOLPHA_SOURCE_PAYER_KEY
    };
    for (const env of [privy, turnkey]) {
      const text = allText(env);
      for (const canary of Object.values(CANARIES)) {
        expect(text, `a canary leaked: ${canary}`).not.toContain(canary);
        // Deeplinks carry the config encoded, so check the decoded form too.
        expect(decodeURIComponent(text)).not.toContain(canary);
      }
      expect(text).toMatch(/<(privy-app-secret|turnkey-api-private-key|evm-payer-private-key)>/);
    }
  });

  it("keeps non-secret values and replaces secrets with placeholders", () => {
    const env = buildMcpEnvBlock({
      SIGNER_BACKEND: "keychain", KEYCHAIN_BACKEND: "privy", PRIVY_APP_ID: "app-id", PRIVY_APP_SECRET: CANARIES.PRIVY_APP_SECRET,
      PRIVY_WALLET_ID: "wallet-id", PRIVY_WALLET_ADDRESS: solanaAddress
    });

    expect(env).toMatchObject({ PRIVY_APP_ID: "app-id", PRIVY_WALLET_ADDRESS: solanaAddress, PRIVY_APP_SECRET: "<privy-app-secret>" });
  });

  it("with an env file, carries the file's path and the level, and nothing else from it", () => {
    const env = snippetEnv({ SIGNER_BACKEND: "memory", OWNER_KEYPAIR: "/tmp/owner.json", SOLANA_RPC: "https://rpc.example" }, "/home/me/molpha.env");

    expect(env).toEqual({ MOLPHA_ENV_FILE: "/home/me/molpha.env", MOLPHA_DRY_RUN: "true" });
  });
});

describe("MOLPHA_DRY_RUN in a pasted config", () => {
  it("is always present, true unless the user explicitly turned it off", () => {
    expect(buildMcpEnvBlock({}).MOLPHA_DRY_RUN).toBe("true");
    expect(buildMcpEnvBlock({ MOLPHA_DRY_RUN: "true" }).MOLPHA_DRY_RUN).toBe("true");
    expect(buildMcpEnvBlock({ MOLPHA_DRY_RUN: "false" }).MOLPHA_DRY_RUN).toBe("false");
  });
});

describe("renderers", () => {
  const entry = serverEntry(npxLauncher("0.2.0"), { SIGNER_BACKEND: "memory", OWNER_KEYPAIR: "<path-to-devnet-keypair.json>", MOLPHA_DRY_RUN: "true" });

  it("quotes placeholders so a shell does not read them as redirections", () => {
    expect(claudeCodeCommand(entry)).toBe(
      "claude mcp add molpha -e SIGNER_BACKEND=memory -e OWNER_KEYPAIR='<path-to-devnet-keypair.json>' -e MOLPHA_DRY_RUN=true -- npx -y @molpha/mcp@0.2.0"
    );
  });

  it("writes a Codex block that parses as the same server", () => {
    expect(codexToml(entry)).toContain('args = ["-y", "@molpha/mcp@0.2.0"]');
    expect(codexToml(entry)).toContain('OWNER_KEYPAIR = "<path-to-devnet-keypair.json>"');
  });

  it("encodes install links that decode back to the server entry", () => {
    const cursor = new URL(cursorDeeplink(entry));
    expect(cursor.protocol).toBe("cursor:");
    expect(cursor.searchParams.get("name")).toBe("molpha");
    expect(JSON.parse(Buffer.from(cursor.searchParams.get("config")!, "base64").toString())).toEqual(entry);

    const vscode = vscodeDeeplink(entry);
    expect(vscode.startsWith("vscode:mcp/install?")).toBe(true);
    expect(JSON.parse(decodeURIComponent(vscode.slice("vscode:mcp/install?".length)))).toEqual({ name: "molpha", type: "stdio", ...entry });
  });

  it("omits env when there is none", () => {
    expect(serverEntry(npxLauncher("0.2.0"), {}, ["--read-only"])).toEqual({ command: "npx", args: ["-y", "@molpha/mcp@0.2.0", "--read-only"] });
  });
});

describe("the setup prompt", () => {
  const prompt = setupPrompt("0.2.0");

  it("pins the version it was given, in every command", () => {
    expect(prompt.match(/@molpha\/mcp@[\w.-]+/g)).toEqual(["@molpha/mcp@0.2.0", "@molpha/mcp@0.2.0"]);
  });

  it("stops at dry-run, never asks for a secret in chat, and never delegates to the docs", () => {
    expect(prompt).toContain("MOLPHA_DRY_RUN=true");
    expect(prompt).toContain("Do not ask me to paste secrets into this chat");
    expect(prompt).toContain("Never create, print, copy or move a private key");
    expect(prompt).toContain("Make no writes and spend nothing.");
    expect(prompt).not.toMatch(/read (our|the) docs/i);
  });
});

describe("locatePackage", () => {
  it("finds this checkout, and reports it as not installed", () => {
    const located = locatePackage();
    expect(located.installed).toBe(false);
    expect(located.root.endsWith("mcp")).toBe(true);
  });

  it("reports a package inside node_modules as installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "molpha-locate-"));
    try {
      const pkgDir = join(dir, "node_modules", "@molpha", "mcp");
      mkdirSync(join(pkgDir, "dist", "src"), { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@molpha/mcp" }));
      const located = locatePackage(pathToFileURL(join(pkgDir, "dist", "src", "install-config.js")).href);

      expect(located).toEqual({ root: pkgDir, installed: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
