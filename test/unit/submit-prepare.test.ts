import { BN, BorshAccountsCoder, type Idl } from "@anchor-lang/core";
import { address, getBase58Decoder, type Address } from "@solana/kit";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadChallengeKeys } from "../../src/challenge.js";
import { getMolphaProgramId, type MolphaContext, type ToolDependencies } from "../../src/clients.js";
import { type MolphaConfig } from "../../src/config.js";
import { resetGuardrailCounters } from "../../src/guardrails.js";
import { requireSdkExport } from "../../src/sdk.js";
import { prepareSubmit, sendPreparedSubmit, submitTiming, type SubmitContext } from "../../src/submit-prepare.js";
import { prepareSignedResult } from "../../src/submit.js";
import { callTool, callToolError, collectTools } from "./tool-harness.js";

const programId = getMolphaProgramId();
const idl = requireSdkExport<Idl>("MOLPHA_IDL");
const coder = new BorshAccountsCoder(idl);
const bs58 = { encode: (bytes: Uint8Array): string => getBase58Decoder().decode(bytes) };
const pda = (name: string, ...args: unknown[]): string => String(requireSdkExport<(...a: unknown[]) => unknown>(name)(...args));
const randomAddress = (): Address => address(Keypair.generate().publicKey.toBase58());
const hex = (value: string): number[] => [...Buffer.from(value, "hex")];
// secp256k1 G and 2G: two valid node keys whose sum is a point on the curve.
const NODE_KEYS = [
  ["79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798", "483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8"],
  ["C6047F9441ED7D6D3045406E95C07CD85C778E4B8CEF3CA7ABAC09B95C709EE5", "1AE168FEA63DC339A3C58419466CEAEEF7F632653266D0E1236431A950CFE52A"]
] as const;
const sourceId = "11".repeat(32);
// Nodes 0 and 1 signed; quorum 2 of a 3-node registry with one node of redundancy.
const flatResult = {
  sourceId, value: "42", valuePacked: "00".repeat(31) + "2a", timestamp: 1_791_374_400_000, registryVersion: 3,
  signaturesRequired: 2, signersBitmap: "3", s: "22".repeat(32), commitmentAddr: "33".repeat(20), fresh: true
};

interface Rpc {
  ctx: SubmitContext;
  calls: Array<{ method: string; params: unknown[] }>;
  sent: string[];
  blockHeight: number;
  status: (signature: string) => Record<string, unknown> | null;
  nodes: Address[];
}

