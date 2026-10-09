import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, applyBlocks, renderAll } from "../../scripts/gen-install.js";
import { bumpFromChangeset, bumpVersion, nextVersion } from "../../scripts/install-version.js";

describe("generated install snippets", () => {
  it("are what the renderers produce today (run `npm run gen:install` if this fails)", () => {
    for (const [file, expected] of Object.entries(renderAll())) {
      expect(readFileSync(join(ROOT, file), "utf8"), `${file} is out of date`).toBe(expected);
    }
  });

  it("name the same release everywhere, and never an older one", () => {
    const version = nextVersion(ROOT, "@molpha/mcp");
    const files = ["docs/integration.md", "README.md", "examples/cursor-privy.mcp.json", "examples/codex-memory.toml"];
    for (const file of files) {
      const versions = new Set(readFileSync(join(ROOT, file), "utf8").match(/@molpha\/mcp@[\w.-]+/g));
      expect([...versions], file).toEqual([`@molpha/mcp@${version}`]);
    }
  });

  it("fails loudly when a file loses its markers", () => {
    expect(() => applyBlocks("x.md", "no markers here", { prompt: "body" })).toThrow(/missing generated block markers/);
  });

  it("replaces only what is between the markers", () => {
    const text = "before\n<!-- molpha:generated:a -->\nold\n<!-- /molpha:generated:a -->\nafter\n";
    expect(applyBlocks("x.md", text, { a: "new" })).toBe("before\n<!-- molpha:generated:a -->\nnew\n<!-- /molpha:generated:a -->\nafter\n");
  });
});

describe("next release version", () => {
  it.each([
    ["0.1.1", "minor", "0.2.0"],
    ["0.1.2", "patch", "0.1.3"],
    ["0.9.4", "major", "1.0.0"]
  ] as const)("bumps %s by %s to %s", (from, bump, to) => {
    expect(bumpVersion(from, bump)).toBe(to);
  });

  it("reads the bump a changeset asks for this package, and ignores other packages", () => {
    expect(bumpFromChangeset('---\n"@molpha/mcp": minor\n---\n\nText', "@molpha/mcp")).toBe("minor");
    expect(bumpFromChangeset("---\n'@molpha/mcp': patch\n---\n", "@molpha/mcp")).toBe("patch");
    expect(bumpFromChangeset('---\n"@other/pkg": major\n---\n', "@molpha/mcp")).toBeUndefined();
    expect(bumpFromChangeset("no frontmatter", "@molpha/mcp")).toBeUndefined();
  });

  it("takes the highest pending bump on top of package.json's version", () => {
    const current = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
    expect([bumpVersion(current, "patch"), bumpVersion(current, "minor"), bumpVersion(current, "major"), current]).toContain(nextVersion(ROOT, "@molpha/mcp"));
  });
});
