import { BN, BorshAccountsCoder, type Idl } from "@anchor-lang/core";
import { address, type Address } from "@solana/kit";
import {
  AccountState,
  findAssociatedTokenPda,
  getMintEncoder,
  getTokenEncoder,
  TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token";
import { Keypair, PublicKey, Transaction, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMolphaContext, getMolphaProgramId, type MolphaContext } from "../../src/clients.js";
import { type MolphaConfig } from "../../src/config.js";
import { normalizeError } from "../../src/errors.js";
import { recordX402Spend, resetGuardrailCounters, x402SpentToday } from "../../src/guardrails.js";
import { ROUND_TICK_MS } from "../../src/protocol.js";
import { requireSdkExport } from "../../src/sdk.js";
import { type MolphaSigner } from "../../src/signer/types.js";
import {
  conflictRetryDelayMs,
  executePreparedX402Round,
  executeX402Round,
  fetchX402Status,
  prepareX402Round,
  previewX402Round,
  quoteX402Round,
  X402PaymentOutcomeUnknownError,
  X402PaymentRequiredError,
  type X402PaidRound,
  type X402SignerContext
} from "../../src/x402.js";
import {
  computeX402Price,
  deriveGatewayPda,
  deriveProtocolConfigPda,
  verifyPaymentRequirements,
  x402RequestMemo,
  type ExpectedPayment
} from "../../src/x402-payment.js";
import { loadChallengeKeys, sealChallenge } from "../../src/challenge.js";
import { callTool, callToolError, collectTools } from "./tool-harness.js";

vi.mock("../../src/clients.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/clients.js")>()),
  getMolphaContext: vi.fn()
}));

const programId = getMolphaProgramId();
const GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SETTLEMENT_TX = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const apiConfig = { url: "https://api.example.com/v1/finalized/rate", responseParser: "$.rate" };
const sourceId = requireSdkExport<(config: Record<string, unknown>) => string>("deriveSourceIdString")(apiConfig);
const accountsCoder = new BorshAccountsCoder(requireSdkExport<Idl>("MOLPHA_IDL"));
// x402RoundBase 50_000 + (2 signatures + 1 redundancy) * 5
const PRICE = 50_015n;

const randomAddress = (): Address => address(Keypair.generate().publicKey.toBase58());
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function makeSigner(keypair: Keypair): MolphaSigner {
  const sign = <T extends Transaction | VersionedTransaction>(tx: T): T => {
    if (tx instanceof VersionedTransaction) tx.sign([keypair]);
    else tx.partialSign(keypair);
    return tx;
  };
  return {
    publicKey: address(keypair.publicKey.toBase58()),
    isAvailable: async () => true,
    signTransaction: async (tx) => sign(tx),
    signAllTransactions: async (txs) => txs.map(sign),
    signMessage: async () => new Uint8Array(64)
  };
}

async function programAccount(name: string, fields: Record<string, unknown>): Promise<AccountInfo<Buffer>> {
  const data = await accountsCoder.encode(name, fields);
  return { data, owner: new PublicKey(programId), lamports: 1, executable: false, rentEpoch: 0 };
}

function tokenProgramAccount(bytes: Uint8Array): AccountInfo<Buffer> {
  return { data: Buffer.from(bytes), owner: new PublicKey(TOKEN_PROGRAM_ADDRESS), lamports: 1, executable: false, rentEpoch: 0 };
}

function usdcAccount(mint: Address, owner: Address, amount: bigint): AccountInfo<Buffer> {
  return tokenProgramAccount(
    getTokenEncoder().encode({
      mint,
      owner,
      amount,
      delegate: null,
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: 0,
      closeAuthority: null
    }) as Uint8Array
  );
}

interface FakeGatewayOptions {
  /** Mutates the advertised `accepts[0]`, as an untrusted gateway could. */
  tamper?: (offer: Record<string, unknown>) => void;
  /** Answers the unpaid request with this instead of a 402 quote. */
  quote?: () => Response;
  /** Overrides the answer to the Nth paid request. */
  onPaid?: (attempt: number) => Response | undefined;
  /** Overrides fields of the returned attestation payload. */
  data?: Record<string, unknown>;
}

interface Env {
  ctx: X402SignerContext;
  payerKeypair: Keypair;
  endpoint: string;
  authority: Address;
  mint: Address;
  feePayer: Address;
  payer: Address;
  payerAta: Address;
  payToAta: Address;
  treasuryOwner: Address;
  gatewayPda: Address;
  fetch: ReturnType<typeof vi.fn>;
  connection: {
    getLatestBlockhash: ReturnType<typeof vi.fn>;
    getMultipleAccountsInfo: ReturnType<typeof vi.fn>;
    getBlockHeight: ReturnType<typeof vi.fn>;
  };
  quotes: Array<Record<string, unknown>>;
  payments: Array<{ endpoint: string; body: Record<string, unknown>; payload: Record<string, unknown>; tx: VersionedTransaction }>;
  memo: string;
}

let endpointCounter = 0;

