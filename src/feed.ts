/**
 * Feed-account presentation helpers.
 *
 * Anchor encodes the on-chain `FeedValueKind` enum as a single-key variant
 * object — `{ value: {} }` / `{ hash: {} }` — which reads like an empty stub in
 * tool output. Flatten it to a string and say what it means.
 */

import { formatSourceValue, type SourceOutput } from "./source.js";

export type FeedValueKind = "value" | "hash";

const VALUE_KIND_MEANING: Record<FeedValueKind, string> = {
  value: "`value` holds the raw oracle payload (<= 32 bytes), stored verbatim on-chain.",
  hash: "`value` is the keccak256 of a raw payload (a keccak256 output): the preimage travelled in the submitting instruction, was checked against `value` there, and is not stored in the feed account."
};

/** Byte fields Anchor decodes as `number[]`; shown as `0x` hex so they compare against tool output. */
const BYTE_FIELDS = ["sourceId", "value", "signersBitmap"] as const;

export function decodeFeedValueKind(feed: Record<string, unknown> | null | undefined): FeedValueKind | null {
  const raw = feed?.valueKind ?? (feed as Record<string, unknown> | undefined)?.value_kind;
  if (typeof raw === "string") {
    const lowered = raw.toLowerCase();
    return lowered === "value" || lowered === "hash" ? lowered : null;
  }

  if (raw && typeof raw === "object") {
    const key = Object.keys(raw as Record<string, unknown>)[0]?.toLowerCase();
    return key === "value" || key === "hash" ? key : null;
  }

  return null;
}

/** Feed account with byte fields as hex and `valueKind` flattened to a string and explained. */
export function presentFeed(
  feed: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!feed) {
    return null;
  }

  const out: Record<string, unknown> = { ...feed };
  for (const field of BYTE_FIELDS) {
    const bytes = asByteArray(feed[field]);
    if (bytes) {
      out[field] = `0x${Buffer.from(bytes).toString("hex")}`;
    }
  }

  const kind = decodeFeedValueKind(feed);
  if (!kind) {
    return out;
  }

  return {
    ...out,
    valueKind: kind,
    valueKindMeaning: VALUE_KIND_MEANING[kind]
  };
}

/**
 * What the stored 32 bytes mean, from the source's declared `output`.
 *
 * The scale is attested. `output` (type and decimals) is part of the source, the source is hashed into the
 * sourceId, and every signature commits to the sourceId, so a feed's `output.decimals` cannot be changed
 * without changing which feed it is. A feed account holds no decimals field of its own (`FeedValueKind` is
 * only `value | hash`), so the scale is known only to a reader who has the source: pass it, or derive the
 * sourceId from it and check that it matches the feed's.
 */
export function describeValueEncoding(output: SourceOutput): Record<string, unknown> {
  const numeric = output.type === "int256" || output.type === "uint256";
  return {
    attested: true,
    source: "source.output (committed by the sourceId, which every signature covers)",
    encoding: output.type,
    ...(numeric ? { decimals: output.decimals } : {}),
    note: OUTPUT_NOTES[output.type](output.decimals)
  };
}

const OUTPUT_NOTES: Record<SourceOutput["type"], (decimals: number) => string> = {
  int256: (d) =>
    `The stored 32 bytes are a signed int256 (two's complement): the transform's result rescaled half-even to ${d} fractional digit${d === 1 ? "" : "s"}. The number is the integer divided by 10^${d}.`,
  uint256: (d) =>
    `The stored 32 bytes are an unsigned uint256: the transform's result rescaled half-even to ${d} fractional digit${d === 1 ? "" : "s"}. The number is the integer divided by 10^${d}.`,
  bool: () => "The stored 32 bytes are 0x00..00 (false) or 0x00..01 (true).",
  bytes32: () => "The stored 32 bytes are the transform's bytes, left-padded with zeros.",
  string32: () => "The stored 32 bytes are the transform's string as UTF-8, right-padded with zeros (at most 32 bytes).",
  keccak256: () =>
    "The stored 32 bytes are the keccak256 of the transform's bytes or string. The preimage is not signed and not stored in the feed: a round returns it as `valuePreimage` (keep it), and submit_attestation passes it to the program, which checks it against the value."
};

/** Renders a feed's stored `0x` hex value as its source's output declares; undefined if it is not 32 bytes. */
export function decodeFeedValue(valueHex: unknown, output: SourceOutput): string | undefined {
  return formatSourceValue(valueHex, output);
}

function asByteArray(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Uint8Array.from(value as number[]);
  }

  return undefined;
}
