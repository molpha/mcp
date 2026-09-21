import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createHostedHttpServer, loadHttpConfig } from "../../src/http/server.js";

// Explicit opt-in only. No local .env or signer files are loaded by this test.
it.runIf(process.env.MOLPHA_HTTP_DEVNET_TEST === "true")("hosted devnet unsigned discovery and managed-signer execution", async () => {
  const app = createHostedHttpServer({ config: { ...loadHttpConfig(), port: 0 }, log: () => {} });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
  const call = async (name: string, args: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const body = await response.json() as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } };
    // Never include response/provider/header detail in a failing assertion.
    expect(response.ok && body.result?.isError !== true && Boolean(body.result?.structuredContent)).toBe(true);
    return body.result!.structuredContent!;
  };
  try {
    const caps = await call("get_capabilities", {});
    expect(typeof caps.registryVersion === "number").toBe(true);
    const apiConfigText = process.env.MOLPHA_HTTP_TEST_API_CONFIG;
    if (!apiConfigText) throw new Error("Set MOLPHA_HTTP_TEST_API_CONFIG to a deterministic public API config JSON.");
    const args = { apiConfig: JSON.parse(apiConfigText), chains: ["solana"], signaturesRequired: Number(process.env.MOLPHA_HTTP_TEST_QUORUM ?? 2) };
    expect((await call("execute_x402_round", args)).quoteOnly === true).toBe(true);
    if (process.env.MOLPHA_HTTP_DEVNET_PAID_TEST === "true") {
      const headersText = process.env.MOLPHA_HTTP_TEST_HEADERS;
      if (!headersText) throw new Error("Set MOLPHA_HTTP_TEST_HEADERS to the managed-signer header JSON for a funded devnet wallet.");
      const result = await call("execute_x402_round", { ...args, dryRun: false }, JSON.parse(headersText));
      expect(Boolean(result.paymentReceipt) && Boolean(result.signature)).toBe(true);
    }
  } finally { await app.close(); }
}, 180_000);
