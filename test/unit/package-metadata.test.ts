import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../scripts/gen-install.js";

const read = <T>(file: string): T => JSON.parse(readFileSync(join(ROOT, file), "utf8")) as T;

interface Pkg {
  bin: Record<string, string>;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts: Record<string, string>;
}

const SIGNER_SDKS = ["@privy-io/node", "@turnkey/sdk-server", "@turnkey/solana"];

describe("package.json", () => {
  const pkg = read<Pkg>("package.json");

  it("has exactly one bin, so `npx -y @molpha/mcp` resolves without naming it", () => {
    expect(Object.keys(pkg.bin)).toEqual(["molpha-mcp"]);
    expect(pkg.bin["molpha-mcp"]).toBe("dist/src/cli.js");
    expect(existsSync(join(ROOT, "src/cli.ts"))).toBe(true);
  });

  it("ships the Privy and Turnkey SDKs as optional dependencies, and nowhere else", () => {
    for (const name of SIGNER_SDKS) {
      expect(pkg.optionalDependencies[name], name).toBeDefined();
      expect(pkg.dependencies[name], name).toBeUndefined();
      expect(pkg.devDependencies[name], name).toBeUndefined();
      expect(pkg.peerDependencies?.[name], name).toBeUndefined();
    }
  });

  it("pins @molpha/sdk to an exact version", () => {
    expect(pkg.dependencies["@molpha/sdk"]).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);
  });

  it("regenerates the install snippets when versions change", () => {
    expect(pkg.scripts["ci:version"]).toContain("gen:install");
  });
});

describe("packaged defaults", () => {
  it("manifest.json starts a bundle in dry-run, with the signer optional", () => {
    const manifest = read<{ user_config: Record<string, { default?: unknown; required?: boolean }> }>("manifest.json");

    expect(manifest.user_config.dry_run?.default).toBe(true);
    expect(manifest.user_config.signer_backend?.required).toBe(false);
    expect(manifest.user_config.signer_backend?.default).toBeUndefined();
  });

  it("server.json defaults to dry-run, with the signer optional and `none` allowed", () => {
    const server = read<{ packages: Array<{ environmentVariables: Array<{ name: string; default?: string; isRequired?: boolean; choices?: string[] }> }> }>("server.json");
    const env = (name: string) => server.packages[0]!.environmentVariables.find((variable) => variable.name === name);

    expect(env("MOLPHA_DRY_RUN")?.default).toBe("true");
    expect(env("SIGNER_BACKEND")?.isRequired).toBe(false);
    expect(env("SIGNER_BACKEND")?.choices).toContain("none");
  });
});

describe("Claude Code plugin", () => {
  interface Plugin {
    name: string;
    version?: string;
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    userConfig: Record<string, { type: string; sensitive?: boolean; default?: unknown; required?: boolean }>;
  }
  const plugin = read<Plugin>("plugins/molpha/.claude-plugin/plugin.json");
  const marketplace = read<{ name: string; plugins: Array<{ name: string; source: string }> }>(".claude-plugin/marketplace.json");

  it("is listed by the marketplace, from a subdirectory that holds the plugin and the skill", () => {
    const entry = marketplace.plugins[0]!;

    expect(`${entry.name}@${marketplace.name}`).toBe("molpha@molpha");
    expect(entry.source).toBe("./plugins/molpha");
    expect(entry.name).toBe(plugin.name);
    expect(existsSync(join(ROOT, entry.source, ".claude-plugin/plugin.json"))).toBe(true);
    expect(existsSync(join(ROOT, entry.source, "skills/molpha/SKILL.md"))).toBe(true);
  });

  it("declares every option it substitutes, keeps dry-run on by default, and masks the two secrets", () => {
    const env = plugin.mcpServers.molpha!.env;
    const referenced = Object.values(env).map((value) => /^\$\{user_config\.(\w+)\}$/.exec(value)?.[1]);

    expect(referenced.every((key) => key !== undefined && key in plugin.userConfig)).toBe(true);
    expect(plugin.userConfig.dry_run).toMatchObject({ type: "boolean", default: true });
    expect(env.MOLPHA_DRY_RUN).toBe("${user_config.dry_run}");
    expect(Object.entries(plugin.userConfig).filter(([, option]) => option.sensitive).map(([key]) => key).sort()).toEqual(["privy_app_secret", "turnkey_api_private_key"]);
  });

  it("has no required option, so it installs read-only, and no pinned version of its own", () => {
    expect(Object.values(plugin.userConfig).some((option) => option.required)).toBe(false);
    expect(plugin.version).toBeUndefined();
  });

  it("launches the pinned npm package with npx", () => {
    const server = plugin.mcpServers.molpha!;

    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", expect.stringMatching(/^@molpha\/mcp@\d+\.\d+\.\d+$/)]);
  });
});
