import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The one place that knows how to start this server from an MCP client. The doctor prints these snippets,
 * and `scripts/gen-install.ts` writes the same renderers into the docs, the examples and the plugin, so the
 * install instructions cannot drift from each other or from the package. Every function here is pure:
 * the version and the launcher are parameters.
 */
export const PACKAGE_NAME = "@molpha/mcp";
export const SERVER_NAME = "molpha";

export type Env = Record<string, string>;
export type SignerKind = "none" | "keypair" | "privy" | "turnkey";

export interface Launcher {
  command: string;
  args: string[];
}

export interface ServerEntry extends Launcher {
  env?: Env;
}

/** Values that must never be printed from a real environment. */
export const SECRET_ENV_NAMES: ReadonlySet<string> = new Set([
  "PRIVY_APP_SECRET",
  "TURNKEY_API_PRIVATE_KEY",
  "MOLPHA_SOURCE_PAYER_KEY"
]);

export function npxLauncher(version: string): Launcher {
  return { command: "npx", args: ["-y", `${PACKAGE_NAME}@${version}`] };
}

/** The environment a signer needs, with a placeholder for every value the user has to supply. */
export function signerEnv(kind: SignerKind): Env {
  switch (kind) {
    case "none":
      return { SIGNER_BACKEND: "none" };
    case "keypair":
      return { SIGNER_BACKEND: "memory", OWNER_KEYPAIR: "<path-to-devnet-keypair.json>" };
    case "privy":
      return {
        SIGNER_BACKEND: "keychain",
        KEYCHAIN_BACKEND: "privy",
        PRIVY_APP_ID: "<privy-app-id>",
        PRIVY_APP_SECRET: "<privy-app-secret>",
        PRIVY_WALLET_ID: "<privy-wallet-id>",
        PRIVY_WALLET_ADDRESS: "<base58-solana-address>"
      };
    case "turnkey":
      return {
        SIGNER_BACKEND: "keychain",
        KEYCHAIN_BACKEND: "turnkey",
        TURNKEY_API_PUBLIC_KEY: "<turnkey-api-public-key>",
        TURNKEY_API_PRIVATE_KEY: "<turnkey-api-private-key>",
        TURNKEY_ORGANIZATION_ID: "<turnkey-organization-id>",
        TURNKEY_WALLET_ADDRESS: "<base58-solana-address>"
      };
  }
}

/** A packaged build config: a signer, devnet defaults, and dry-run on. Going live is a deliberate edit. */
export function buildEnv(kind: Exclude<SignerKind, "none">, extra: Env = {}): Env {
  return {
    ...signerEnv(kind),
    SOLANA_RPC: "https://api.devnet.solana.com",
    MOLPHA_EVM_NETWORKS: "evm-sepolia",
    MOLPHA_STARKNET_NETWORKS: "starknet-sepolia",
    MOLPHA_DRY_RUN: "true",
    ...extra
  };
}

export function serverEntry(launcher: Launcher, env?: Env, extraArgs: string[] = []): ServerEntry {
  return {
    command: launcher.command,
    args: [...launcher.args, ...extraArgs],
    ...(env && Object.keys(env).length > 0 ? { env } : {})
  };
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** `claude mcp add`: env flags first, then `--` and the launch command. */
export function claudeCodeCommand(entry: ServerEntry): string {
  const env = Object.entries(entry.env ?? {}).map(([key, value]) => `-e ${key}=${shellQuote(value)}`);
  return ["claude mcp add", SERVER_NAME, ...env, "--", entry.command, ...entry.args.map(shellQuote)].join(" ");
}

/** `codex mcp add`: the one-line equivalent of the config.toml block. */
export function codexCommand(entry: ServerEntry): string {
  const env = Object.entries(entry.env ?? {}).map(([key, value]) => `--env ${key}=${shellQuote(value)}`);
  return ["codex mcp add", SERVER_NAME, ...env, "--", entry.command, ...entry.args.map(shellQuote)].join(" ");
}

/** Cursor and Claude Desktop share this `mcpServers` shape. */
export function mcpServersJson(entry: ServerEntry): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2);
}

