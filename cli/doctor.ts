import { loadedEnvFile } from "../src/env.js";
import {
  checkBuildArtifact,
  checkGatewayEndpoints,
  checkSignerAvailability,
  checkSolanaRpc,
  snippetEnv,
  validateSignerEnv,
  type SetupCheck
} from "../src/setup-validation.js";
import { clientSnippets, locatePackage, npxLauncher, serverEntry, type Launcher } from "../src/install-config.js";
import { loadConfig } from "../src/config.js";
import { serverVersion } from "../src/version.js";

/** Runs the setup checks and prints a client config. Returns the process exit code. */
export async function runDoctor(_argv: string[] = []): Promise<number> {
  const pkg = locatePackage();
  const config = loadConfig();
  const checks: SetupCheck[] = [
    // An installed package is already built; only a checkout can be missing its `dist`.
    ...(pkg.installed ? [] : [checkBuildArtifact(pkg.root)]),
    ...validateSignerEnv(),
    await checkSignerAvailability(),
    await checkSolanaRpc(config.solanaRpc),
    await checkGatewayEndpoints(config.gatewayEndpoints)
  ];

  const failed = checks.filter((check) => !check.ok);

  console.log("Molpha MCP setup check\n");
  for (const check of checks) {
    const status = check.ok ? "ok" : "FAIL";
    console.log(`[${status}] ${check.name}: ${check.message}`);
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed. Fix env vars or key material, then re-run molpha-mcp doctor.`);
    return 1;
  }

  const launcher: Launcher = pkg.installed
    ? npxLauncher(serverVersion)
    : { command: "node", args: [`${pkg.root}/dist/src/server.js`] };
  const entry = serverEntry(launcher, snippetEnv(process.env, loadedEnvFile));
  const snippets = clientSnippets(entry);

  console.log("\nSecrets are never printed: edit any <placeholder> below in your client config, not in chat.");
  if (loadedEnvFile) console.log(`Settings are read from ${loadedEnvFile}; the configs below point at it.`);
  console.log("MOLPHA_DRY_RUN=true keeps every write a preview. Change it only when you mean to spend.\n");

  console.log("Claude Code:\n");
  console.log(snippets.claudeCode);
  console.log("\nCursor / Claude Desktop (mcpServers JSON):\n");
  console.log(snippets.cursor);
  console.log("\nVS Code (.vscode/mcp.json):\n");
  console.log(snippets.vscode);
  console.log("\nCodex (~/.codex/config.toml):\n");
  console.log(snippets.codex);

  console.log("Next: add the config to your client, restart it, and call get_capabilities.");
  return 0;
}
