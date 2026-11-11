import type { ToolDependencies } from "../clients.js";
import { z } from "zod";
import { checkSourceDeterminism } from "../determinism.js";
import { toolHandler } from "../mcp.js";
import { describeSourceId, parseSource } from "../source.js";
import { sourceSchema } from "./schemas.js";
import { type ToolServer } from "./types.js";

const outputSchema = z.object({
  sourceId: z.string().describe("32-byte sourceId, 0x-prefixed hex: keccak256 of canonicalJson."),
  canonicalSource: z
    .record(z.unknown())
    .describe("The canonical source document: every key present, keys sorted, every number a string. Pass it, or your own equivalent, as `source`."),
  canonicalJson: z.string().describe("The exact UTF-8 preimage hashed into sourceId (and what nodes receive)."),
  output: z
    .object({
      type: z.string().describe("int256, uint256, bool, bytes32, string32 or keccak256."),
      decimals: z.number().int().describe("The scale of an int256/uint256 output (value / 10^decimals); 0 for the other types.")
    })
    .describe("The source's declared output: how the transform result becomes the 32 signed bytes. Committed by the sourceId."),
  determinismWarnings: z.array(z.string()).optional(),
  note: z.string()
});

export function registerDeriveSourceIdTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "derive_source_id",
    {
      title: "Derive Molpha sourceId",
      description:
        "Validate a source document and derive its sourceId locally: no transaction, no wallet, no subscription, no network. " +
        "A source is {v:\"1\", inputs, transform, assert, output, aggregation}: 1-4 named inputs (http, evm, starknet or svm), each a read plus an explicit decoder; one transform, a JSON AST over exact decimals; up to 8 assertions; a declared output (int256, uint256, bool, bytes32, string32 or keccak256, with decimals for the numeric ones); and aggregation null (exact mode) or median tolerance. " +
        "sourceId = keccak256(canonicalJson), with no domain tag. The canonical form is a subset of RFC 8785 (JCS): UTF-8, object keys sorted by byte order, no whitespace, arrays in order, strings escaped as ECMAScript JSON.stringify does, and NO JSON numbers anywhere: every numeric quantity is a string in a fixed grammar (\"8\", \"0.5\", \"-1\"), written exactly (no leading zeros, no trailing fractional zeros, no \"+\"). " +
        "Every key must be present: an absent optional is null, and a missing, unknown or mistyped key is rejected with its path. Key order and whitespace in what you send are free (they are re-sorted), but a differing byte in the canonical form, such as a different spelling of one quantity, is a different sourceId, so call this tool instead of hashing client-side. The gateway re-derives the same ID from the document, and nodes require the canonical bytes. " +
        "sourceId depends on the source alone, not on signaturesRequired or the signer, and identifies the source on Solana, EVM and Starknet. Only nodes evaluate a source: this tool parses, validates, canonicalizes and hashes; it fetches nothing and evaluates nothing. " +
        "A rejected source returns an invalid_source error whose details.path names the offending field. " +
        "Worked example, a JSON price feed (output int256 scaled to 8 decimals): " +
        "{\"v\":\"1\",\"inputs\":{\"px\":{\"kind\":\"http\",\"read\":{\"method\":\"GET\",\"url\":\"https://example.com\",\"headers\":{},\"body\":null},\"decode\":{\"format\":\"json\",\"fields\":{\"price\":{\"path\":\"$.price\"}}}}},\"transform\":{\"op\":\"rescale\",\"args\":[{\"ref\":\"px.price\"}],\"scale\":\"8\",\"round\":\"halfEven\"},\"assert\":[],\"output\":{\"type\":\"int256\",\"decimals\":\"8\"},\"aggregation\":null}. " +
        "For a JSON string value such as \"65000.12\", wrap the ref in {op:\"num\",args:[{ref:\"px.price\"}],mode:\"dec\"}. " +
        "Exact mode (aggregation null) needs independent nodes to produce byte-identical 32 bytes to co-sign, so prefer settled data: an EVM or Starknet read is pinned to a block derived from the round's timestamp, so every node reads the same state, while a live-drifting http price or an svm account written every slot will not converge. " +
        "For those, set aggregation {mode:\"tolerance\",rule:\"median\",maxDeviationBps:\"50\",maxAgeMs:\"2000\"} (all strings): it is part of the sourceId, needs output.type int256 and signaturesRequired >= 3, and the signed value is the median of the nodes' final outputs, scaled by output.decimals. " +
        "A secret may stand as {{secret.NAME}} in an http input's URL after the host, a header value or body.text; the placeholder is hashed, and the value is supplied at execution as encryptSecrets. A paid (x402) source, a source payment or a provider credential needs exactly one http input. " +
        "Heuristic determinismWarnings flag likely non-converging reads in exact mode (a live-drifting http URL, an svm account read); rejectNonDeterministic turns them into an error.",
      inputSchema: {
        source: sourceSchema,
        rejectNonDeterministic: z.boolean().optional()
      },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    toolHandler(outputSchema, async (
      {
        source,
        rejectNonDeterministic = false
      }: {
        source: z.infer<typeof sourceSchema>;
        rejectNonDeterministic?: boolean;
      }
    ) => {
      // Validation is the SDK's: the same rules as the gateway and the nodes. A rejection carries its path.
      const parsed = parseSource(source);
      const determinism = await checkSourceDeterminism(parsed);

      if (rejectNonDeterministic && determinism.warnings.length > 0) {
        throw new Error(`Source failed the determinism check (rejectNonDeterministic): ${determinism.warnings.join("; ")}`);
      }

      const { sourceId, canonicalSource, canonicalJson, output } = describeSourceId(parsed);

      return {
        sourceId,
        canonicalSource,
        canonicalJson,
        output,
        determinismWarnings: determinism.warnings.length > 0 ? determinism.warnings : undefined,
        note:
          "No transaction was sent and nothing was fetched. A Solana feed account for (sourceId, signaturesRequired, submitter) is created by that submitter's first submit_attestation."
      };
    })
  );
}