/** A Solana JSON-RPC node holding one registry and its node accounts, behind a real Connection. */
async function rpc(): Promise<Rpc> {
  const nodes = [randomAddress(), randomAddress(), randomAddress()];
  const accounts = new Map<string, Buffer>();
  // Registry holds 256 node slots, more than the coder's encode buffer: lay it out by hand.
  // discriminator | version u32 | node_count u16 | redundancy_buffer u8 | bump u8 | nodes [[u8;32];256] | i64 | i64
  const registry = Buffer.alloc(8 + 4 + 2 + 1 + 1 + 256 * 32 + 8 + 8);
  Buffer.from(idl.accounts!.find((entry) => entry.name === "Registry")!.discriminator).copy(registry, 0);
  registry.writeUInt32LE(3, 8);
  registry.writeUInt16LE(nodes.length, 12);
  registry.writeUInt8(1, 14);
  registry.writeUInt8(255, 15);
  nodes.forEach((node, i) => Buffer.from(new PublicKey(node).toBytes()).copy(registry, 16 + i * 32));
  accounts.set(pda("registryPda", 3, programId), registry);
  for (const [i, node] of nodes.entries()) {
    const [x, y] = NODE_KEYS[i % 2]!;
    accounts.set(node, await coder.encode("Node", {
      authority: new PublicKey(randomAddress()), secp256k1_pubkey_x: hex(x), secp256k1_pubkey_y: hex(y), status: { Active: {} },
      ip: [127, 0, 0, 1], port: 9000, locked_amount: new BN(1), claimable_rewards: new BN(0), registered_at: new BN(1),
      withdrawable_slot: new BN(0), frozen_until: new BN(0), bump: 255
    }));
  }
  const account = (key: string) => {
    const data = accounts.get(key);
    return data ? { data: [data.toString("base64"), "base64"], executable: false, lamports: 1_000_000, owner: programId, rentEpoch: 0, space: data.length } : null;
  };

  const state: Rpc = { calls: [], sent: [], blockHeight: 40, status: () => ({ slot: 5, confirmations: 1, err: null, confirmationStatus: "confirmed" }), nodes } as unknown as Rpc;
  const answer = (method: string, params: unknown[]): unknown => {
    const context = { slot: 5 };
    switch (method) {
      case "getAccountInfo": return { context, value: account(String(params[0])) };
      case "getMultipleAccounts": return { context, value: (params[0] as string[]).map(account) };
      case "getLatestBlockhash": return { context, value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 } };
      case "getBlockHeight": return state.blockHeight;
      case "sendTransaction": {
        const tx = VersionedTransaction.deserialize(Buffer.from(String(params[0]), "base64"));
        state.sent.push(String(params[0]));
        return bs58.encode(tx.signatures[0]!);
      }
      case "getSignatureStatuses": return { context, value: (params[0] as string[]).map(state.status) };
      default: throw new Error(`unexpected RPC method ${method}`);
    }
  };
  const fetchImpl = async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    const one = (req: { id: unknown; method: string; params?: unknown[] }) => {
      state.calls.push({ method: req.method, params: req.params ?? [] });
      return { jsonrpc: "2.0", id: req.id, result: answer(req.method, req.params ?? []) };
    };
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  const config = {
    gatewayEndpoints: ["https://gateway.test"], gatewayAuthorities: [undefined], solanaRpc: "http://solana.test", ownerKeypair: undefined,
    evmNetworks: [], starknetNetworks: [], guardrails: { maxExecutesPerDay: 100, dryRunDefault: false, dailyCapsEnabled: false },
    x402: { maxPriceUsdcAtomic: 1n, maxSpendPerDayUsdcAtomic: 1n }
  } as MolphaConfig;
  state.ctx = { config, connection: new Connection("http://solana.test", { commitment: "confirmed", fetch: fetchImpl as unknown as typeof fetch }) };
  return state;
}

beforeEach(() => {
  resetGuardrailCounters();
  submitTiming.pollMs = 0;
});
afterEach(() => {
  submitTiming.pollMs = 1_000;
  submitTiming.timeoutMs = 60_000;
});

describe("prepareSubmit", () => {
  it("returns the SDK's own submit_attestation transaction, unsigned, for the payer", async () => {
    const node = await rpc();
    const payer = Keypair.generate();
    const payerAddress = address(payer.publicKey.toBase58());

    const { prepared, transaction } = await prepareSubmit(node.ctx, prepareSignedResult(flatResult), payerAddress);

    // Nothing was signed or sent: the SDK was stopped where it would have asked the wallet to sign.
    expect(node.calls.map((call) => call.method)).not.toContain("sendTransaction");
    expect(transaction.signatures).toHaveLength(1);
    expect(transaction.signatures[0]!.every((byte) => byte === 0)).toBe(true);
    expect(transaction.message.header.numRequiredSignatures).toBe(1);

    const keys = transaction.message.staticAccountKeys.map((key) => key.toBase58());
    expect(keys[0]).toBe(payerAddress);
    const feed = pda("feedPda", Buffer.from(sourceId, "hex"), 2, payer.publicKey, programId);
    expect(prepared).toMatchObject({ payer: payerAddress, feed, sourceId: `0x${sourceId}`, signaturesRequired: 2, registryVersion: 3, lastValidBlockHeight: 100 });

    // One program instruction, on the accounts the program's submit_attestation takes, with the
    // two signing nodes' accounts after them in bitmap order.
    const submit = transaction.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex] === programId);
    expect(submit).toHaveLength(1);
    const ixAccounts = submit[0]!.accountKeyIndexes.map((index) => keys[index]);
    expect(ixAccounts.slice(0, 5)).toEqual([
      payerAddress, pda("registryPda", 3, programId), feed, pda("protocolConfigPda", programId), "11111111111111111111111111111111"
    ]);
    expect(ixAccounts.slice(5)).toEqual([node.nodes[0], node.nodes[1]]);
    expect(Buffer.from(submit[0]!.data).includes(Buffer.from(sourceId, "hex"))).toBe(true);
    // Everything else in the transaction is the compute budget program: no transfer rides along.
    const others = transaction.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex] !== programId).map((ix) => keys[ix.programIdIndex]);
    expect(new Set(others)).toEqual(new Set(["ComputeBudget111111111111111111111111111111"]));
  });

  it("refuses a signer set the program would reject, before anyone signs", async () => {
    const node = await rpc();
    const oneSigner = prepareSignedResult({ ...flatResult, signersBitmap: "1" });
    await expect(prepareSubmit(node.ctx, oneSigner, randomAddress())).rejects.toThrow(/QuorumBelowThreshold/);
  });
});