async function setup(
  options: {
    pinned?: boolean;
    gatewayStatus?: "Active" | "Deactivated" | null;
    payerBalance?: bigint;
    caps?: Partial<MolphaConfig["x402"]>;
    unreachableFirst?: boolean;
    gateway?: FakeGatewayOptions;
  } = {}
): Promise<Env> {
  const { pinned = true, gatewayStatus = "Active", payerBalance = 5_000_000n } = options;
  endpointCounter += 1;
  const endpoint = `http://gateway-${endpointCounter}.test`;
  const unreachable = `http://unreachable-${endpointCounter}.test`;
  const payerKeypair = Keypair.generate();
  const signer = makeSigner(payerKeypair);
  const payer = signer.publicKey;
  const authority = randomAddress();
  const mint = randomAddress();
  const feePayer = randomAddress();
  const gatewayPda = await deriveGatewayPda(authority, programId);
  const [payerAta] = await findAssociatedTokenPda({ owner: payer, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const treasuryOwner = await deriveProtocolConfigPda(programId);
  const [payToAta] = await findAssociatedTokenPda({ owner: treasuryOwner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

  const accounts = new Map<string, AccountInfo<Buffer>>();
  accounts.set(
    requireSdkExport<(program: string) => string>("protocolConfigPda")(programId),
    await programAccount("ProtocolConfig", {
      authority: new PublicKey(randomAddress()),
      usdc_mint: new PublicKey(mint),
      reward_per_signature: new BN(5),
      max_settlement_delay_seconds: new BN(300),
      challenger_bounty_bps: 100,
      minimum_node_deposit: new BN(1),
      withdrawal_cooldown_slots: new BN(1),
      x402_round_base: new BN(50_000),
      reward_liability: new BN(0),
      min_signers: 2,
      epoch_len_seconds: new BN(3600),
      ticket_grace_seconds: new BN(600),
      target_tickets_per_epoch: 2000,
      min_availability_bps: 8000,
      min_availability_samples: 50,
      protocol_fee_bps: 1000,
      pool_liability: new BN(0),
      protocol_reserved: new BN(0),
      bump: 255
    })
  );
  accounts.set(
    mint,
    tokenProgramAccount(
      getMintEncoder().encode({ mintAuthority: null, supply: 1_000_000_000n, decimals: 6, isInitialized: true, freezeAuthority: null }) as Uint8Array
    )
  );
  if (gatewayStatus) {
    accounts.set(
      gatewayPda,
      await programAccount("Gateway", {
        authority: new PublicKey(authority),
        ip: [127, 0, 0, 1],
        port: 8080,
        status: { [gatewayStatus]: {} },
        registered_at: new BN(1),
        bump: 255
      })
    );
  }
  accounts.set(payToAta, usdcAccount(mint, treasuryOwner, 1_000_000n));
  accounts.set(payerAta, usdcAccount(mint, payer, payerBalance));

  const connection = {
    getGenesisHash: vi.fn(async () => GENESIS_HASH),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 })),
    getBlockHeight: vi.fn(async () => 40),
    getAccountInfo: vi.fn(async (key: PublicKey) => accounts.get(key.toBase58()) ?? null),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((key) => accounts.get(key.toBase58()) ?? null))
  };

  const memo = x402RequestMemo({
    programId,
    gatewayPda,
    sourceId: Buffer.from(sourceId, "hex"),
    signaturesRequired: 2,
    registryVersion: 3
  });

  const quotes: Env["quotes"] = [];
  const payments: Env["payments"] = [];
  const gw = options.gateway ?? {};
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.startsWith(unreachable)) throw new TypeError("fetch failed");
    if (href.startsWith(`${endpoint}/v1/x402/status`)) {
      return jsonResponse(200, {
        gateway: gatewayPda,
        authority,
        payTo: treasuryOwner,
        treasuryAta: payToAta,
        quotedNextPrice: String(PRICE),
        pendingTickets: 0
      });
    }
    expect(href).toBe(`${endpoint}/v1/x402/execute`);

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    // The gateway assigns the round's timestamp; a body that names one is from the old protocol.
    expect(Object.keys(body).sort()).toEqual(["apiConfig", "registry_version", "signatures_required"]);
    // What the gateway's service advertises for this body.
    const requirements = {
      scheme: "exact",
      network: NETWORK,
      amount: String(PRICE),
      asset: mint,
      payTo: treasuryOwner,
      maxTimeoutSeconds: 60,
      extra: { feePayer, memo }
    };
    const paymentHeader = (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];

    if (!paymentHeader) {
      quotes.push(body);
      if (gw.quote) return gw.quote();
      const offer: Record<string, unknown> = structuredClone(requirements);
      gw.tamper?.(offer);
      const required = {
        x402Version: 2,
        resource: { url: `${endpoint}/v1/x402/execute`, description: "Molpha oracle round", mimeType: "application/json" },
        accepts: [offer]
      };
      return jsonResponse(402, required, { "PAYMENT-REQUIRED": b64(required) });
    }

    const payload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8")) as Record<string, unknown>;
    const tx = VersionedTransaction.deserialize(
      Buffer.from((payload.payload as { transaction: string }).transaction, "base64")
    );
    payments.push({ endpoint, body, payload, tx });
    const override = gw.onPaid?.(payments.length);
    if (override) return override;

    // payment.Decode: the echoed requirements must equal the server's exactly.
    expect(payload.accepted).toEqual(requirements);
    return jsonResponse(
      200,
      {
        status: "completed",
        // The gateway's AttestationData: the signed struct is nested under `attestation`.
        data: {
          attestation: {
            payload: {
              value: "ab".repeat(32),
              sourceId,
              registryVersion: body.registry_version,
              signaturesRequired: body.signatures_required,
              // Stamped by the gateway from its own clock, in unix milliseconds on the round tick grid.
              timestamp: Math.floor(Date.now() / ROUND_TICK_MS) * ROUND_TICK_MS,
              ...gw.data
            },
            signature: { signature: "11".repeat(32), commitment: "22".repeat(20), signersBitmap: "3" }
          },
          value: "42",
          fresh: true,
          configHash: sourceId
        }
      },
      { "PAYMENT-RESPONSE": b64({ success: true, transaction: SETTLEMENT_TX, network: NETWORK, payer }) }
    );
  });
  vi.stubGlobal("fetch", fetchMock);

  const endpoints = options.unreachableFirst ? [unreachable, endpoint] : [endpoint];
  const config: MolphaConfig = {
    gatewayEndpoints: endpoints,
    gatewayAuthorities: endpoints.map((url) => (pinned && url === endpoint ? authority : undefined)),
    solanaRpc: "http://solana.test",
    ownerKeypair: undefined,
    evmNetworks: [],
    starknetNetworks: [],
    guardrails: { maxExecutesPerDay: 100, dryRunDefault: false },
    x402: { maxPriceUsdcAtomic: 1_000_000n, maxSpendPerDayUsdcAtomic: 10_000_000n, ...options.caps }
  };

  const ctx: X402SignerContext = {
    config,
    connection: connection as unknown as X402SignerContext["connection"],
    signer,
    solana: { getRegistrySelectionConfig: async () => ({ registryVersion: 3, redundancyBuffer: 1, nodeCount: 3 }) },
    gateway: { fetchGatewayInfo: vi.fn(async () => ({ gatewayAuthority: authority })) }
  };

  return {
    ctx,
    payerKeypair,
    endpoint,
    authority,
    mint,
    feePayer,
    payer,
    payerAta,
    payToAta,
    treasuryOwner,
    gatewayPda,
    fetch: fetchMock,
    connection,
    quotes,
    payments,
    memo
  };
}

const round = { apiConfig, signaturesRequired: 2 };

