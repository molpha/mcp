import { readFileSync } from "node:fs";
// Both source execution and dist/src resolve the package root without JSON import attributes.
const packageUrl = new URL(import.meta.url.includes("/dist/src/") ? "../../package.json" : "../package.json", import.meta.url);
export const serverVersion: string = JSON.parse(readFileSync(packageUrl, "utf8")).version;
