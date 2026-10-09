import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Bump = "major" | "minor" | "patch";
const ORDER: Bump[] = ["patch", "minor", "major"];

export function bumpVersion(version: string, bump: Bump): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The highest bump a changeset file asks for this package, or undefined when it names none. */
export function bumpFromChangeset(text: string, packageName: string): Bump | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  let highest: Bump | undefined;
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^["']?([^"':]+)["']?\s*:\s*(major|minor|patch)\s*$/.exec(line.trim());
    if (match?.[1] === packageName) {
      const bump = match[2] as Bump;
      if (highest === undefined || ORDER.indexOf(bump) > ORDER.indexOf(highest)) highest = bump;
    }
  }
  return highest;
}

/**
 * The version the next release will have: package.json's version, bumped by the highest pending changeset.
 * Docs written before `changeset version` runs and after it therefore name the same release.
 */
export function nextVersion(root: string, packageName: string): string {
  const current = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  const dir = join(root, ".changeset");
  let highest: Bump | undefined;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const bump = bumpFromChangeset(readFileSync(join(dir, file), "utf8"), packageName);
    if (bump && (highest === undefined || ORDER.indexOf(bump) > ORDER.indexOf(highest))) highest = bump;
  }
  return highest ? bumpVersion(current, highest) : current;
}