beforeEach(() => {
  resetGuardrailCounters();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("x402RequestMemo", () => {
  it("matches the memo the gateway advertises for its service-test fixture", async () => {
    // gateway internal/gateway/features/agentexec/service_test.go TestPaymentMemoGoldenVector:
    // authority PublicKey{4}, apiConfig {url: https://example.com, method: GET},
    // quorum 2, registry version 3.
    const fixtureSourceId = requireSdkExport<(config: Record<string, unknown>) => string>("deriveSourceIdString")({
      url: "https://example.com",
      method: "GET",
      responseParser: ""
    });
    expect(fixtureSourceId).toBe("0b3212de6506ecfabafe4ae5ab26a542b2503f41d88d599dc4cb28d08cab41a3");
    // The gateway's fake chain program id; independent of the SDK's default program address.
    const fixtureProgramId = address("MoLFnEbuMS5gWnXNfUMLAYSqRM3eQZKWRzjeMQfqbT3");
    const gatewayPda = await deriveGatewayPda(address("GcdayuLaLyrdmUu324nahyv33G5poQdLUEZ1nEytDeP"), fixtureProgramId);
    expect(gatewayPda).toBe("H6DDMmWivXh8GdBaxwsZQbwWXwKwPSx3SdmSyJV24yXd");

    expect(
      x402RequestMemo({
        programId: fixtureProgramId,
        gatewayPda,
        sourceId: Buffer.from(fixtureSourceId, "hex"),
        signaturesRequired: 2,
        registryVersion: 3
      })
    ).toBe("e2eeef1f32716c89df97420bbdd1559755b1ed610c652a3b9fb39aaf2eb40f06");
  });

  it("commits to the deployment, gateway, source, quorum, and registry version", () => {
    const base = {
      programId,
      gatewayPda: randomAddress(),
      sourceId: Buffer.from(sourceId, "hex"),
      signaturesRequired: 2,
      registryVersion: 3
    };
    const memos = [
      base,
      { ...base, programId: randomAddress() },
      { ...base, gatewayPda: randomAddress() },
      { ...base, sourceId: Buffer.alloc(32, 1) },
      { ...base, signaturesRequired: 3 },
      { ...base, registryVersion: 4 }
    ].map(x402RequestMemo);
    expect(new Set(memos).size).toBe(memos.length);
  });
});

describe("computeX402Price", () => {
  it("funds the whole selection, as settle_x402_round and the gateway quote do", () => {
    // gateway service_test.go: base 1000, reward 10, quorum 2, redundancy 1 → "1030".
    expect(computeX402Price({ x402RoundBase: 1000n, rewardPerSignature: 10n }, 2, 1)).toBe(1030n);
  });
});

describe("verifyPaymentRequirements", () => {
  const payer = randomAddress();
  const expected: ExpectedPayment = {
    network: NETWORK,
    payTo: randomAddress(),
    asset: randomAddress(),
    amount: 1030n,
    memo: "ab".repeat(32),
    payer
  };
  const feePayer = randomAddress();
  const offer = (): Record<string, unknown> => ({
    scheme: "exact",
    network: NETWORK,
    amount: "1030",
    asset: expected.asset,
    payTo: expected.payTo,
    maxTimeoutSeconds: 60,
    extra: { feePayer, memo: expected.memo }
  });
  const required = (mutate: (offer: Record<string, unknown>) => void = () => {}) => {
    const entry = offer();
    mutate(entry);
    return { x402Version: 2, resource: { url: "/v1/x402/execute" }, accepts: [entry] };
  };

  it("accepts the protocol payment and echoes the offer unchanged", () => {
    const verified = verifyPaymentRequirements(required(), expected);
    expect(verified.accepted).toEqual(offer());
    expect(verified.feePayer).toBe(feePayer);
    expect(verified.amount).toBe(1030n);
  });

  it.each<[string, (entry: Record<string, unknown>) => void, RegExp]>([
    ["another network", (entry) => (entry.network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), /no "exact" payment on/],
    ["another scheme", (entry) => (entry.scheme = "upto"), /no "exact" payment on/],
    ["another payTo", (entry) => (entry.payTo = randomAddress()), /payTo mismatch/],
    ["another asset", (entry) => (entry.asset = randomAddress()), /asset mismatch/],
    ["a higher amount", (entry) => (entry.amount = "1031"), /amount mismatch/],
    ["a lower amount", (entry) => (entry.amount = "1029"), /amount mismatch/],
    ["a non-decimal amount", (entry) => (entry.amount = "0x406"), /amount mismatch/],
    ["another round's memo", (entry) => (entry.extra = { feePayer, memo: "cd".repeat(32) }), /extra\.memo mismatch/],
    ["the signer as fee payer", (entry) => (entry.extra = { feePayer: payer, memo: expected.memo }), /must sponsor the fee/],
    ["no fee payer", (entry) => (entry.extra = { memo: expected.memo }), /extra\.feePayer is not a Solana address/],
    ["a non-string extra", (entry) => (entry.extra = { feePayer, memo: expected.memo, n: 1 }), /malformed extra/],
    ["no timeout", (entry) => delete entry.maxTimeoutSeconds, /malformed maxTimeoutSeconds/]
  ])("rejects %s", (_label, mutate, error) => {
    expect(() => verifyPaymentRequirements(required(mutate), expected)).toThrow(error);
  });

  it("rejects any x402Version other than 2", () => {
    expect(() => verifyPaymentRequirements({ ...required(), x402Version: 1 }, expected)).toThrow(/unsupported x402Version/);
    expect(() => verifyPaymentRequirements(undefined, expected)).toThrow(/unsupported x402Version/);
  });
});

describe("executeX402Round", () => {
  it("pays the verified quote with an exact-SVM transfer and returns the round with its receipt", async () => {
    const env = await setup();

    const { result, payment } = await executeX402Round(env.ctx, round);

    expect(result).toMatchObject({ sourceId, value: "42", configHash: sourceId, registryVersion: 3, signaturesRequired: 2 });
    expect(env.quotes).toHaveLength(1);
    expect(env.payments).toHaveLength(1);
    const [paid] = env.payments;
    expect(paid!.body).toEqual(env.quotes[0]);
    expect(env.quotes[0]).toMatchObject({ signatures_required: 2, registry_version: 3 });
    expect(payment).toEqual({
      endpoint: env.endpoint,
      network: NETWORK,
      payer: env.payer,
      payTo: env.treasuryOwner,
      asset: env.mint,
      amountAtomicUsdc: String(PRICE),
      feePayer: env.feePayer,
      memo: env.memo,
      transaction: SETTLEMENT_TX
    });
    expect(paid!.payload).toMatchObject({ x402Version: 2, resource: { url: `${env.endpoint}/v1/x402/execute` } });

    // The facilitator's exact-SVM checks: v0, it pays the fee and has not signed yet,
    // only it and the payer sign, and the layout is limit, price, TransferChecked, memo.
    const { tx } = paid!;
    const keys = tx.message.staticAccountKeys.map((key) => key.toBase58());
    expect(tx.version).toBe(0);
    expect(tx.message.header.numRequiredSignatures).toBe(2);
    expect(keys.slice(0, 2)).toEqual([env.feePayer, env.payer]);
    expect(tx.signatures[0]!.every((byte) => byte === 0)).toBe(true);
    expect(tx.signatures[1]!.some((byte) => byte !== 0)).toBe(true);

    const instructions = tx.message.compiledInstructions.map((ix) => ({
      program: keys[ix.programIdIndex],
      accounts: ix.accountKeyIndexes.map((index) => keys[index]),
      data: Buffer.from(ix.data)
    }));
    expect(instructions.map((ix) => ix.program)).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, TOKEN_PROGRAM_ADDRESS, MEMO_PROGRAM]);
    expect(instructions[0]!.data[0]).toBe(2);
    expect(instructions[1]!.data[0]).toBe(3);
    expect(instructions[1]!.data.readBigUInt64LE(1)).toBeLessThanOrEqual(5_000_000n);
    const transfer = instructions[2]!;
    expect(transfer.data[0]).toBe(12); // TransferChecked
    expect(transfer.data.readBigUInt64LE(1)).toBe(PRICE);
    expect(transfer.data[9]).toBe(6);
    expect(transfer.accounts).toEqual([env.payerAta, env.mint, env.payToAta, env.payer]);
    expect(instructions[3]!.accounts).toEqual([]);
    expect(instructions[3]!.data.toString("utf8")).toBe(env.memo);

    expect(x402SpentToday()).toBe(PRICE);
  });

  it("discovers an unpinned gateway authority and pays it once its Gateway account is Active", async () => {
    const env = await setup({ pinned: false });

    await executeX402Round(env.ctx, round);

    expect(env.ctx.gateway.fetchGatewayInfo).toHaveBeenCalledWith(env.endpoint);
    expect(env.payments).toHaveLength(1);
  });

  it.each([
    ["unregistered", null, /no registered Molpha gateway/],
    ["deactivated", "Deactivated", /not an Active gateway/]
  ] as const)("refuses to pay an unpinned %s gateway authority", async (_label, gatewayStatus, error) => {
    const env = await setup({ pinned: false, gatewayStatus });

    await expect(executeX402Round(env.ctx, round)).rejects.toThrow(error);
    expect(env.payments).toHaveLength(0);
  });

  it.each<[string, (offer: Record<string, unknown>) => void, RegExp]>([
    ["a payTo other than the protocol treasury (e.g. the gateway authority)", (offer) => (offer.payTo = randomAddress()), /payTo mismatch/],
    ["another asset", (offer) => (offer.asset = randomAddress()), /asset mismatch/],
    ["a price above the protocol price", (offer) => (offer.amount = String(PRICE + 1n)), /amount mismatch/],
    ["another network", (offer) => (offer.network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), /no "exact" payment/],
    [
      "a memo for another round",
      (offer) => ((offer.extra as Record<string, string>).memo = "cd".repeat(32)),
      /extra\.memo mismatch/
    ]
  ])("signs nothing for a 402 with %s", async (_label, tamper, error) => {
    const env = await setup({ gateway: { tamper } });

    await expect(executeX402Round(env.ctx, round)).rejects.toThrow(error);
    expect(env.payments).toHaveLength(0);
    expect(env.connection.getLatestBlockhash).not.toHaveBeenCalled();
    expect(x402SpentToday()).toBe(0n);
  });

  it("refuses a round above the per-round cap before contacting any gateway", async () => {
    const env = await setup({ caps: { maxPriceUsdcAtomic: PRICE - 1n } });

    await expect(executeX402Round(env.ctx, round)).rejects.toThrow(/per-round price cap reached/);
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("refuses once the daily spend cap is used up", async () => {
    recordX402Spend(10_000_000n);
    const env = await setup();

    await expect(executeX402Round(env.ctx, round)).rejects.toThrow(/daily spend cap reached/);
    expect(env.payments).toHaveLength(0);
  });

  it("refuses a quorum below the protocol min_signers before contacting any gateway", async () => {
    const env = await setup();

    await expect(executeX402Round(env.ctx, { apiConfig, signaturesRequired: 1 })).rejects.toThrow(/min_signers 2/);
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("refuses before signing when the signer's USDC does not cover the round", async () => {
    const env = await setup({ payerBalance: PRICE - 1n });

    await expect(executeX402Round(env.ctx, round)).rejects.toThrow(/insufficient USDC/);
    expect(env.payments).toHaveLength(0);
    expect(x402SpentToday()).toBe(0n);
  });

  it("does not pay again when the gateway rejects the payment", async () => {
    const env = await setup({
      gateway: {
        onPaid: () => jsonResponse(402, { x402Version: 2, error: "invalid payment: facilitator rejected payment", accepts: [] })
      }
    });

    const error = await executeX402Round(env.ctx, round).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(X402PaymentRequiredError);
    expect((error as Error).message).toMatch(/facilitator rejected payment/);
    expect(env.payments).toHaveLength(1);
    // A signed transfer is counted whether or not the round completed.
    expect(x402SpentToday()).toBe(PRICE);
  });

  it("pays for every call: two in a row both succeed, each with its own quote and payment", async () => {
    const env = await setup();

    const first = await executeX402Round(env.ctx, round);
    const second = await executeX402Round(env.ctx, round);

    expect(first.payment.memo).toBe(env.memo);
    expect(second.payment.memo).toBe(env.memo);
    expect(env.quotes).toHaveLength(2);
    expect(env.payments).toHaveLength(2);
    expect(x402SpentToday()).toBe(2n * PRICE);
  });

  it("waits one full round tick plus a small jitter before repeating a request answered with 409", () => {
    expect(conflictRetryDelayMs(() => 0)).toBe(ROUND_TICK_MS);
    expect(conflictRetryDelayMs(() => 0.5)).toBe(110);
    expect(conflictRetryDelayMs(() => 0.999)).toBeLessThan(120);
    for (let i = 0; i < 100; i++) {
      const wait = conflictRetryDelayMs();
      expect(wait).toBeGreaterThanOrEqual(ROUND_TICK_MS);
      expect(wait).toBeLessThan(120);
    }
  });

  it("resends the same payment once, a full tick after a 409, without quoting or signing again", async () => {
    const paidAt: number[] = [];
    const env = await setup({
      gateway: {
        onPaid: (attempt) => {
          paidAt.push(performance.now());
          return attempt === 1 ? jsonResponse(409, { error: "round or payment already reserved" }) : undefined;
        }
      }
    });
    const sign = vi.spyOn(env.ctx.signer, "signTransaction");

    const { payment } = await executeX402Round(env.ctx, round);

    // About one tick apart. The margin allows for timer granularity, not for a shorter wait.
    expect(paidAt[1]! - paidAt[0]!).toBeGreaterThan(ROUND_TICK_MS - 10);
    expect(env.quotes).toHaveLength(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(env.payments).toHaveLength(2);
    expect(env.payments[1]!.payload).toEqual(env.payments[0]!.payload);
    expect(env.payments[1]!.body).toEqual(env.payments[0]!.body);
    expect(payment.memo).toBe(env.memo);
    // One signed transfer, however many times it was posted.
    expect(x402SpentToday()).toBe(PRICE);
  });

  it("stops after a second 409: one retry, then the tool fails with round_conflict", async () => {
    const env = await setup({ gateway: { onPaid: () => jsonResponse(409, { error: "round or payment already reserved" }) } });

    const error = await executeX402Round(env.ctx, round).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 409 });
    expect((error as Error).message).toMatch(/refused this x402 payment twice as a duplicate/);
    expect((error as Error).message).toMatch(/a new round needs a new payment/);
    const normalized = normalizeError(error);
    expect(normalized).toMatchObject({ code: "round_conflict", status: 409 });
    expect(normalized.remediation).toMatch(/already has a round for this feed \(the same source and quorum\) in the current 100 ms tick/);
    expect(env.payments).toHaveLength(2);
    expect(x402SpentToday()).toBe(PRICE);
  });

  it.each([
    // Refused by the gateway's capacity limit before the request was read: nothing was reserved.
    ["the gateway was at capacity", "gateway at capacity, retry shortly"],
    // The round was dispatched and failed: the gateway keeps the payment spent without settling it.
    ["too few nodes accepted the round", "nodes busy: node directory unavailable: 1 of 3 dispatched nodes accepted, need 2 (gateway rate budget exhausted)"],
    // The round ran and the settlement's outcome is not known.
    ["settlement was not confirmed", "payment settlement not confirmed; retain payment proof for reconciliation"]
  ])("reports an unknown payment outcome and never resends the payment after a 503 (%s)", async (_label, message) => {
    const env = await setup({ gateway: { onPaid: () => jsonResponse(503, { error: message }) } });

    const error = await executeX402Round(env.ctx, round).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(X402PaymentOutcomeUnknownError);
    const reconciliation = (error as X402PaymentOutcomeUnknownError).reconciliation;
    expect(reconciliation).toMatchObject({
      endpoint: env.endpoint,
      payTo: env.treasuryOwner,
      amountAtomicUsdc: String(PRICE),
      memo: env.memo,
      payerSignature: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
      lastValidBlockHeight: 100,
      httpStatus: 503,
      gatewayMessage: message
    });
    const normalized = normalizeError(error);
    expect(normalized).toMatchObject({ code: "payment_outcome_unknown", details: reconciliation });
    expect(normalized.remediation).toMatch(/A retry is a new round and signs a new payment/);
    expect(normalized.remediation).toMatch(/`gateway at capacity` is the gateway's own capacity limit, which refuses a request before reading it/);
    expect(env.quotes).toHaveLength(1);
    expect(env.payments).toHaveLength(1);
  });

  it("fails over to the next endpoint for the quote and pays only the endpoint that quoted", async () => {
    const env = await setup({ unreachableFirst: true });

    await executeX402Round(env.ctx, round);

    expect(env.payments.map((paid) => paid.endpoint)).toEqual([env.endpoint]);
  });

  it("stops at a 400 from the quote without paying", async () => {
    const env = await setup({
      gateway: { quote: () => jsonResponse(400, { error: "registry_version: registry version or quorum does not match current snapshot" }) }
    });

    await expect(executeX402Round(env.ctx, round)).rejects.toThrow(/x402 execute rejected: registry_version/);
    expect(env.payments).toHaveLength(0);
  });

  it("rejects a caller sourceId that does not match apiConfig before any network call", async () => {
    const env = await setup();

    await expect(executeX402Round(env.ctx, { ...round, sourceId: "ff".repeat(32) })).rejects.toThrow(
      /sourceId does not match apiConfig/
    );
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("accepts a caller sourceId that matches apiConfig, with or without 0x", async () => {
    const env = await setup();

    await executeX402Round(env.ctx, { ...round, sourceId: `0x${sourceId.toUpperCase()}` });
    expect(env.payments).toHaveLength(1);
  });

  it("refuses to return an aggregate for a different round", async () => {
    const env = await setup({ gateway: { data: { sourceId: "cd".repeat(32) } } });

    await expect(executeX402Round(env.ctx, round)).rejects.toThrow(new RegExp(`settled x402 payment ${SETTLEMENT_TX}.*different round`));
  });

  it.each([
    ["in unix seconds, as the old protocol stamped it", () => Math.floor(Date.now() / 1000)],
    ["from ten minutes ago", () => Date.now() - 600_000],
    ["from ten minutes ahead", () => Date.now() + 600_000],
    ["missing", () => undefined]
  ])("refuses an aggregate whose timestamp is %s", async (_label, timestamp) => {
    const env = await setup({ gateway: { data: { timestamp: timestamp() } } });

    await expect(executeX402Round(env.ctx, round)).rejects.toThrow(/different round/);
  });
});

describe("prepareX402Round and executePreparedX402Round", () => {
  // The hosted path: no signer in the context, and the prepared round crosses the wire as JSON.
  const keyless = (env: Env) => {
    const { signer: _signer, ...ctx } = env.ctx;
    return ctx;
  };
  const overTheWire = (prepared: { round: X402PaidRound; transaction: VersionedTransaction }) => ({
    round: JSON.parse(JSON.stringify(prepared.round)) as X402PaidRound,
    transaction: VersionedTransaction.deserialize(prepared.transaction.serialize())
  });

  it("builds an unsigned payment for the payer, then runs the round once the payer has signed it", async () => {
    const env = await setup();
    const ctx = keyless(env);

    const prepared = await prepareX402Round(ctx, round, env.payer);

    expect(prepared.transaction.signatures.every((signature) => signature.every((byte) => byte === 0))).toBe(true);
    expect(prepared.round).toMatchObject({
      endpoint: env.endpoint,
      network: NETWORK,
      gatewayPda: env.gatewayPda,
      payer: env.payer,
      feePayer: env.feePayer,
      payTo: env.treasuryOwner,
      asset: env.mint,
      amountAtomicUsdc: String(PRICE),
      memo: env.memo,
      sourceId,
      lastValidBlockHeight: 100
    });
    expect(prepared).toMatchObject({ payerAta: env.payerAta, payToAta: env.payToAta, payerBalanceAtomicUsdc: "5000000" });
    expect(env.payments).toHaveLength(0);
    expect(x402SpentToday()).toBe(0n);

    const { round: paidRound, transaction } = overTheWire(prepared);
    transaction.sign([env.payerKeypair]);
    const { result, payment } = await executePreparedX402Round(ctx, paidRound, transaction);

    expect(result).toMatchObject({ sourceId, value: "42", registryVersion: 3, signaturesRequired: 2 });
    expect(payment).toMatchObject({ payer: env.payer, memo: env.memo, transaction: SETTLEMENT_TX });
    expect(env.quotes).toHaveLength(1);
    expect(env.payments).toHaveLength(1);
    expect(env.payments[0]!.body).toEqual(env.quotes[0]);
    expect(x402SpentToday()).toBe(PRICE);
  });

  it.each<[string, (env: Env, tx: VersionedTransaction) => VersionedTransaction | Promise<VersionedTransaction>, RegExp]>([
    ["an unsigned transaction", (_env, tx) => tx, /not signed by its payer/],
    [
      "a signature that is not the payer's",
      (_env, tx) => {
        tx.signatures[1] = Keypair.generate().secretKey.slice(0, 64);
        return tx;
      },
      /not signed by its payer/
    ],
    [
      "a different transaction signed by the payer",
      async (env) => {
        const other = (await prepareX402Round(keyless(env), round, env.payer)).transaction;
        other.sign([env.payerKeypair]);
        return other;
      },
      /not the one that was prepared/
    ]
  ])("sends nothing for %s", async (_label, tamper, error) => {
    const env = await setup();
    const { round: paidRound, transaction } = overTheWire(await prepareX402Round(keyless(env), round, env.payer));

    const failure = await executePreparedX402Round(keyless(env), paidRound, await tamper(env, transaction)).catch(
      (caught: unknown) => caught
    );

    expect(failure).toMatchObject({ code: "signed_transaction_mismatch" });
    expect((failure as Error).message).toMatch(error);
    expect(env.payments).toHaveLength(0);
    expect(x402SpentToday()).toBe(0n);
  });

  it("refuses a round prepared for an endpoint that is not configured", async () => {
    const env = await setup();
    const { round: paidRound, transaction } = overTheWire(await prepareX402Round(keyless(env), round, env.payer));
    transaction.sign([env.payerKeypair]);

    await expect(
      executePreparedX402Round(keyless(env), { ...paidRound, endpoint: "http://elsewhere.test" }, transaction)
    ).rejects.toThrow(/not a configured gateway endpoint/);
    expect(env.payments).toHaveLength(0);
  });

  it("applies the per-round cap again when the payment comes back", async () => {
    const env = await setup({ caps: { dailyCapsEnabled: false } });
    const { round: paidRound, transaction } = overTheWire(await prepareX402Round(keyless(env), round, env.payer));
    transaction.sign([env.payerKeypair]);
    const ctx = keyless(env);
    ctx.config = { ...ctx.config, x402: { ...ctx.config.x402, maxPriceUsdcAtomic: PRICE - 1n } };

    await expect(executePreparedX402Round(ctx, paidRound, transaction)).rejects.toThrow(/per-round price cap reached/);
    expect(env.payments).toHaveLength(0);
  });

  it("refuses to prepare a payment the payer cannot cover", async () => {
    const env = await setup({ payerBalance: PRICE - 1n });

    await expect(prepareX402Round(keyless(env), round, env.payer)).rejects.toThrow(/insufficient USDC/);
    expect(env.connection.getLatestBlockhash).not.toHaveBeenCalled();
  });
});

describe("previewX402Round", () => {
  it("quotes and verifies the payment without signing or spending", async () => {
    const env = await setup();

    const preview = await previewX402Round(env.ctx, round);

    expect(preview).toMatchObject({
      dryRun: true,
      sourceId: `0x${sourceId}`,
      gateway: { endpoint: env.endpoint, authority: env.authority, pda: env.gatewayPda },
      payTo: env.treasuryOwner,
      network: NETWORK,
      asset: env.mint,
      priceAtomicUsdc: String(PRICE),
      feePayer: env.feePayer,
      memo: env.memo,
      payerUsdcAta: env.payerAta,
      payerBalanceAtomicUsdc: "5000000",
      shortfallAtomicUsdc: "0"
    });
    expect(env.payments).toHaveLength(0);
    expect(env.connection.getLatestBlockhash).not.toHaveBeenCalled();
    expect(x402SpentToday()).toBe(0n);
  });

  it("reports the shortfall when the signer's USDC does not cover the round", async () => {
    const env = await setup({ payerBalance: 15n });

    const preview = await previewX402Round(env.ctx, round);

    expect(preview.shortfallAtomicUsdc).toBe(String(PRICE - 15n));
    expect(preview.note).toMatch(/refuse before signing/);
  });

  it("applies the same verification as a live round", async () => {
    const env = await setup({ gateway: { tamper: (offer) => (offer.payTo = randomAddress()) } });

    await expect(previewX402Round(env.ctx, round)).rejects.toThrow(/payTo mismatch/);
  });
});

describe("fetchX402Status", () => {
  const floatStatus = {
    gateway: randomAddress(),
    authority: randomAddress(),
    payTo: randomAddress(),
    treasuryAta: randomAddress(),
    quotedNextPrice: "1030",
    pendingTickets: 1
  };
  const config = (endpoints: string[]): MolphaConfig => ({
    gatewayEndpoints: endpoints,
    gatewayAuthorities: endpoints.map(() => undefined),
    solanaRpc: "http://solana.test",
    ownerKeypair: undefined,
    evmNetworks: [],
    starknetNetworks: [],
    guardrails: { maxExecutesPerDay: 100, dryRunDefault: false },
    x402: { maxPriceUsdcAtomic: 1_000_000n, maxSpendPerDayUsdcAtomic: 10_000_000n }
  });

  it("reads the gateway status, quoting the protocol minimum unless a quorum is given", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        urls.push(String(url));
        return jsonResponse(200, floatStatus);
      })
    );

    expect(await fetchX402Status(config(["http://one.test/"]))).toEqual({ endpoint: "http://one.test/", status: floatStatus });
    await fetchX402Status(config(["http://one.test"]), 3);
    expect(urls).toEqual(["http://one.test/v1/x402/status", "http://one.test/v1/x402/status?signatures_required=3"]);
  });

  it("falls through unreachable gateways but surfaces a rejected quorum", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).startsWith("http://down.test")) throw new TypeError("fetch failed");
        return jsonResponse(400, { error: "signatures_required: outside current protocol quorum limits" });
      })
    );

    await expect(fetchX402Status(config(["http://down.test", "http://up.test"]), 9)).rejects.toThrow(
      /rejected: signatures_required: outside current protocol quorum limits/
    );
  });
});

