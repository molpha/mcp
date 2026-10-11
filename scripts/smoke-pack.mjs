#!/usr/bin/env node
/**
 * Smoke test for what actually ships: pack the package, run the tarball the way a user does
 * (`npx -y <tarball>`), and talk to it over stdio. It catches the failures a unit test cannot see:
 * a bin that npx cannot resolve, a tool surface that drifted from the manifest, a missing optional
 * dependency, instructions that never reach the client.
 *
 *   node scripts/smoke-pack.mjs          pack, then run the tarball with npx (the real check)
 *   node scripts/smoke-pack.mjs --dist   run the already-built dist/ directly (fast; skips the install checks)
 *
 * The real check installs from the npm registry, so it needs network and an npm config that allows the
 * pinned dependency versions. Nothing here touches a public Solana network: the server is pointed at a
 * closed loopback port, and the signer is a throwaway key generated for this run.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distOnly = process.argv.includes("--dist");
const failures = [];
const passed = [];

function check(name, ok, detail = "") {
  (ok ? passed : failures).push(name);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n       ${detail}` : ""}`);
}

const sorted = (values) => [...values].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

const work = mkdtempSync(join(tmpdir(), "molpha-smoke-"));
const emptyCwd = join(work, "cwd"); // no .env here: the server must not pick up a developer's settings
const npmCache = join(work, "npm-cache");
execFileSync("mkdir", ["-p", emptyCwd, npmCache]);

/** A throwaway ed25519 Solana keypair file: seed || public key, as the 64-byte JSON array. */
function writeThrowawayKeypair(path) {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const bytes = [...Buffer.from(jwk.d, "base64url"), ...Buffer.from(jwk.x, "base64url")];
  writeFileSync(path, JSON.stringify(bytes), { mode: 0o600 });
}
const keypairPath = join(work, "throwaway-keypair.json");
writeThrowawayKeypair(keypairPath);

