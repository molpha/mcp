import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createHostedHttpServer, loadHttpConfig } from "../../src/http/server.js";

// Explicit opt-in only. No local .env or signer files are loaded by this test, and it holds no key:
// it goes as far as the hosted server can without a wallet, which is the unsigned transaction.
it.runIf(process.env.MOLPHA_HTTP_DEVNET_TEST === "true")("hosted devnet discovery and x402 preparation", async () => {
  const app = createHostedHttpServer({ config: { ...loadHttpConfig(), port: 0 }, log: () => {} });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
  const call = async (name: string, args: unknown) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const body = await response.json() as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } };
    // Never include response or upstream detail in a failing assertion.
    expect(response.ok && body.result?.isError !== true && Boolean(body.result?.structuredContent)).toBe(true);
    return body.result!.structuredContent!;
  };
  try {
    const caps = await call("get_capabilities", {});
    expect(typeof caps.registryVersion === "number").toBe(true);
    expect((caps.payment as { signing?: string }).signing).toBe("caller");
    const payer = process.env.MOLPHA_HTTP_TEST_PAYER;
    if (payer) {
      const apiConfigText = process.env.MOLPHA_HTTP_TEST_API_CONFIG;
      if (!apiConfigText) throw new Error("Set MOLPHA_HTTP_TEST_API_CONFIG to a deterministic public API config JSON.");
      const signaturesRequired = Number(process.env.MOLPHA_HTTP_TEST_QUORUM ?? 2);
      expect(typeof (await call("get_x402_status", { signaturesRequired, payer })).payer === "string").toBe(true);
      // Needs MOLPHA_HTTP_CHALLENGE_SECRET. Verifies the gateway's live 402 against chain and stops
      // at the unsigned transaction: nothing is signed, paid or broadcast.
      const prepared = await call("prepare_x402_round", { apiConfig: JSON.parse(apiConfigText), chains: ["solana"], signaturesRequired, payer });
      expect(typeof prepared.unsignedTransaction === "string" && typeof prepared.challenge === "string").toBe(true);
    }
  } finally { await app.close(); }
}, 180_000);