export function vscodeJson(entry: ServerEntry): string {
  return JSON.stringify({ servers: { [SERVER_NAME]: { type: "stdio", ...entry } } }, null, 2);
}

export function codexToml(entry: ServerEntry): string {
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`
  ];
  if (entry.env && Object.keys(entry.env).length > 0) {
    lines.push("", `[mcp_servers.${SERVER_NAME}.env]`);
    for (const [key, value] of Object.entries(entry.env)) lines.push(`${key} = ${tomlString(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Cursor's "Add to Cursor" link: the base64 of the server entry alone, with no `mcpServers` wrapper. */
export function cursorDeeplink(entry: ServerEntry): string {
  const config = Buffer.from(JSON.stringify(entry)).toString("base64");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(config)}`;
}

/** VS Code's "Install in VS Code" link: the URL-encoded JSON of the server definition. */
export function vscodeDeeplink(entry: ServerEntry, scheme: "vscode" | "vscode-insiders" = "vscode"): string {
  return `${scheme}:mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER_NAME, type: "stdio", ...entry }))}`;
}

export interface ClientSnippets {
  claudeCode: string;
  cursor: string;
  codex: string;
  codexCommand: string;
  vscode: string;
}

export function clientSnippets(entry: ServerEntry): ClientSnippets {
  return {
    claudeCode: claudeCodeCommand(entry),
    cursor: mcpServersJson(entry),
    codex: codexToml(entry),
    codexCommand: codexCommand(entry),
    vscode: vscodeJson(entry)
  };
}

/** Where this code is running from: an installed package (npx, global) or a source checkout. */
export function locatePackage(fromUrl: string = import.meta.url): { root: string; installed: boolean } {
  let dir = dirname(fileURLToPath(fromUrl));
  for (;;) {
    const manifest = resolve(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === PACKAGE_NAME) {
          return { root: dir, installed: dir.split(sep).includes("node_modules") };
        }
      } catch {
        // An unreadable package.json is not ours; keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return { root: dirname(fileURLToPath(fromUrl)), installed: false };
    dir = parent;
  }
}

/**
 * The text a user pastes into an agent that can run shell commands. It stops at the build level, in dry-run:
 * spending is a separate decision. The version is a parameter so the prompt can never name a stale release.
 */
export function setupPrompt(version: string): string {
  const pinned = `${PACKAGE_NAME}@${version}`;
  return [
    "Set up the Molpha MCP server and skill in this agent, on Solana Devnet, in dry-run mode. Follow these steps exactly and stop if one fails.",
    "",
    "1. Run `node --version`. If it is below 24, stop and tell me.",
    "2. Install the Molpha skill. If you are Claude Code, run `/plugin marketplace add molpha/mcp` and `/plugin install molpha@molpha`, then skip step 4. Otherwise copy the `plugins/molpha/skills/molpha` folder from https://github.com/molpha/mcp into this agent's skills directory.",
    "3. Ask me which signer I use: Privy, Turnkey, or a local keypair file. Ask for non-secret values (IDs, wallet address, keypair file path). For secrets (PRIVY_APP_SECRET, TURNKEY_API_PRIVATE_KEY), write a placeholder and tell me which file and line to edit. Do not ask me to paste secrets into this chat. Never create, print, copy or move a private key.",
    `4. Add an MCP server named "${SERVER_NAME}" to this agent's config that runs \`npx -y ${pinned}\`, with my signer settings and MOLPHA_DRY_RUN=true in its env.`,
    `5. Once I confirm the placeholders are filled in, run \`npx -y ${pinned} doctor\` with the same settings and show me the output.`,
    "6. Reload the MCP server, call get_capabilities, and summarize the run level, network, chains and verifier addresses.",
    "",
    "Make no writes and spend nothing."
  ].join("\n");
}