let launch; // { command, args, tarball? } that starts the server under test
try {
  if (distOnly) {
    if (!existsSync(join(ROOT, "dist/src/cli.js"))) throw new Error("dist/src/cli.js is missing: run `npm run build` first");
    launch = { command: process.execPath, args: [join(ROOT, "dist/src/cli.js")] };
  } else {
    console.log("building and packing...");
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
    // The tarball sits in the server's working directory and is named with a `./` prefix: npx treats an
    // absolute path to an existing file as a command to execute, and only `./name.tgz` as a package spec.
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", emptyCwd], { cwd: ROOT, encoding: "utf8" }));
    const tarball = join(emptyCwd, packed[0].filename);
    check("npm pack produced a tarball", existsSync(tarball));
    launch = { command: "npx", args: ["-y", `./${packed[0].filename}`], tarball };
  }

  const baseEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    npm_config_cache: npmCache,
    GATEWAY_ENDPOINTS: "http://127.0.0.1:9",
    SOLANA_RPC: "http://127.0.0.1:9"
  };

  /** Starts the server under test, runs `fn(client)`, and always closes it. */
  async function withServer(extraArgs, extraEnv, fn) {
    const transport = new StdioClientTransport({
      command: launch.command,
      args: [...launch.args, ...extraArgs],
      cwd: emptyCwd,
      env: { ...baseEnv, ...extraEnv },
      stderr: "pipe"
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => (stderr += chunk));
    const client = new Client({ name: "molpha-smoke", version: "0.0.0" });
    try {
      await client.connect(transport);
      return await fn(client);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `\n       server stderr: ${stderr.trim().slice(0, 400)}` : ""}`);
    } finally {
      await client.close().catch(() => {});
    }
  }

  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  const manifestTools = manifest.tools.map((tool) => tool.name);

  // 1. A signer and nothing else: the full local surface, instructions, and the manifest agree.
  const live = await withServer([], { OWNER_KEYPAIR: keypairPath, SIGNER_BACKEND: "memory" }, async (client) => {
    const tools = (await client.listTools()).tools;
    const caps = await client.callTool({ name: "get_capabilities", arguments: {} });
    return { tools, instructions: client.getInstructions(), runLevel: caps.structuredContent?.runLevel };
  });
  check("tools/list matches manifest.json", same(live.tools.map((tool) => tool.name), manifestTools), `got ${live.tools.map((t) => t.name).join(", ")}`);
  check("initialize returns instructions", typeof live.instructions === "string" && live.instructions.length > 200);
  check("a signer with no MOLPHA_DRY_RUN is live", live.runLevel === "live", `runLevel=${live.runLevel}`);

  // 2. --read-only offers exactly the read tools, even with a signer configured.
  const readOnly = await withServer(["--read-only"], { OWNER_KEYPAIR: keypairPath, SIGNER_BACKEND: "memory" }, async (client) => {
    const caps = await client.callTool({ name: "get_capabilities", arguments: {} });
    return { tools: (await client.listTools()).tools, runLevel: caps.structuredContent?.runLevel, instructions: client.getInstructions() };
  });
  const readNames = live.tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name);
  check("--read-only lists exactly the readOnlyHint tools", same(readOnly.tools.map((tool) => tool.name), readNames), `got ${readOnly.tools.map((t) => t.name).join(", ")}`);
  check("--read-only reports runLevel read-only", readOnly.runLevel === "read-only", `runLevel=${readOnly.runLevel}`);
  check("--read-only instructions name no write tool", !/execute_subscription_round|execute_x402_round|submit_attestation/.test(readOnly.instructions ?? ""));

  // 3. No signer at all: a bare install is read-only, not a server whose tools all fail.
  const bare = await withServer([], {}, async (client) => ({ tools: (await client.listTools()).tools }));
  check("a bare install (no signer) is read-only", same(bare.tools.map((tool) => tool.name), readNames), `got ${bare.tools.map((t) => t.name).join(", ")}`);

  // 4. MOLPHA_DRY_RUN=true locks writes: the level says so, and dryRun: false is refused.
  const locked = await withServer([], { OWNER_KEYPAIR: keypairPath, SIGNER_BACKEND: "memory", MOLPHA_DRY_RUN: "true" }, async (client) => {
    const caps = await client.callTool({ name: "get_capabilities", arguments: {} });
    const refused = await client.callTool({
      name: "execute_subscription_round",
      arguments: { apiConfig: { url: "https://example.invalid/rate", responseParser: "$.rate" }, chains: ["solana"], dryRun: false }
    });
    const body = refused.isError ? JSON.parse(refused.content.at(-1).text) : {};
    return { runLevel: caps.structuredContent?.runLevel, isError: refused.isError === true, code: body.code };
  });
  check("MOLPHA_DRY_RUN=true reports runLevel dry-run", locked.runLevel === "dry-run", `runLevel=${locked.runLevel}`);
  check("dryRun: false is refused under the lock", locked.isError && locked.code === "dry_run_locked", `isError=${locked.isError} code=${locked.code}`);

  // 5. The doctor is reachable through the same bin. It fails its network checks on the closed port; only its header matters.
  const doctor = spawnSync(launch.command, [...launch.args, "doctor"], { cwd: emptyCwd, env: { ...baseEnv }, encoding: "utf8", timeout: 120_000 });
  check("`doctor` runs through the bin", (doctor.stdout ?? "").includes("Molpha MCP setup check"), `${(doctor.stderr ?? "").slice(0, 300)}`);

  // 6. A typo is an error, not a server that waits forever on stdin.
  const typo = spawnSync(launch.command, [...launch.args, "doctr"], { cwd: emptyCwd, env: { ...baseEnv }, encoding: "utf8", timeout: 60_000 });
  check("an unknown command exits non-zero", typo.status !== 0 && /Unknown command/.test(typo.stderr ?? ""), `status=${typo.status} ${(typo.stderr ?? "").slice(0, 200)}`);

  // 7. What the tarball installs: one bin, and the optional signer SDKs resolve (npm drops an optional dependency silently).
  if (!distOnly) {
    const prefix = join(work, "install");
    execFileSync("mkdir", ["-p", prefix]);
    execFileSync("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", launch.tarball], { env: { ...process.env, npm_config_cache: npmCache }, stdio: "inherit" });
    const installed = join(prefix, "node_modules/@molpha/mcp");
    const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    check("the installed package has exactly one bin", same(Object.keys(pkg.bin ?? {}), ["molpha-mcp"]), JSON.stringify(pkg.bin));
    for (const name of ["@privy-io/node", "@turnkey/sdk-server", "@turnkey/solana"]) {
      check(`optional dependency ${name} is installed`, existsSync(join(prefix, "node_modules", name, "package.json")));
    }
    check("tests and local settings are not shipped", !existsSync(join(installed, "dist/test")) && !existsSync(join(installed, ".claude")) && !existsSync(join(installed, ".env")));
  }
} catch (error) {
  failures.push("smoke run");
  console.error(`FAIL smoke run\n       ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed.length} passed, ${failures.length} failed${distOnly ? " (dist mode: install checks skipped)" : ""}`);
process.exit(failures.length === 0 ? 0 : 1);
