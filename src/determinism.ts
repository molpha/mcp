/** Heuristic guard for API configs that may not converge across independent nodes. */

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

export function checkApiConfigDeterminism(apiConfig: Record<string, unknown>): DeterminismCheck {
  const warnings: string[] = [];
  const url = typeof apiConfig.url === "string" ? apiConfig.url : "";

  if (!url) {
    return { ok: false, warnings: ["apiConfig.url is required"] };
  }

  // Median tolerance mode is the supported way to attest a live-drifting source.
  const tolerance = apiConfig.aggregation !== undefined && apiConfig.aggregation !== null;

  for (const pattern of tolerance ? [] : LIVE_DRIFTING_PATTERNS) {
    if (pattern.test(url)) {
      warnings.push(
        `URL "${url}" may return live-drifting data. Independent nodes must converge on a byte-identical value to co-sign. Prefer settled/finalized sources.`
      );
    }
  }

  const method = typeof apiConfig.method === "string" ? apiConfig.method.toUpperCase() : "GET";
  if (method !== "GET" && method !== "POST") {
    warnings.push(`method "${method}" is unusual; prefer GET for public deterministic APIs`);
  }

  if (!apiConfig.responseParser) {
    return { ok: false, warnings: [...warnings, "apiConfig.responseParser is required"] };
  }

  return { ok: warnings.length === 0, warnings };
}
