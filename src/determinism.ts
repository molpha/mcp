/**
 * Heuristic guard for sources that may not converge across independent nodes.
 *
 * In exact mode every signer must produce the same 32 bytes, so a source that drifts between two nodes'
 * reads cannot be signed. Median tolerance mode is the supported way to attest such a source, and these
 * checks stay quiet for it. They are advisory: they catch the common mistake, and prove nothing.
 */
import { httpInputs, type ParsedSourceLike } from "./source.js";
import { requireSdkExport } from "./sdk.js";

const LIVE_DRIFTING_PATTERNS = [
  /\/ticker\b/i,
  /\/price\b/i,
  /\/latest\b/i,
  /\/stream\b/i,
  /\/realtime\b/i,
  /\/websocket\b/i,
  /\/ws\b/i,
  /\/live\b/i
];

export interface DeterminismCheck {
  ok: boolean;
  warnings: string[];
}

interface LintFinding {
  severity: "error" | "warning";
  input: string;
  message: string;
}

/**
 * Warnings for a validated source, in exact mode only:
 *  - an http input whose URL looks live-drifting;
 *  - an svm account read (the SDK's `lintSource`): nodes land on slots a few hundred ms apart, so the
 *    account must change slowly for every node to decode the same bytes.
 * EVM and Starknet reads are pinned to a block derived from the round's timestamp, which every node
 * reads identically, so they need no warning.
 */
export async function checkSourceDeterminism(source: ParsedSourceLike): Promise<DeterminismCheck> {
  const warnings: string[] = [];

  // Median tolerance mode is the supported way to attest a live-drifting source.
  if (!source.tolerance) {
    for (const { name, read } of httpInputs(source)) {
      for (const pattern of LIVE_DRIFTING_PATTERNS) {
        if (pattern.test(read.url)) {
          warnings.push(
            `Input "${name}": URL "${read.url}" may return live-drifting data. Independent nodes must converge on a byte-identical value to co-sign. Prefer settled/finalized sources, or use tolerance aggregation (signaturesRequired >= 3, output int256).`
          );
        }
      }
    }

    const lint = requireSdkExport<(src: ParsedSourceLike) => Promise<LintFinding[]>>("lintSource");
    for (const finding of await lint(source)) {
      warnings.push(`Input "${finding.input}": ${finding.message}`);
    }
  }

  return { ok: warnings.length === 0, warnings };
}
