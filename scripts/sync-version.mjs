#!/usr/bin/env node
// Propagates the version from package.json to manifest.json and server.json
// (top-level version and every packages[].version). Run with --check to fail
// instead of writing, for CI.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

const readJson = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));
const writeJson = (name, data) =>
  writeFileSync(join(root, name), JSON.stringify(data, null, 2) + "\n");

const pkg = readJson("package.json");
const version = pkg.version;
const problems = [];
let changed = false;

const manifest = readJson("manifest.json");
if (manifest.version !== version) {
  problems.push(`manifest.json version is ${manifest.version}`);
  manifest.version = version;
  if (!checkOnly) writeJson("manifest.json", manifest);
  changed = true;
}

const server = readJson("server.json");
if (server.version !== version) {
  problems.push(`server.json version is ${server.version}`);
  server.version = version;
  changed = true;
}
for (const [i, entry] of (server.packages ?? []).entries()) {
  if (entry.identifier === pkg.name && entry.version !== version) {
    problems.push(`server.json packages[${i}] version is ${entry.version}`);
    entry.version = version;
    changed = true;
  }
}
if (changed && !checkOnly) writeJson("server.json", server);

if (server.name !== pkg.mcpName) {
  console.error(
    `server.json name (${server.name}) does not match package.json mcpName (${pkg.mcpName})`
  );
  process.exit(1);
}

if (problems.length === 0) {
  console.log(`versions in sync at ${version}`);
} else if (checkOnly) {
  console.error(`expected version ${version}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
} else {
  console.log(`synced to ${version}:\n  ${problems.join("\n  ")}`);
}
