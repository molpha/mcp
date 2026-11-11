import { requireSdkExport } from "../../src/sdk.js";

/** A source for tests: its document, and its sourceId as the SDK derives it. */
export interface TestSource {
  /** The document in full form (every key present, every number a string): what a tool call carries. */
  doc: Record<string, unknown>;
  /** `0x`-prefixed sourceId. */
  sourceId: string;
  /** Bare lowercase hex sourceId, as the gateway and the SDK's request bodies spell it. */
  bareId: string;
  canonical: string;
}

interface SdkParsed {
  doc: Record<string, unknown>;
  idHex: string;
  canonical: string;
}

function wrap(parsed: SdkParsed): TestSource {
  return { doc: parsed.doc, sourceId: parsed.idHex, bareId: parsed.idHex.slice(2), canonical: parsed.canonical };
}

/** The SDK's `jsonPriceSource`: GET `url`, the JSON number at `path`, scaled to `decimals`, as an int256. */
export function priceSource(o: {
  url: string;
  path?: string;
  decimals?: number;
  valueIs?: "number" | "string";
  headers?: Record<string, string>;
  tolerance?: { maxDeviationBps: string; maxAgeMs: string };
}): TestSource {
  const build = requireSdkExport<(o: object) => SdkParsed>("jsonPriceSource");
  return wrap(build({ path: "$.price", decimals: 8, ...o }));
}

/** The SDK's `parseSource`, strict: any key order, every key present. */
export function parseTestSource(doc: object | string): TestSource {
  return wrap(requireSdkExport<(input: object | string) => SdkParsed>("parseSource")(doc));
}

/** The 32-byte two's-complement word of an integer, `0x`-prefixed. */
export function word(n: bigint): string {
  const v = n < 0n ? (1n << 256n) + n : n;
  return `0x${v.toString(16).padStart(64, "0")}`;
}

/**
 * The source whose canonical JSON the Go gateway pins in `TestPaymentMemoGoldenVector`
 * (internal/gateway/features/agentexec/service_test.go) and the node client's vectors, byte for byte:
 * `sourcetest.New("https://example.com")`.
 */
export const GOLDEN_CANONICAL =
  '{"aggregation":null,"assert":[],"inputs":{"px":{"decode":{"fields":{"price":{"path":"$.price"}},"format":"json"},"kind":"http","read":{"body":null,"headers":{},"method":"GET","url":"https://example.com"}}},"output":{"decimals":"8","type":"int256"},"transform":{"args":[{"ref":"px.price"}],"op":"rescale","round":"halfEven","scale":"8"},"v":"1"}';
export const GOLDEN_SOURCE_ID = "0xf8306899c3fc1adcfc93f273c3efd71c56c446494def2f8ea72cdefe2092a81a";

type Sx = {
  httpInput: (o: { url: string; decode: object; headers?: Record<string, string> }) => object;
  jsonDecode: (fields: Record<string, string>) => object;
  abiDecode: (types: string[], fields: Record<string, string>) => object;
  evmCall: (o: { chain: string; to: string; sig: string; args?: string[]; finality: object; decode: object }) => object;
  rescale: (a: object, o: { scale: string | number }) => object;
  add: (a: object, b: object) => object;
  ref: (name: string) => object;
};

/** A source with two http inputs: valid, but a payment names no host, so it cannot be paid. */
export function twoHttpSource(): TestSource {
  const sx = requireSdkExport<Sx>("sx");
  const define = requireSdkExport<(o: object) => SdkParsed>("defineSource");
  return wrap(
    define({
      inputs: {
        a: sx.httpInput({ url: "https://a.example.com/p", decode: sx.jsonDecode({ price: "$.price" }) }),
        b: sx.httpInput({ url: "https://b.example.com/p", decode: sx.jsonDecode({ price: "$.price" }) })
      },
      transform: sx.rescale(sx.add(sx.ref("a.price"), sx.ref("b.price")), { scale: 8 }),
      output: { type: "int256", decimals: 8 }
    })
  );
}

/** One http input and one pinned EVM read: exact mode, and payable (the payment attaches to the one http input). */
export function httpAndEvmSource(url = "https://a.example.com/p"): TestSource {
  const sx = requireSdkExport<Sx>("sx");
  const define = requireSdkExport<(o: object) => SdkParsed>("defineSource");
  return wrap(
    define({
      inputs: {
        px: sx.httpInput({ url, decode: sx.jsonDecode({ price: "$.price" }) }),
        rate: sx.evmCall({
          chain: "eip155:1",
          to: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
          sig: "stEthPerToken()",
          finality: { mode: "finalized", lagMs: 900_000 },
          decode: sx.abiDecode(["uint256"], { rate: "0" })
        })
      },
      transform: sx.rescale(sx.ref("px.price"), { scale: 8 }),
      output: { type: "int256", decimals: 8 }
    })
  );
}