describe("sendPreparedSubmit", () => {
  async function prepared(node: Rpc) {
    const payer = Keypair.generate();
    const built = await prepareSubmit(node.ctx, prepareSignedResult(flatResult), address(payer.publicKey.toBase58()));
    // What crosses the wire to the caller and back.
    const transaction = VersionedTransaction.deserialize(built.transaction.serialize());
    return { payer, prepared: JSON.parse(JSON.stringify(built.prepared)) as typeof built.prepared, transaction };
  }

  it("sends the prepared transaction once its payer has signed it, and waits for it to confirm", async () => {
    const node = await rpc();
    const { payer, prepared: plan, transaction } = await prepared(node);
    transaction.sign([payer]);
    let polls = 0;
    node.status = () => (++polls < 3 ? null : { slot: 6, confirmations: 1, err: null, confirmationStatus: "confirmed" });

    const outcome = await sendPreparedSubmit(node.ctx, plan, transaction);

    expect(outcome).toEqual({
      chain: "solana", action: "submit_attestation", sourceId: `0x${sourceId}`, signaturesRequired: 2,
      submitter: plan.payer, feed: plan.feed, signature: bs58.encode(transaction.signatures[0]!)
    });
    expect(node.sent).toEqual([Buffer.from(transaction.serialize()).toString("base64")]);
    expect(polls).toBe(3);
  });

  it.each<[string, (payer: Keypair, tx: VersionedTransaction, node: Rpc) => Promise<VersionedTransaction> | VersionedTransaction, RegExp]>([
    ["an unsigned transaction", (_payer, tx) => tx, /not signed by its payer/],
    ["a transaction signed by another key", (_payer, tx) => { tx.signatures[0] = Keypair.generate().secretKey.slice(0, 64); return tx; }, /not signed by its payer/],
    [
      "a different transaction signed by the same payer",
      async (payer, _tx, node) => {
        const other = (await prepareSubmit(node.ctx, prepareSignedResult(flatResult), address(payer.publicKey.toBase58()))).transaction;
        other.sign([payer]);
        return other;
      },
      /not the one that was prepared/
    ]
  ])("is not a relay: it sends nothing for %s", async (_label, forge, error) => {
    const node = await rpc();
    const { payer, prepared: plan, transaction } = await prepared(node);

    const failure = await sendPreparedSubmit(node.ctx, plan, await forge(payer, transaction, node)).catch((caught: unknown) => caught);

    expect(failure).toMatchObject({ code: "signed_transaction_mismatch" });
    expect((failure as Error).message).toMatch(error);
    expect(node.sent).toHaveLength(0);
  });

  it("refuses a transaction whose blockhash has expired, and reports one that fails or never lands", async () => {
    const node = await rpc();
    const { payer, prepared: plan, transaction } = await prepared(node);
    transaction.sign([payer]);

    node.blockHeight = 101;
    await expect(sendPreparedSubmit(node.ctx, plan, transaction)).rejects.toMatchObject({ code: "transaction_expired" });
    expect(node.sent).toHaveLength(0);

    node.blockHeight = 40;
    node.status = () => ({ slot: 6, confirmations: 0, err: { InstructionError: [1, { Custom: 6001 }] }, confirmationStatus: "processed" });
    await expect(sendPreparedSubmit(node.ctx, plan, transaction)).rejects.toThrow(/failed on chain.*6001/);

    let polls = 0;
    node.status = () => { if (++polls === 2) node.blockHeight = 101; return null; };
    await expect(sendPreparedSubmit(node.ctx, plan, transaction)).rejects.toThrow(/expired without landing/);
  });
});

