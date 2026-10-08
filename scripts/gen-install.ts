/**
 * Writes every install snippet from src/install-config.ts into the files that show one: the integration guide,
 * the README quick start and the examples. Run `npm run gen:install` after a change; CI and `npm test` run the
 * same renderers and fail if a file is out of date, so a snippet cannot name a stale version or a stale command.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PACKAGE_NAME,
  buildEnv,
  claudeCodeCommand,
  clientSnippets,
  codexToml,
  cursorDeeplink,
  marketplaceManifest,
  mcpServersJson,
  npxLauncher,
  pluginManifest,
  serverEntry,
  setupPrompt,
  signerEnv,
  vscodeDeeplink,
  vscodeJson,
  type Env,
  type SignerKind
} from "../src/install-config.js";
import { nextVersion } from "./install-version.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fence = (lang: string, body: string): string => `\`\`\`${lang}\n${body.trimEnd()}\n\`\`\``;

/** A signer plus the level, without the network defaults: what the guide shows next to its signer table. */
const slimEnv = (kind: Exclude<SignerKind, "none">): Env => ({ ...signerEnv(kind), MOLPHA_DRY_RUN: "true" });

export function renderBlocks(version: string): Record<string, Record<string, string>> {
  const launcher = npxLauncher(version);
  const readOnly = serverEntry(launcher, undefined, ["--read-only"]);
  const build = serverEntry(launcher, slimEnv("privy"));
  const keypair = serverEntry(launcher, slimEnv("keypair"));
  const pinned = `${PACKAGE_NAME}@${version}`;

  return {
    "docs/integration.md": {
      "explore-local": fence("sh", claudeCodeCommand(readOnly)),
      "explore-links": `[Add to Cursor](${cursorDeeplink(readOnly)}) · [Install in VS Code](${vscodeDeeplink(readOnly)})`,
      doctor: fence("sh", `npx -y ${pinned} doctor`),
      "connect-claude-code": fence("sh", claudeCodeCommand(build)),
      "connect-cursor": fence("json", mcpServersJson(build)),
      "connect-vscode": fence("json", vscodeJson(build)),
      "connect-codex": fence("toml", codexToml(keypair)),
      provision: fence(
        "sh",
        `npx -y ${pinned} provision subscribe --plan Basic --max-price-usdc 20000000 --dry-run`
      ),
      "hosted-local": fence("sh", `npx -y ${pinned} --http --port 8402`),
      prompt: fence("text", setupPrompt(version))
    },
    "README.md": {
      doctor: fence("sh", `npx -y ${pinned} doctor`),
      provision: fence(
        "sh",
        `npx -y ${pinned} provision subscribe --plan Basic --max-price-usdc 20000000 --dry-run`
      ),
      "quick-start": [
        "Needs Node.js 24 or later. Nothing to clone or build.",
        "",
        "**1. Look around, no wallet.** Read-only: capabilities, providers, `sourceId`s, prices, feed values.",
        "",
        fence("sh", claudeCodeCommand(readOnly)),
        "",
        "**2. Build with a testnet wallet.** Put your signer settings in a `.env` file (see [Setup](#setup)), then check them. The doctor prints a ready-to-paste config for your client, with secrets left as placeholders:",
        "",
        fence("sh", `npx -y ${pinned} doctor`),
        "",
        "A config like this keeps every write a preview (`MOLPHA_DRY_RUN=true`):",
        "",
        fence("sh", claudeCodeCommand(build)),
        "",
        "**3. Spend** only when you mean to: fund the wallet, then set `MOLPHA_DRY_RUN=false` in the server's config. The full guide, with Cursor, VS Code, Codex and Claude Desktop, is [docs/integration.md](docs/integration.md)."
      ].join("\n")
    }
  };
}

export function renderExamples(version: string): Record<string, string> {
  const launcher = npxLauncher(version);
  const out: Record<string, string> = {};
  for (const [name, kind] of [["memory", "keypair"], ["privy", "privy"], ["turnkey", "turnkey"]] as const) {
    const entry = serverEntry(launcher, buildEnv(kind));
    out[`examples/cursor-${name}.mcp.json`] = `${mcpServersJson(entry)}\n`;
    out[`examples/codex-${name}.toml`] = codexToml(entry);
  }
  return out;
}

/** The Claude Code plugin and the marketplace that lists it. */
export function renderPlugin(version: string): Record<string, string> {
  return {
    "plugins/molpha/.claude-plugin/plugin.json": `${JSON.stringify(pluginManifest(version), null, 2)}\n`,
    ".claude-plugin/marketplace.json": `${JSON.stringify(marketplaceManifest(), null, 2)}\n`
  };
}

const marker = (name: string): [string, string] => [`<!-- molpha:generated:${name} -->`, `<!-- /molpha:generated:${name} -->`];

/** Replaces the content between each pair of markers. A missing marker is an error, never a silent skip. */
export function applyBlocks(file: string, text: string, blocks: Record<string, string>): string {
  let out = text;
  for (const [name, body] of Object.entries(blocks)) {
    const [open, close] = marker(name);
    const start = out.indexOf(open);
    const end = out.indexOf(close);
    if (start === -1 || end === -1 || end < start) throw new Error(`${file}: missing generated block markers for "${name}" (${open} ... ${close})`);
    out = `${out.slice(0, start + open.length)}\n${body}\n${out.slice(end)}`;
  }
  return out;
}

/** Every file this script owns, with the content it should have. */
export function renderAll(root: string = ROOT, version: string = nextVersion(root, PACKAGE_NAME)): Record<string, string> {
  const files: Record<string, string> = { ...renderExamples(version), ...renderPlugin(version) };
  for (const [file, blocks] of Object.entries(renderBlocks(version))) {
    files[file] = applyBlocks(file, readFileSync(join(root, file), "utf8"), blocks);
  }
  return files;
}

function main(): void {
  const check = process.argv.includes("--check");
  const version = nextVersion(ROOT, PACKAGE_NAME);
  const stale: string[] = [];
  for (const [file, content] of Object.entries(renderAll(ROOT, version))) {
    const path = join(ROOT, file);
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (current === content) continue;
    if (check) {
      stale.push(file);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      console.log(`wrote ${file}`);
    }
  }
  if (check && stale.length > 0) {
    console.error(`Out of date (run \`npm run gen:install\`): ${stale.join(", ")}`);
    process.exit(1);
  }
  if (check) console.log(`install snippets are up to date for ${PACKAGE_NAME}@${version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
