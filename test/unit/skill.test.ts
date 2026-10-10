import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../scripts/gen-install.js";
import { collectTools } from "./tool-harness.js";

const SKILL_DIR = join(ROOT, "plugins/molpha/skills/molpha");
const read = (relative: string): string => readFileSync(join(SKILL_DIR, relative), "utf8");

/** Every file in the skill, relative to its folder. */
function skillFiles(dir = SKILL_DIR, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? skillFiles(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
  );
}

/** Files that talk about the MCP tools. Their tool names are checked strictly; the chain references quote Rust, Solidity and Cairo identifiers. */
const STRICT = ["SKILL.md", "references/mcp-workflows.md"];

/** Error codes the tools return. They look like tool names but are not. */
const ERROR_CODES = new Set([
  "dry_run_locked", "missing_config", "authentication_required", "submitter_required", "subscription_inactive",
  "source_payment_required", "source_payment_refused", "source_payment_disabled", "payment_outcome_unknown",
  "guardrail_exceeded", "determinism_rejected", "round_conflict", "round_timeout", "invalid_config", "session_invalid",
  "sign_in_rejected", "invalid_challenge", "payment_expired", "transaction_expired"
]);

const RETIRED = /\b(execute_agent_round|get_agent_status|verify_attestation)\b|\bmolpha_(fetch_verified|execute|derive_feed|get_latest|verify|agent_status|describe_feed|get_capabilities)\b|\bfeedId\b/;

const withoutFences = (text: string): string => text.replace(/```[\s\S]*?```/g, "");
const backtickedSnake = (text: string): string[] => [...withoutFences(text).matchAll(/`([a-z]+(?:_[a-z0-9]+)+)`/g)].map((match) => match[1]!);

// Both server shapes: some names exist only locally or only hosted.
const TOOL_NAMES = new Set([...collectTools().map((tool) => tool.name), ...collectTools({ hosted: {} }).map((tool) => tool.name)]);

describe("the Molpha skill", () => {
  it("has the files the plan names", () => {
    for (const file of ["SKILL.md", "references/mcp-workflows.md", "references/apiconfig.md", "references/integrate-solana.md", "references/integrate-evm.md", "references/integrate-starknet.md"]) {
      expect(existsSync(join(SKILL_DIR, file)), file).toBe(true);
    }
  });

  it("has valid frontmatter and stays short enough to load every time", () => {
    const text = read("SKILL.md");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";

    expect(frontmatter).toMatch(/^name: molpha$/m);
    const description = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(text.split("\n").length).toBeLessThanOrEqual(150);
  });

  it.each(STRICT)("%s names only tools that exist (or a known error code)", (file) => {
    const named = backtickedSnake(read(file));

    expect(named.length).toBeGreaterThan(0);
    for (const name of named) {
      expect(TOOL_NAMES.has(name) || ERROR_CODES.has(name), `${file} mentions \`${name}\`, which is neither a registered tool nor a known error code`).toBe(true);
    }
  });

  it("mentions every read tool somewhere, so none is invisible to an agent", () => {
    const text = STRICT.map(read).join("\n");
    for (const tool of collectTools({ readOnly: { reason: "test" } })) expect(text, tool.name).toContain(tool.name);
  });

  it("never uses a retired tool name, a molpha_ tool prefix, or the old feedId", () => {
    for (const file of skillFiles()) expect(read(file), file).not.toMatch(RETIRED);
  });

  it("only links to reference files that exist", () => {
    for (const file of skillFiles()) {
      for (const match of read(file).matchAll(/references\/([a-z-]+\.md)/g)) {
        expect(existsSync(join(SKILL_DIR, "references", match[1]!)), `${file} links to references/${match[1]}`).toBe(true);
      }
    }
  });

  it("never asks for a secret in chat", () => {
    expect(read("SKILL.md")).toMatch(/Never ask for a private key/);
    expect(read("SKILL.md")).toMatch(/dry_run_locked/);
  });
});