describe("execute_x402_round and get_x402_status tools", () => {
  it("previews, then pays, returning output that matches the advertised schema", async () => {
    const env = await setup();
    vi.mocked(getMolphaContext).mockResolvedValue(env.ctx as unknown as MolphaContext);

    const preview = await callTool("execute_x402_round", { ...round, chains: ["evm"], dryRun: true });
    expect(preview).toMatchObject({
      payment: "x402",
      dryRun: true,
      action: "execute_x402_round",
      sourceId: `0x${sourceId}`,
      payTo: env.treasuryOwner,
      priceAtomicUsdc: String(PRICE)
    });
    expect(env.payments).toHaveLength(0);

    const live = await callTool("execute_x402_round", { ...round, chains: ["evm"] });
    expect(live).toMatchObject({
      payment: "x402",
      value: "42",
      dataUpdate: { sourceId: `0x${sourceId}`, registryVersion: 3, signaturesRequired: 2 },
      verifierArgs: { evm: { args: {} } },
      paymentReceipt: { payTo: env.treasuryOwner, amountAtomicUsdc: String(PRICE), transaction: SETTLEMENT_TX }
    });
    expect(env.payments).toHaveLength(1);
  });

  it("get_x402_status reports the quote, the treasury, the signer's USDC, and the budget", async () => {
    const env = await setup();
    vi.mocked(getMolphaContext).mockResolvedValue(env.ctx as unknown as MolphaContext);

    expect(await callTool("get_x402_status", { signaturesRequired: 2 })).toMatchObject({
      endpoint: env.endpoint,
      signaturesRequired: 2,
      quotedNextPriceAtomicUsdc: String(PRICE),
      withinPerRoundCap: true,
      gateway: { authority: env.authority, payTo: env.treasuryOwner, treasuryAta: env.payToAta, pendingTickets: 0 },
      payer: env.payer,
      payerUsdc: { ata: env.payerAta, exists: true, balanceAtomicUsdc: "5000000" },
      caps: { spentTodayUsdcAtomic: "0", remainingTodayUsdcAtomic: "10000000" }
    });
    expect(env.payments).toHaveLength(0);
  });
});


