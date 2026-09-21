import { readFileSync } from "node:fs";
// Both source execution and dist/src resolve the package root without JSON import attributes.
const packageUrl = new URL(import.meta.url.includes("/dist/src/") ? "../../package.json" : "../package.json", import.meta.url);
function readVersion(): string {
  try {
    return JSON.parse(readFileSync(packageUrl, "utf8")).version as string;
  } catch {
    return process.env.npm_package_version ?? "0.0.0";
  }
}
export const serverVersion: string = readVersion();
