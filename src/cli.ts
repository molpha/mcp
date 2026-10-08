#!/usr/bin/env node
// The package's only bin. `molpha-mcp` runs the server; `molpha-mcp doctor` and `molpha-mcp provision` are the
// setup commands. One bin is what lets `npx -y @molpha/mcp` resolve on its own: npm falls back to the package
// name only when there is exactly one. Vercel and the container run ./server.js directly, never this file.
const [command, ...rest] = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (command === "doctor") {
  const { runDoctor } = await import("../cli/doctor.js");
  process.exitCode = await runDoctor(rest).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
} else if (command === "provision") {
  const { runProvision } = await import("../cli/provision.js");
  await runProvision(rest).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
} else if (command !== undefined && !command.startsWith("-")) {
  // A typo such as `doctr` would otherwise start a stdio server and hang waiting for a client.
  fail(`Unknown command "${command}". Usage: molpha-mcp [--read-only] [--http [--port 8402]] | molpha-mcp doctor | molpha-mcp provision <subscribe|extend>`);
} else {
  await import("./server.js");
}
