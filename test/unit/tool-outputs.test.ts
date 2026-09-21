/**
 * Every tool's real output, checked against the outputSchema it advertises
 * (callTool fails on any mismatch), with the chain and gateway faked.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMolphaContext, type MolphaContext } from "../../src/clients.js";
import { loadConfig } from "../../src/config.js";
import { resetGuardrailCounters } from "../../src/guardrails.js";
import { callTool } from "./tool-harness.js";

vi.mock("../../src/clients.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/clients.js")>()),
  getMolphaContext: vi.fn()
}));

const signer = Keypair.generate().publicKey.toBase58();
const feedPda = Keypair.generate().publicKey.toBase58();
const apiConfig = { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate", valueTransform: "mul(1e8)" };

const flatResult = {
  sourceId: "1".repeat(64),
  value: "66285",
  valuePacked: "2".repeat(64),
  timestamp: 1714300000,
  registryVersion: 7,
  signaturesRequired: 1,
  signersBitmap: "4",
  s: "3".repeat(64),
  commitmentAddr: "4".repeat(40),
  fresh: true
};

/** A feed account as the SDK's Anchor decoder returns it. */
const feedAccount = {
  sourceId: Array(32).fill(0x11),
  value: new Uint8Array(32).fill(0x22),
  valueKind: { value: {} },
  canonicalTimestamp: new BN(1714300000),
  signaturesRequired: 1,
  signersBitmap: [...Array(31).fill(0), 4],
  registryVersion: 7,
  bump: 254
};

function fakeContext() {
  const solana = {
    getRegistryVersion: vi.fn(async () => 7),
    readFeed: vi.fn(async (): Promise<unknown> => feedAccount),
    readSubscription: vi.fn(async () => ({
      owner: new PublicKey(signer),
      planType: { basic: {} },
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600),
      usedRounds: 2n,
      maxRounds: 100n
    })),
    submitAttestation: vi.fn(async () => ({ signature: "5".repeat(88), feed: new PublicKey(feedPda) }))
  };
  const gateway = {
    getNodes: vi.fn(async (): Promise<unknown> => [
      { index: 0, peerId: "12D3KooW", address: "0x1234", signingKey: "02ab" }
    ]),
    requestSignedData: vi.fn(async () => flatResult)
  };
  const context = {
    config: loadConfig({ GATEWAY_ENDPOINTS: "http://gateway.test", SOLANA_RPC: "http://solana.test" }),
    solana,
    gateway,
    signer: { publicKey: signer }
  };
  vi.mocked(getMolphaContext).mockResolvedValue(context as unknown as MolphaContext);
  return { solana, gateway };
}

beforeEach(() => {
  resetGuardrailCounters();
});

describe("get_capabilities", () => {
  it("matches its outputSchema, with the node set or the read that failed", async () => {
    const { gateway } = fakeContext();

    expect(await callTool("get_capabilities", { includeAbi: true })).toMatchObject({
      registryVersion: 7,
      nodeCount: 1,
      payment: { subscription: "execute_subscription_round", x402: "execute_x402_round" }
    });

    gateway.getNodes.mockRejectedValueOnce(new Error("gateway down"));
    expect(await callTool("get_capabilities", {})).toMatchObject({
      nodeCount: 0,
      nodes: { ok: false, label: "gateway.getNodes", error: { message: "gateway down" } }
    });
  });
});

describe("feed reads", () => {
  it("get_latest_value presents the feed account, or null before the first submit", async () => {
    const { solana } = fakeContext();

    expect(await callTool("get_latest_value", { sourceId: flatResult.sourceId, signaturesRequired: 1 })).toMatchObject({
      submitter: signer,
      feed: { sourceId: `0x${"11".repeat(32)}`, valueKind: "value", canonicalTimestamp: "1714300000" }
    });

    solana.readFeed.mockResolvedValueOnce(null);
    expect(await callTool("get_latest_value", { sourceId: flatResult.sourceId, signaturesRequired: 1 })).toMatchObject({
      feed: null
    });
  });

  it("describe_feed reports the feed, the unattested value encoding, and the subscription", async () => {
    const { solana } = fakeContext();

    expect(await callTool("describe_feed", { apiConfig, signaturesRequired: 1 })).toMatchObject({
      feed: { valueKind: "value" },
      valueEncoding: { attested: false, valueTransform: "mul(1e8)" },
      subscription: { active: true, usedRounds: 2, maxRounds: 100 }
    });

    solana.readFeed.mockRejectedValueOnce(new Error("rpc down"));
    expect(await callTool("describe_feed", { sourceId: flatResult.sourceId, signaturesRequired: 1 })).toMatchObject({
      feed: { ok: false, label: "solana.readFeed" }
    });
  });
});

describe("execute_subscription_round", () => {
  const args = { apiConfig, chains: ["evm", "starknet", "solana"] };

  it("previews without requesting a round", async () => {
    const { gateway } = fakeContext();

    expect(await callTool("execute_subscription_round", { ...args, dryRun: true, autoSubmit: true })).toMatchObject({
      dryRun: true,
      action: "execute_subscription_round",
      payment: "subscription",
      signaturesRequired: 1
    });
    expect(gateway.requestSignedData).not.toHaveBeenCalled();
  });

  it("returns the canonical artifact, verifier args, and the autoSubmit outcome", async () => {
    const { solana } = fakeContext();

    const out = await callTool("execute_subscription_round", { ...args, autoSubmit: true });

    expect(out).toMatchObject({
      payment: "subscription",
      value: "66285",
      dataUpdate: { sourceId: `0x${flatResult.sourceId}`, valuePacked: `0x${flatResult.valuePacked}` },
      signature: { signersBitmap: `0x${"0".repeat(63)}4` },
      verifierArgs: { evm: {}, starknet: {} },
      submitted: { chain: "solana", action: "submit_attestation", submitter: signer, feed: feedPda }
    });
    expect(solana.submitAttestation).toHaveBeenCalledOnce();
  });

  it("keeps the artifact when autoSubmit fails", async () => {
    const { solana } = fakeContext();
    solana.submitAttestation.mockRejectedValueOnce(new Error("FeedNotNewer"));

    const out = await callTool("execute_subscription_round", { ...args, autoSubmit: true });

    expect(out.dataUpdate).toBeDefined();
    expect(out.submitted).toMatchObject({ ok: false, message: "FeedNotNewer", retry: expect.any(String) });
  });
});

describe("a round's output, passed on verbatim", () => {
  it("is accepted by submit_attestation and build_verifier_calldata", async () => {
    const { solana } = fakeContext();
    const round = await callTool("execute_subscription_round", { apiConfig, chains: ["solana"] });

    expect(await callTool("submit_attestation", { result: round, dryRun: true })).toMatchObject({
      dryRun: true,
      action: "submit_attestation",
      summary: { chain: "solana", sourceId: `0x${flatResult.sourceId}`, registryVersion: 7, submitter: signer }
    });
    expect(solana.submitAttestation).not.toHaveBeenCalled();

    expect(await callTool("submit_attestation", { result: round })).toEqual({
      chain: "solana",
      action: "submit_attestation",
      sourceId: `0x${flatResult.sourceId}`,
      signaturesRequired: 1,
      submitter: signer,
      feed: feedPda,
      signature: "5".repeat(88)
    });

    expect(
      await callTool("build_verifier_calldata", { dataUpdate: round.dataUpdate, signature: round.signature, chain: "evm" })
    ).toMatchObject({ verifierArgs: { evm: { args: {} } } });
  });
});