describe("hosted x402 policies", () => {
  it("returns the real unpaid 402 quote without accessing payer accounts", async () => {
    const env = await setup();
    const { signer, ...unsigned } = env.ctx;
    const sign = vi.spyOn(signer, "signTransaction");
    const result = await quoteX402Round(unsigned, { apiConfig, signaturesRequired: 2 });
    expect(result).toMatchObject({ payment: "x402", quoteOnly: true, dryRun: true,
      paymentRequired: { x402Version: 2, accepts: [{ amount: String(PRICE), payTo: env.treasuryOwner }] } });
    expect(env.payments).toHaveLength(0);
    expect(env.connection.getMultipleAccountsInfo).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });
  it("ignores and never increments process daily spend when hosted caps are disabled", async () => {
    const env = await setup({ caps: { dailyCapsEnabled: false, maxSpendPerDayUsdcAtomic: 1n } });
    recordX402Spend(7n);
    await executeX402Round(env.ctx, { apiConfig, signaturesRequired: 2 });
    expect(env.payments).toHaveLength(1);
    expect(x402SpentToday()).toBe(7n);
    expect(await previewX402Round(env.ctx, { apiConfig, signaturesRequired: 2 })).not.toHaveProperty("spentTodayAtomicUsdc");
  });
  it("retains the per-round limit with daily caps disabled", async () => {
    const env = await setup({ caps: { dailyCapsEnabled: false, maxPriceUsdcAtomic: 1n } });
    await expect(executeX402Round(env.ctx, { apiConfig, signaturesRequired: 2 })).rejects.toThrow("per-round");
    expect(env.payments).toHaveLength(0);
  });
  it("does not start a cancelled round", async () => {
    const env = await setup();
    const controller = new AbortController(); controller.abort();
    env.ctx.lifecycle = { signal: controller.signal };
    await expect(executeX402Round(env.ctx, { apiConfig, signaturesRequired: 2 })).rejects.toThrow();
    expect(env.quotes).toHaveLength(0);
    expect(env.payments).toHaveLength(0);
  });
});