/** Which `userConfig` key feeds which server environment variable, for the Claude Code plugin. */
const PLUGIN_ENV: Array<[envName: string, key: string]> = [
  ["SIGNER_BACKEND", "signer_backend"],
  ["OWNER_KEYPAIR", "owner_keypair"],
  ["KEYCHAIN_BACKEND", "keychain_backend"],
  ["PRIVY_APP_ID", "privy_app_id"],
  ["PRIVY_APP_SECRET", "privy_app_secret"],
  ["PRIVY_WALLET_ID", "privy_wallet_id"],
  ["PRIVY_WALLET_ADDRESS", "privy_wallet_address"],
  ["TURNKEY_API_PUBLIC_KEY", "turnkey_api_public_key"],
  ["TURNKEY_API_PRIVATE_KEY", "turnkey_api_private_key"],
  ["TURNKEY_ORGANIZATION_ID", "turnkey_organization_id"],
  ["TURNKEY_WALLET_ADDRESS", "turnkey_wallet_address"],
  ["MOLPHA_DRY_RUN", "dry_run"]
];

interface PluginOption {
  type: "string" | "boolean" | "file";
  title: string;
  description: string;
  sensitive?: boolean;
  default?: boolean;
}

const PLUGIN_OPTIONS: Record<string, PluginOption> = {
  signer_backend: { type: "string", title: "Signer", description: "memory (local keypair), keychain (Privy or Turnkey), or none. Leave empty, with no keypair, for a read-only server that cannot sign or spend." },
  owner_keypair: { type: "file", title: "Keypair file", description: "Signer memory only: a dedicated testnet Solana keypair file. Never a wallet you use elsewhere." },
  keychain_backend: { type: "string", title: "Keychain provider", description: "privy or turnkey, when the signer is keychain." },
  privy_app_id: { type: "string", title: "Privy app ID", description: "Privy keychain only." },
  privy_app_secret: { type: "string", title: "Privy app secret", description: "Privy keychain only. Stored in your system credential store.", sensitive: true },
  privy_wallet_id: { type: "string", title: "Privy wallet ID", description: "Privy keychain only." },
  privy_wallet_address: { type: "string", title: "Privy wallet address", description: "Privy keychain only: the wallet's base58 Solana address." },
  turnkey_api_public_key: { type: "string", title: "Turnkey API public key", description: "Turnkey keychain only." },
  turnkey_api_private_key: { type: "string", title: "Turnkey API private key", description: "Turnkey keychain only. Stored in your system credential store.", sensitive: true },
  turnkey_organization_id: { type: "string", title: "Turnkey organization ID", description: "Turnkey keychain only." },
  turnkey_wallet_address: { type: "string", title: "Turnkey wallet address", description: "Turnkey keychain only: the wallet's base58 Solana address." },
  dry_run: { type: "boolean", title: "Dry run", description: "Preview every write and payment instead of sending it. While on, a tool call cannot turn it off: to spend, untick this and restart.", default: true }
};

/**
 * The Claude Code plugin manifest. It carries no `version`, which would pin users until it changed, and it
 * pins the server's version in the launch command instead. Secrets are `sensitive` options, never literals.
 */
export function pluginManifest(version: string): Record<string, unknown> {
  const launcher = npxLauncher(version);
  return {
    name: SERVER_NAME,
    displayName: "Molpha",
    description: "Molpha oracle tools and the Molpha skill for agents. Testnet only (Solana Devnet and Sepolia). Dry-run on by default.",
    author: { name: "Molpha" },
    homepage: "https://docs.molpha.io/",
    repository: "https://github.com/molpha/mcp",
    license: "MIT",
    keywords: ["oracle", "solana", "evm", "starknet", "mcp"],
    mcpServers: {
      [SERVER_NAME]: {
        command: launcher.command,
        args: launcher.args,
        env: Object.fromEntries(PLUGIN_ENV.map(([envName, key]) => [envName, `\${user_config.${key}}`]))
      }
    },
    userConfig: PLUGIN_OPTIONS
  };
}

/** The marketplace that lists the plugin, so `/plugin marketplace add molpha/mcp` finds it. */
export function marketplaceManifest(): Record<string, unknown> {
  return {
    name: SERVER_NAME,
    description: "Molpha plugins for Claude Code",
    owner: { name: "Molpha" },
    plugins: [
      {
        name: SERVER_NAME,
        source: "./plugins/molpha",
        description: "The Molpha MCP server and skill together. Starts in dry-run, on testnets."
      }
    ]
  };
}
