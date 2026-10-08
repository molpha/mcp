#!/usr/bin/env node
/**
 * Builds the Claude Desktop bundle (`.mcpb`) from an allowlist, never from the working tree.
 *
 * `mcpb pack .` is a denylist: it ignores .gitignore and happily zips a developer's `.env`, test
 * credentials, `.claude/` settings and every dev dependency. This script instead stages exactly what
 * the published npm package contains (`npm pack` honours the `files` allowlist), adds the manifest and
 * lockfile, installs production dependencies from the lockfile, and packs that directory. It then
 * lists the finished bundle and fails if anything that should never ship is inside.
 *
 *   node scripts/pack-mcpb.mjs [output.mcpb]     default: molpha-mcp.mcpb in the repo root (git-ignored)
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(ROOT, "molpha-mcp.mcpb"));
const mcpb = join(ROOT, "node_modules/.bin/mcpb");
if (!existsSync(mcpb)) throw new Error("@anthropic-ai/mcpb is not installed: run `npm ci`");
if (!existsSync(join(ROOT, "dist/src/server.js"))) throw new Error("dist/ is missing: run `npm run build` first");

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });

const work = mkdtempSync(join(tmpdir(), "molpha-mcpb-"));
try {
  const stage = join(work, "stage");
  mkdirSync(stage);

  // 1. Exactly the files the npm package ships.
  const tarball = execFileSync("npm", ["pack", "--silent", "--pack-destination", work], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").pop();
  run("tar", ["-xzf", join(work, tarball), "-C", stage, "--strip-components=1"], work);

  // 2. The bundle manifest and the lockfile the install below is pinned by.
  copyFileSync(join(ROOT, "manifest.json"), join(stage, "manifest.json"));
  copyFileSync(join(ROOT, "package-lock.json"), join(stage, "package-lock.json"));

  // 3. Production dependencies only (optional ones included: Privy and Turnkey are a signer choice in the dialog).
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);

  // 4. Validate, then pack the staged directory.
  run(mcpb, ["validate", join(stage, "manifest.json")], stage);
  run(mcpb, ["pack", stage, output], work);

  // 5. Refuse a bundle that carries anything private or developer-only.
  const names = execFileSync("unzip", ["-Z1", output], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
  // Dependencies carry their own dot-folders (.github/FUNDING.yml, .env.example); only our own files are judged.
  const ours = names.filter((name) => !name.startsWith("node_modules/"));
  const forbidden = ours.filter((name) =>
    /^\.env(\.|$)/.test(name) ||
    /^\.(claude|cursor|github|vercel|changeset)\//.test(name) ||
    /^(secrets|tmp|coverage)\//.test(name) ||
    /^dist\/test\//.test(name) ||
    /(^|\/)(privy-test|agent-test)\.json$/.test(name) ||
    /-secrets\.json$/.test(name) ||
    /\.mcpb$/.test(name)
  );
  if (forbidden.length > 0) {
    rmSync(output, { force: true });
    throw new Error(`the bundle would ship files that must never ship:\n  ${forbidden.slice(0, 20).join("\n  ")}`);
  }
  for (const required of ["manifest.json", "dist/src/server.js", "package.json"]) {
    if (!names.includes(required)) throw new Error(`the bundle is missing ${required}`);
  }
  console.log(`\npacked ${output} (${names.length} files)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