describe("hosted prepare_x402_round and execute_x402_round tools", () => {
  const challengeKeys = loadChallengeKeys({ MOLPHA_HTTP_CHALLENGE_SECRET: "5a".repeat(32) })!;
  const args = (env: Env) => ({ ...round, chains: ["evm"], payer: env.payer });
  // The hosted server's context: chain and gateway access, no signer.
  const hosted = (env: Env, keys: typeof challengeKeys | null = challengeKeys) => {
    const { signer: _signer, ...ctx } = env.ctx;
    return { getContext: async () => ({ ...ctx, hosted: true }) as unknown as MolphaContext, hosted: keys ? { challengeKeys: keys } : {} };
  };
  const sign = (env: Env, unsignedTransaction: unknown): string => {
    const tx = VersionedTransaction.deserialize(Buffer.from(String(unsignedTransaction), "base64"));
    tx.sign([env.payerKeypair]);
    return Buffer.from(tx.serialize()).toString("base64");
  };

  it("replaces the one-shot tool: the hosted server never signs", () => {
    const names = (dependencies?: Parameters<typeof collectTools>[0]) => collectTools(dependencies).map((tool) => tool.name);
    expect(names()).toContain("execute_x402_round");
    expect(names()).not.toContain("prepare_x402_round");
    expect(names({ hosted: {} })).toEqual(expect.arrayContaining(["prepare_x402_round", "execute_x402_round"]));
    const execute = collectTools({ hosted: {} }).find((tool) => tool.name === "execute_x402_round")!;
    expect(Object.keys(execute.config.inputSchema).sort()).toEqual(["challenge", "signedTransaction"]);
  });

  it("prepares an unsigned payment, then runs the round once the caller's wallet has signed it", async () => {
    const env = await setup({ caps: { dailyCapsEnabled: false } });

    const prepared = await callTool("prepare_x402_round", args(env), hosted(env));

    expect(prepared).toMatchObject({
      payment: "x402",
      summary: {
        amountAtomicUsdc: String(PRICE),
        mint: env.mint,
        payTo: env.treasuryOwner,
        payToAta: env.payToAta,
        payer: env.payer,
        payerAta: env.payerAta,
        feePayer: env.feePayer,
        memo: env.memo,
        network: NETWORK,
        gateway: { endpoint: env.endpoint, pda: env.gatewayPda },
        sourceId: `0x${sourceId}`
      },
      payerBalanceAtomicUsdc: "5000000",
      lastValidBlockHeight: 100
    });
    expect(prepared.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(prepared.expiresAt).toBeLessThanOrEqual(Date.now() / 1000 + 60);
    expect(env.payments).toHaveLength(0);

    const live = await callTool(
      "execute_x402_round",
      { challenge: prepared.challenge, signedTransaction: sign(env, prepared.unsignedTransaction) },
      hosted(env)
    );

    expect(live).toMatchObject({
      payment: "x402",
      value: "42",
      dataUpdate: { sourceId: `0x${sourceId}`, registryVersion: 3, signaturesRequired: 2 },
      verifierArgs: { evm: { args: {} } },
      paymentReceipt: { payer: env.payer, payTo: env.treasuryOwner, amountAtomicUsdc: String(PRICE), transaction: SETTLEMENT_TX }
    });
    expect(env.quotes).toHaveLength(1);
    expect(env.payments).toHaveLength(1);
  });

  it("is unavailable, rather than insecure, without a challenge secret", async () => {
    const env = await setup();

    expect(await callToolError("prepare_x402_round", args(env), hosted(env, null))).toMatchObject({ code: "missing_config" });
    expect(
      await callToolError("execute_x402_round", { challenge: "mc1.x.y.z", signedTransaction: "AA==" }, hosted(env, null))
    ).toMatchObject({ code: "missing_config" });
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("sends nothing for a challenge this server did not seal", async () => {
    const env = await setup();
    const prepared = await callTool("prepare_x402_round", args(env), hosted(env));
    const signedTransaction = sign(env, prepared.unsignedTransaction);
    const otherKeys = loadChallengeKeys({ MOLPHA_HTTP_CHALLENGE_SECRET: "6b".repeat(32) })!;

    for (const challenge of [
      `${String(prepared.challenge).slice(0, -2)}AA`,
      sealChallenge(otherKeys, "x402", { round: { endpoint: "http://attacker.test" }, chains: ["evm"] }, Date.now() / 1000 + 60),
      sealChallenge(challengeKeys, "submit", {}, Date.now() / 1000 + 60)
    ]) {
      expect(await callToolError("execute_x402_round", { challenge, signedTransaction }, hosted(env))).toMatchObject({
        code: "invalid_challenge"
      });
    }
    expect(env.payments).toHaveLength(0);
  });

  it("answers payment_expired once the challenge or its blockhash has lapsed", async () => {
    const env = await setup();
    const prepared = await callTool("prepare_x402_round", args(env), hosted(env));
    const call = { challenge: prepared.challenge, signedTransaction: sign(env, prepared.unsignedTransaction) };

    env.connection.getBlockHeight.mockResolvedValueOnce(101);
    expect(await callToolError("execute_x402_round", call, hosted(env))).toMatchObject({ code: "payment_expired" });

    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
    try {
      expect(await callToolError("execute_x402_round", call, hosted(env))).toMatchObject({ code: "payment_expired" });
    } finally {
      vi.useRealTimers();
    }
    expect(env.payments).toHaveLength(0);
  });

  it.each([
    ["the unsigned transaction", (_env: Env, unsigned: string) => unsigned],
    ["something that is not a transaction", () => Buffer.from("not a transaction").toString("base64")],
    [
      "the transaction signed by another wallet",
      (_env: Env, unsigned: string) => {
        const tx = VersionedTransaction.deserialize(Buffer.from(unsigned, "base64"));
        tx.signatures[1] = Keypair.generate().secretKey.slice(0, 64);
        return Buffer.from(tx.serialize()).toString("base64");
      }
    ]
  ])("sends nothing for %s", async (_label, forge) => {
    const env = await setup();
    const prepared = await callTool("prepare_x402_round", args(env), hosted(env));

    expect(
      await callToolError(
        "execute_x402_round",
        { challenge: prepared.challenge, signedTransaction: forge(env, String(prepared.unsignedTransaction)) },
        hosted(env)
      )
    ).toMatchObject({ code: "signed_transaction_mismatch" });
    expect(env.payments).toHaveLength(0);
  });

  it("lets the gateway refuse a second round on one payment", async () => {
    const env = await setup({
      gateway: { onPaid: (attempt) => (attempt === 1 ? undefined : jsonResponse(409, { error: "round or payment already reserved" })) }
    });
    const prepared = await callTool("prepare_x402_round", args(env), hosted(env));
    const call = { challenge: prepared.challenge, signedTransaction: sign(env, prepared.unsignedTransaction) };

    await callTool("execute_x402_round", call, hosted(env));
    expect(await callToolError("execute_x402_round", call, hosted(env))).toMatchObject({ code: "round_conflict", status: 409 });
  });
});