describe("hosted prepare_submit_attestation and send_signed_transaction tools", () => {
  const challengeKeys = loadChallengeKeys({ MOLPHA_HTTP_CHALLENGE_SECRET: "5a".repeat(32) })!;
  const hosted = (node: Rpc, keys: typeof challengeKeys | null = challengeKeys): ToolDependencies => ({
    getContext: async () => ({ ...node.ctx, hosted: true, solana: {}, gateway: {} }) as unknown as MolphaContext,
    hosted: keys ? { challengeKeys: keys } : {}
  });

  it("replace submit_attestation on the hosted server", () => {
    const names = (deps?: ToolDependencies) => collectTools(deps).map((tool) => tool.name);
    expect(names()).toContain("submit_attestation");
    expect(names({ hosted: {} })).toEqual(expect.arrayContaining(["prepare_submit_attestation", "send_signed_transaction"]));
    expect(names({ hosted: {} })).not.toContain("submit_attestation");
  });

  it("prepare, sign with the caller's wallet, send", async () => {
    const node = await rpc();
    const payer = Keypair.generate();
    const payerAddress = payer.publicKey.toBase58();

    const plan = await callTool("prepare_submit_attestation", { result: flatResult, payer: payerAddress }, hosted(node));
    expect(plan).toMatchObject({ action: "submit_attestation", summary: { chain: "solana", submitter: payerAddress, signaturesRequired: 2, registryVersion: 3 }, lastValidBlockHeight: 100 });
    expect(node.sent).toHaveLength(0);

    const tx = VersionedTransaction.deserialize(Buffer.from(String(plan.unsignedTransaction), "base64"));
    tx.sign([payer]);
    const signedTransaction = Buffer.from(tx.serialize()).toString("base64");
    const outcome = await callTool("send_signed_transaction", { challenge: plan.challenge, signedTransaction }, hosted(node));

    expect(outcome).toMatchObject({ chain: "solana", submitter: payerAddress, feed: (plan.summary as { feed: string }).feed, signature: bs58.encode(tx.signatures[0]!) });
    expect(node.sent).toEqual([signedTransaction]);
  });

  it("sends nothing without a challenge it sealed, and is unavailable without a secret", async () => {
    const node = await rpc();
    const payer = Keypair.generate();
    const plan = await callTool("prepare_submit_attestation", { result: flatResult, payer: payer.publicKey.toBase58() }, hosted(node));
    const tx = VersionedTransaction.deserialize(Buffer.from(String(plan.unsignedTransaction), "base64"));
    tx.sign([payer]);
    const signedTransaction = Buffer.from(tx.serialize()).toString("base64");

    expect(await callToolError("send_signed_transaction", { challenge: `${String(plan.challenge).slice(0, -2)}AA`, signedTransaction }, hosted(node))).toMatchObject({ code: "invalid_challenge" });
    expect(await callToolError("send_signed_transaction", { challenge: plan.challenge, signedTransaction: "bm90IGEgdHg=" }, hosted(node))).toMatchObject({ code: "signed_transaction_mismatch" });
    expect(await callToolError("send_signed_transaction", { challenge: plan.challenge, signedTransaction }, hosted(node, null))).toMatchObject({ code: "missing_config" });
    expect(await callToolError("prepare_submit_attestation", { result: flatResult, payer: payer.publicKey.toBase58() }, hosted(node, null))).toMatchObject({ code: "missing_config" });
    vi.useFakeTimers({ now: Date.now() + 91_000, toFake: ["Date"] });
    try {
      expect(await callToolError("send_signed_transaction", { challenge: plan.challenge, signedTransaction }, hosted(node))).toMatchObject({ code: "transaction_expired" });
    } finally {
      vi.useRealTimers();
    }
    expect(node.sent).toHaveLength(0);
  });
});
