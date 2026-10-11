/**
 * x402 pay-per-request client for `POST /v1/x402/execute` and
 * `GET /v1/x402/status`. The SDK only covers the subscription round path, so
 * this talks to the gateway directly.
 *
 * A round is first requested without payment; the gateway answers 402 with
 * x402 `exact` Solana requirements. Those are untrusted: payTo, asset,
 * amount, network, and memo must equal what this server derives from its own
 * config and chain reads (see x402-payment.ts) before a payment is built. The
 * payment is a USDC transfer to the protocol treasury (the ProtocolConfig PDA's
 * token account), fee-sponsored by the gateway's facilitator and signed only by
 * the payer: this server's signer in stdio mode, the caller's own wallet in
 * hosted mode. The request is then repeated with the payment in
 * `PAYMENT-SIGNATURE`. The gateway verifies the payment before dispatch and
 * settles it before it returns data.
 */
import { setTimeout as delay } from "node:timers/promises";
import { address, getBase58Decoder, type Address } from "@solana/kit";
import type { Connection, VersionedTransaction } from "@solana/web3.js";
import { assertToleranceQuorum, canonicalizeApiConfig, deriveSourceId, type ApiConfigLike } from "./apiconfig.js";
import { getMolphaProgramId, requireMethod, type RequestLifecycle } from "./clients.js";
import { formatUsdcAtomic, type MolphaConfig } from "./config.js";
import {
  checkX402PerRoundCap,
  checkX402SpendCap,
  recordX402Spend,
  withX402DailySpendSerialization,
  x402SpentToday
} from "./guardrails.js";
import { normalizeSourceId } from "./hex.js";
import { ROUND_TICK_MS } from "./protocol.js";
import { readRoundResponse } from "./round-response.js";
import type { MolphaSigner } from "./signer/types.js";
import { parseSolanaPubkey } from "./solana-address.js";
import {
  assertSignedPayment,
  buildPaymentTransaction,
  computeX402Price,
  paymentMessageSha256,
  readPaymentAccounts,
  readX402Pricing,
  signPaymentTransaction,
  verifyPaymentRequirements,
  x402RequestMemo,
  type PaymentAccounts,
  type VerifiedPayment,
  type X402PaymentRequirements,
  type X402Pricing
} from "./x402-payment.js";

/** Jitter added to one round tick before repeating a request the gateway answered with 409, in ms. */
const CONFLICT_JITTER_MS = 20;

/**
 * How long to wait before repeating a request the gateway answered with 409. A 409 means this
 * payer (or consumer) already has a round for the feed in the current tick. The wait is one full
 * tick, which lands the retry in a later tick whatever the offset between this clock and the
 * gateway's, so no tick boundary is computed here. The jitter spreads requests that collided.
 */
export function conflictRetryDelayMs(random: () => number = Math.random): number {
  return ROUND_TICK_MS + random() * CONFLICT_JITTER_MS;
}

export interface X402RoundOptions {
  apiConfig: ApiConfigLike;
  signaturesRequired: number;
  /** When set, must match the sourceId derived from apiConfig. */
  sourceId?: string | undefined;
  /** Accepted for symmetry with the subscription path; x402 rounds always run fresh. */
  maxAge?: number | undefined;
}

export interface X402RoundContext {
  lifecycle?: RequestLifecycle;
  config: MolphaConfig;
  connection: Pick<Connection, "getAccountInfo" | "getMultipleAccountsInfo" | "getGenesisHash" | "getLatestBlockhash">;
  solana: Record<string, unknown>;
  gateway: Record<string, unknown>;
}

/** A round context that signs its own payment (stdio mode). */
export interface X402SignerContext extends X402RoundContext {
  signer: MolphaSigner;
}

/**
 * A verified, payable round: everything the paid request needs once the payer
 * has signed the transaction `messageSha256` names. Plain JSON, so a hosted
 * server can hand it to the caller inside a MAC'd challenge instead of keeping it.
 */
export interface X402PaidRound {
  endpoint: string;
  network: string;
  gatewayPda: Address;
  payer: Address;
  feePayer: Address;
  payTo: Address;
  asset: Address;
  amountAtomicUsdc: string;
  memo: string;
  /** The offer to echo as the payload's `accepted`, exactly as the gateway made it. */
  accepted: X402PaymentRequirements;
  resource?: Record<string, string>;
  /** The execute request body, resent unchanged with the payment. */
  body: Record<string, unknown>;
  /** Bare lowercase hex. */
  sourceId: string;
  signaturesRequired: number;
  registryVersion: number;
  /** Hex SHA-256 of the unsigned payment transaction's message. */
  messageSha256: string;
  /** The payment's blockhash expires after this block height. */
  lastValidBlockHeight: number;
}

export interface PreparedX402Round {
  round: X402PaidRound;
  /** The unsigned payment; the payer signs it and nothing else, and does not broadcast it. */
  transaction: VersionedTransaction;
  payerAta: Address;
  payToAta: Address;
  payerBalanceAtomicUsdc: string;
}

export interface X402PaymentReceipt {
  endpoint: string;
  network: string;
  payer: Address;
  payTo: Address;
  asset: Address;
  amountAtomicUsdc: string;
  feePayer: Address;
  memo: string;
  /** Settlement transaction from the gateway's PAYMENT-RESPONSE, when sent. */
  transaction?: string;
}

export interface X402RoundResult {
  /** The gateway's signed aggregate, in the shape buildRoundResult consumes. */
  result: Record<string, unknown>;
  payment: X402PaymentReceipt;
}

/** The gateway refused the payment before anything settled. */
export class X402PaymentRequiredError extends Error {
  readonly status = 402;
  readonly x402: unknown;

  constructor(message: string, x402: unknown) {
    super(message);
    this.name = "X402PaymentRequiredError";
    this.x402 = x402;
  }
}

export interface X402Reconciliation {
  endpoint: string;
  payer: Address;
  payTo: Address;
  asset: Address;
  amountAtomicUsdc: string;
  /** Commits to the request, not to one round: several payments can carry the same memo. */
  memo: string;
  sourceId: string;
  /**
   * The payer's signature on the payment transaction, base58. It is the transaction's second
   * signature; the transaction id is the facilitator's.
   */
  payerSignature: string;
  /** Past this block height the payment can no longer settle. */
  lastValidBlockHeight: number;
  httpStatus?: number;
  gatewayMessage?: string;
}

/** A payment was sent and the gateway's answer does not say whether it settled. */
export class X402PaymentOutcomeUnknownError extends Error {
  readonly reconciliation: X402Reconciliation;

  constructor(message: string, reconciliation: X402Reconciliation) {
    super(message);
    this.name = "X402PaymentOutcomeUnknownError";
    this.reconciliation = reconciliation;
  }
}

/**
 * The gateway's advisory `GET /v1/x402/status`. Payments go to the protocol
 * treasury (`payTo`, the ProtocolConfig PDA; `treasuryAta` is its USDC account),
 * not to the gateway, so the gateway holds no float for callers to cover.
 */
export interface X402GatewayStatus {
  gateway: string;
  authority: string;
  payTo: string;
  treasuryAta: string;
  quotedNextPrice: string;
  /** Rounds the gateway still owes an on-chain `submit_ticket` for. */
  pendingTickets: number;
}

export async function fetchX402Status(
  config: MolphaConfig,
  signaturesRequired?: number,
  signal?: AbortSignal
): Promise<{ endpoint: string; status: X402GatewayStatus }> {
  const query = signaturesRequired === undefined ? "" : `?signatures_required=${signaturesRequired}`;
  let lastError = "no gateway endpoint configured";

  for (const endpoint of config.gatewayEndpoints) {
    let res: Response;
    try {
      res = await fetch(`${trimSlash(endpoint)}/v1/x402/status${query}`, { method: "GET", ...(signal ? { signal } : {}) });
    } catch (error) {
      lastError = `${endpoint}: ${errorMessage(error)}`;
      continue;
    }
    if (res.ok) {
      return { endpoint, status: parseGatewayStatus(await res.json()) };
    }
    const message = await readErrorMessage(res);
    if (res.status === 400) {
      throw Object.assign(new Error(`GET /v1/x402/status rejected: ${message}`), { status: 400 });
    }
    lastError = `${endpoint}: HTTP ${res.status}: ${message}`;
  }

  throw new Error(`GET /v1/x402/status failed on every gateway (${lastError})`);
}

/** Unsigned quote: no payer accounts, signature, payment, or attestation. */
export async function quoteX402Round(ctx: X402RoundContext, opts: X402RoundOptions): Promise<Record<string, unknown>> {
  ctx.lifecycle?.signal.throwIfAborted();
  const plan = await planRound(ctx, opts);
  const { endpoint, required } = await requestQuote(ctx.config.gatewayEndpoints, executeBody(plan), ctx.lifecycle?.signal);
  const envelope = asRecord(required);
  if (!envelope || !Array.isArray(envelope.accepts) || envelope.accepts.length === 0 || envelope.x402Version !== 2) {
    throw new Error("Invalid payment-required envelope");
  }
  // Exclude gateway diagnostic text/extensions: only the protocol quote is returned.
  const accepts = envelope.accepts.map(value => {
    const item = asRecord(value);
    if (!item || ["scheme", "network", "asset", "amount", "payTo"].some(key => typeof item[key] !== "string")) {
      throw new Error("Invalid payment requirements");
    }
    if (item.scheme !== "exact" || !/^solana:[1-9A-HJ-NP-Za-km-z]+$/.test(String(item.network)) || !/^\d+$/.test(String(item.amount))) {
      throw new Error("Unsupported payment requirements");
    }
    parseSolanaPubkey(String(item.asset), "quote asset");
    parseSolanaPubkey(String(item.payTo), "quote payTo");
    if (item.maxTimeoutSeconds !== undefined && (typeof item.maxTimeoutSeconds !== "number" || !Number.isInteger(item.maxTimeoutSeconds) || item.maxTimeoutSeconds <= 0)) {
      throw new Error("Invalid quote timeout");
    }
    const out: Record<string, unknown> = {};
    for (const key of ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds"]) {
      if (item[key] !== undefined) out[key] = item[key];
    }
    const extra = asRecord(item.extra);
    if (extra) {
      if (extra.feePayer !== undefined) parseSolanaPubkey(String(extra.feePayer), "quote feePayer");
      if (extra.memo !== undefined && (typeof extra.memo !== "string" || !/^[a-fA-F0-9]{64}$/.test(extra.memo))) throw new Error("Invalid quote memo");
      out.extra = Object.fromEntries(["feePayer", "memo"].filter(key => typeof extra[key] === "string").map(key => [key, extra[key]]));
    }
    return out;
  });
  return { payment: "x402", dryRun: true, quoteOnly: true, action: "execute_x402_round",
    sourceId: `0x${plan.sourceId}`, endpoint, paymentRequired: { x402Version: 2, accepts },
    note: "Unsigned gateway quote; no payer-specific verification, signature, payment, or attestation." };
}

/** Quotes and verifies a round's payment without signing or spending anything. */
export async function previewX402Round(
  ctx: X402SignerContext,
  opts: X402RoundOptions
): Promise<Record<string, unknown>> {
  ctx.lifecycle?.signal.throwIfAborted();
  const plan = await planRound(ctx, opts);
  const { endpoint, verified, accounts } = await preparePayment(ctx, plan, ctx.signer.publicKey);
  const shortfall = verified.amount > accounts.payerBalance ? verified.amount - accounts.payerBalance : 0n;

  return {
    dryRun: true,
    action: "execute_x402_round",
    sourceId: `0x${plan.sourceId}`,
    gateway: { endpoint, authority: accounts.authority, pda: accounts.gatewayPda },
    payTo: verified.payTo,
    network: plan.network,
    asset: verified.asset,
    priceAtomicUsdc: verified.amount.toString(),
    feePayer: verified.feePayer,
    memo: verified.memo,
    payer: ctx.signer.publicKey,
    payerUsdcAta: accounts.payerAta,
    payerBalanceAtomicUsdc: accounts.payerBalance.toString(),
    shortfallAtomicUsdc: shortfall.toString(),
    ...(ctx.config.x402.dailyCapsEnabled !== false ? { spentTodayAtomicUsdc: x402SpentToday().toString() } : {}),
    note:
      shortfall > 0n
        ? "The signer's USDC balance does not cover this round; a live call would refuse before signing."
        : "A live call would sign a USDC transfer of priceAtomicUsdc to the protocol treasury (network fee paid by feePayer) and then request the round."
  };
}

/** Pays for and runs one round, returning the signed aggregate and its payment receipt. */
export async function executeX402Round(ctx: X402SignerContext, opts: X402RoundOptions): Promise<X402RoundResult> {
  ctx.lifecycle?.signal.throwIfAborted();
  const plan = await planRound(ctx, opts);
  const dailyCapsEnabled = ctx.config.x402.dailyCapsEnabled !== false;

  const { round, signed } = await withX402DailySpendSerialization(dailyCapsEnabled, async () => {
    const prepared = await buildPayableRound(ctx, plan, ctx.signer.publicKey);
    ctx.lifecycle?.signal.throwIfAborted();
    const signedPayment = await signPaymentTransaction(ctx.signer, prepared.transaction, prepared.round.feePayer);
    ctx.lifecycle?.signal.throwIfAborted();
    if (dailyCapsEnabled) recordX402Spend(BigInt(prepared.round.amountAtomicUsdc));
    return { round: prepared.round, signed: signedPayment };
  });

  return submitPaidRound(ctx.lifecycle, round, signed);
}

/**
 * Quotes and verifies a round for `payer` and builds its unsigned payment.
 * Nothing is signed or spent: the payer signs the returned transaction with its
 * own wallet and hands it to {@link executePreparedX402Round}.
 */
export async function prepareX402Round(
  ctx: X402RoundContext,
  opts: X402RoundOptions,
  payer: Address
): Promise<PreparedX402Round> {
  ctx.lifecycle?.signal.throwIfAborted();
  return buildPayableRound(ctx, await planRound(ctx, opts), payer);
}

/**
 * Sends a prepared round's payment once its payer has signed it. `round` must be
 * exactly what {@link prepareX402Round} returned; a caller that takes it back from
 * outside this process authenticates it first.
 */
export async function executePreparedX402Round(
  ctx: Pick<X402RoundContext, "lifecycle" | "config">,
  round: X402PaidRound,
  signed: VersionedTransaction
): Promise<X402RoundResult> {
  ctx.lifecycle?.signal.throwIfAborted();
  if (!ctx.config.gatewayEndpoints.includes(round.endpoint)) {
    throw new Error(`x402 round was prepared for ${round.endpoint}, which is not a configured gateway endpoint`);
  }
  await assertSignedPayment({ messageSha256: round.messageSha256, feePayer: round.feePayer, payer: round.payer }, signed);

  const amount = BigInt(round.amountAtomicUsdc);
  const { maxPriceUsdcAtomic, maxSpendPerDayUsdcAtomic } = ctx.config.x402;
  const dailyCapsEnabled = ctx.config.x402.dailyCapsEnabled !== false;
  await withX402DailySpendSerialization(dailyCapsEnabled, async () => {
    if (dailyCapsEnabled) {
      checkX402SpendCap(amount, maxPriceUsdcAtomic, maxSpendPerDayUsdcAtomic);
      recordX402Spend(amount);
    } else {
      checkX402PerRoundCap(amount, maxPriceUsdcAtomic);
    }
  });

  return submitPaidRound(ctx.lifecycle, round, signed);
}

interface RoundPlan {
  apiConfig: Record<string, unknown>;
  /** Bare lowercase hex. */
  sourceId: string;
  sourceIdBytes: Uint8Array;
  signaturesRequired: number;
  registryVersion: number;
  network: string;
  programId: Address;
  pricing: X402Pricing;
  priceAtomic: bigint;
}

async function planRound(ctx: X402RoundContext, opts: X402RoundOptions): Promise<RoundPlan> {
  assertToleranceQuorum(opts.apiConfig, opts.signaturesRequired);
  const sourceId = normalizeSourceId(deriveSourceId(opts.apiConfig).sourceId);
  if (opts.sourceId !== undefined && normalizeSourceId(opts.sourceId) !== sourceId) {
    throw new Error(`sourceId does not match apiConfig: expected ${sourceId}, got ${opts.sourceId}`);
  }

  const programId = getMolphaProgramId();
  const [registry, network, pricing] = await Promise.all([
    requireMethod<[], Promise<{ registryVersion: number; redundancyBuffer: number; nodeCount: number }>>(
      ctx.solana,
      "getRegistrySelectionConfig"
    )(),
    clusterNetwork(ctx.connection),
    readX402Pricing(ctx.connection, programId)
  ]);

  const { signaturesRequired } = opts;
  if (signaturesRequired < pricing.minSigners) {
    throw new Error(`signaturesRequired ${signaturesRequired} is below the protocol min_signers ${pricing.minSigners}`);
  }
  if (signaturesRequired > registry.nodeCount) {
    throw new Error(
      `signaturesRequired ${signaturesRequired} exceeds the ${registry.nodeCount} nodes of registry version ${registry.registryVersion}`
    );
  }

  const priceAtomic = computeX402Price(pricing, signaturesRequired, registry.redundancyBuffer);
  // Refuse an over-cap round before contacting any gateway.
  checkX402PerRoundCap(priceAtomic, ctx.config.x402.maxPriceUsdcAtomic);

  return {
    apiConfig: canonicalizeApiConfig(opts.apiConfig),
    sourceId,
    sourceIdBytes: Buffer.from(sourceId, "hex"),
    signaturesRequired,
    registryVersion: registry.registryVersion,
    network,
    programId,
    pricing,
    priceAtomic
  };
}

interface PreparedPayment {
  endpoint: string;
  required: unknown;
  verified: VerifiedPayment;
  accounts: PaymentAccounts;
}

async function preparePayment(ctx: X402RoundContext, plan: RoundPlan, payer: Address): Promise<PreparedPayment> {
  const { endpoint, required } = await requestQuote(ctx.config.gatewayEndpoints, executeBody(plan), ctx.lifecycle?.signal);
  const authority = await gatewayAuthority(ctx, endpoint);
  const accounts = await readPaymentAccounts(ctx.connection, {
    programId: plan.programId,
    usdcMint: plan.pricing.usdcMint,
    payer,
    authority
  });

  const verified = verifyPaymentRequirements(required, {
    network: plan.network,
    payTo: accounts.payTo,
    asset: plan.pricing.usdcMint,
    amount: plan.priceAtomic,
    payer,
    memo: x402RequestMemo({
      programId: plan.programId,
      gatewayPda: accounts.gatewayPda,
      sourceId: plan.sourceIdBytes,
      signaturesRequired: plan.signaturesRequired,
      registryVersion: plan.registryVersion
    })
  });
  if (ctx.config.x402.dailyCapsEnabled !== false) {
    checkX402SpendCap(verified.amount, ctx.config.x402.maxPriceUsdcAtomic, ctx.config.x402.maxSpendPerDayUsdcAtomic);
  } else {
    checkX402PerRoundCap(verified.amount, ctx.config.x402.maxPriceUsdcAtomic);
  }

  return { endpoint, required, verified, accounts };
}

/** The verified quote as a payable round, with the unsigned transaction that pays for it. */
async function buildPayableRound(ctx: X402RoundContext, plan: RoundPlan, payer: Address): Promise<PreparedX402Round> {
  const { endpoint, required, verified, accounts } = await preparePayment(ctx, plan, payer);
  if (accounts.payerBalance < verified.amount) {
    throw new Error(
      `insufficient USDC for this x402 round: ${payer} holds ${formatUsdcAtomic(accounts.payerBalance)} USDC in ${accounts.payerAta}, the round costs ${formatUsdcAtomic(verified.amount)} USDC`
    );
  }

  const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash();
  const transaction = buildPaymentTransaction({
    payer,
    feePayer: verified.feePayer,
    payerAta: accounts.payerAta,
    payToAta: accounts.payToAta,
    mint: verified.asset,
    decimals: accounts.decimals,
    amount: verified.amount,
    memo: verified.memo,
    recentBlockhash: blockhash
  });
  const resource = describedResource(required);

  return {
    round: {
      endpoint,
      network: plan.network,
      gatewayPda: accounts.gatewayPda,
      payer,
      feePayer: verified.feePayer,
      payTo: verified.payTo,
      asset: verified.asset,
      amountAtomicUsdc: verified.amount.toString(),
      memo: verified.memo,
      accepted: verified.accepted,
      ...(resource ? { resource } : {}),
      body: executeBody(plan),
      sourceId: plan.sourceId,
      signaturesRequired: plan.signaturesRequired,
      registryVersion: plan.registryVersion,
      messageSha256: paymentMessageSha256(transaction),
      lastValidBlockHeight
    },
    transaction,
    payerAta: accounts.payerAta,
    payToAta: accounts.payToAta,
    payerBalanceAtomicUsdc: accounts.payerBalance.toString()
  };
}

/**
 * Posts the paid request and returns the round. From here on the payment may
 * settle, so the request's lifecycle carries what is needed to find it.
 */
async function submitPaidRound(
  lifecycle: RequestLifecycle | undefined,
  round: X402PaidRound,
  signed: VersionedTransaction
): Promise<X402RoundResult> {
  const paymentHeader = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      ...(round.resource ? { resource: round.resource } : {}),
      accepted: round.accepted,
      payload: { transaction: Buffer.from(signed.serialize()).toString("base64") }
    })
  ).toString("base64");
  const reconciliation: X402Reconciliation = {
    endpoint: round.endpoint,
    payer: round.payer,
    payTo: round.payTo,
    asset: round.asset,
    amountAtomicUsdc: round.amountAtomicUsdc,
    memo: round.memo,
    sourceId: round.sourceId,
    payerSignature: getBase58Decoder().decode(signed.signatures[1] ?? new Uint8Array(64)),
    lastValidBlockHeight: round.lastValidBlockHeight
  };
  if (lifecycle) {
    lifecycle.effectStarted = true;
    lifecycle.reconciliation = { ...reconciliation };
  }

  const startedAtMs = Date.now();
  let outcome = await postPaidExecute(round.endpoint, round.body, paymentHeader, lifecycle?.signal);
  if (outcome.kind === "conflict") {
    // The gateway reserves a payment and its round together and raises 409 at that step, before
    // any node is asked to work: nothing was reserved, so the payment is unspent. If this payer
    // already has a round for the feed in the current tick, the same payment authorizes a retry
    // one tick later. One retry only: a second 409 means the payer has a round in that tick too,
    // or the payment itself already reserved a round.
    await delay(conflictRetryDelayMs(), undefined, lifecycle ? { signal: lifecycle.signal } : undefined);
    outcome = await postPaidExecute(round.endpoint, round.body, paymentHeader, lifecycle?.signal);
  }

  if (outcome.kind === "ok") {
    return completeRound(round, outcome, startedAtMs);
  }
  throw paidOutcomeError(reconciliation, outcome);
}

type PaidOutcome =
  | { kind: "ok"; body: Record<string, unknown>; receipt: Record<string, unknown> | undefined }
  | { kind: "payment_rejected"; status: 402; message: string; required: unknown }
  | { kind: "rejected" | "conflict"; status: number; message: string }
  | { kind: "unknown"; status?: number; message: string };

/**
 * Only 400, 402, and 409 are raised before the gateway asks its facilitator to
 * settle. Any other answer, or none, can follow a settled payment.
 *
 * The same payment is resent only after a 409, which is raised before anything is
 * reserved. Once the gateway has asked the nodes to work, the payment authorization is
 * spent even when the round fails (too few nodes accepted it, a timeout, a paywalled
 * source), so every other retry is a new call that signs a new payment. A 503 from the
 * gateway's own capacity limit is answered before the request is read and spends nothing,
 * but a status alone does not tell it from a 503 after dispatch, so it is not resent either.
 */
async function postPaidExecute(
  endpoint: string,
  body: Record<string, unknown>,
  paymentHeader: string,
  signal?: AbortSignal
): Promise<PaidOutcome> {
  let res: Response;
  try {
    res = await postExecute(endpoint, body, paymentHeader, signal);
  } catch (error) {
    return { kind: "unknown", message: errorMessage(error) };
  }

  if (res.status === 200) {
    try {
      return { kind: "ok", body: asRecord(await res.json()) ?? {}, receipt: decodeHeader(res.headers.get("PAYMENT-RESPONSE")) };
    } catch (error) {
      return { kind: "unknown", status: 200, message: `unreadable response: ${errorMessage(error)}` };
    }
  }
  if (res.status === 402) {
    const required = await readPaymentRequired(res);
    const reason = asRecord(required)?.error;
    return { kind: "payment_rejected", status: 402, message: typeof reason === "string" && reason ? reason : "payment rejected", required };
  }

  const message = await readErrorMessage(res);
  if (res.status === 409) {
    return { kind: "conflict", status: 409, message };
  }
  if (res.status === 400) {
    return { kind: "rejected", status: 400, message };
  }
  return { kind: "unknown", status: res.status, message };
}

function paidOutcomeError(reconciliation: X402Reconciliation, outcome: Exclude<PaidOutcome, { kind: "ok" }>): Error {
  switch (outcome.kind) {
    case "payment_rejected":
      return new X402PaymentRequiredError(`x402 payment rejected by the gateway: ${outcome.message}`, outcome.required);
    case "rejected":
      return Object.assign(new Error(`x402 execute rejected: ${outcome.message}`), { status: 400 });
    case "conflict":
      return Object.assign(
        new Error(
          `the gateway refused this x402 payment twice as a duplicate (${outcome.message}): this payer already has a round for the feed in each ${ROUND_TICK_MS} ms tick it was sent in, or the payment already reserved a round and cannot pay for another, so a new round needs a new payment`
        ),
        { status: 409 }
      );
    case "unknown": {
      const response = outcome.status === undefined ? "no response" : `HTTP ${outcome.status}`;
      return new X402PaymentOutcomeUnknownError(
        `x402 round failed after its payment was sent (${response}: ${outcome.message}); the payment may have settled`,
        {
          ...reconciliation,
          ...(outcome.status !== undefined ? { httpStatus: outcome.status } : {}),
          gatewayMessage: outcome.message
        }
      );
    }
  }
}

function completeRound(
  round: X402PaidRound,
  outcome: Extract<PaidOutcome, { kind: "ok" }>,
  startedAtMs: number
): X402RoundResult {
  const transaction = outcome.receipt?.transaction;
  const receipt: X402PaymentReceipt = {
    endpoint: round.endpoint,
    network: round.network,
    payer: round.payer,
    payTo: round.payTo,
    asset: round.asset,
    amountAtomicUsdc: round.amountAtomicUsdc,
    feePayer: round.feePayer,
    memo: round.memo,
    ...(typeof transaction === "string" && transaction ? { transaction } : {})
  };

  const { matches, result } = readRoundResponse(
    outcome.body,
    { sourceId: round.sourceId, registryVersion: round.registryVersion, signaturesRequired: round.signaturesRequired },
    startedAtMs
  );
  if (!matches) {
    // Paid for by now: report the settled payment instead of returning a foreign aggregate.
    throw new Error(
      `the gateway settled x402 payment ${receipt.transaction ?? `(memo ${receipt.memo})`} but returned an aggregate for a different round (sourceId ${String(result.sourceId)}, timestamp ${String(result.timestamp)})`
    );
  }

  return { result, payment: receipt };
}

/** The first endpoint that quotes the round; the paid request goes to that endpoint only. */
async function requestQuote(
  endpoints: string[],
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ endpoint: string; required: unknown }> {
  let lastError = "no gateway endpoint configured";

  for (const endpoint of endpoints) {
    let res: Response;
    try {
      signal?.throwIfAborted();
      res = await postExecute(endpoint, body, undefined, signal);
    } catch (error) {
      lastError = `${endpoint}: ${errorMessage(error)}`;
      continue;
    }
    if (res.status === 402) {
      return { endpoint, required: await readPaymentRequired(res) };
    }
    const message = await readErrorMessage(res);
    if (res.status === 400) {
      // Stale registry version, clock skew, malformed apiConfig: every gateway agrees.
      throw Object.assign(new Error(`x402 execute rejected: ${message}`), { status: 400 });
    }
    lastError = `${endpoint}: HTTP ${res.status}: ${message}`;
  }

  throw new Error(`no gateway returned an x402 payment quote (${lastError})`);
}

// Cache only public resolved addresses, never promises closing over request clients.
const discoveredAuthorities = new Map<string, Address>();

/** The authority whose Gateway PDA an endpoint serves: pinned in config, else read once from its `GET /v1/info`. */
export async function gatewayAuthority(
  ctx: Pick<X402RoundContext, "config" | "gateway">,
  endpoint: string
): Promise<Address> {
  const pinned = ctx.config.gatewayAuthorities[ctx.config.gatewayEndpoints.indexOf(endpoint)];
  if (pinned) return address(pinned);
  const cached = discoveredAuthorities.get(endpoint);
  if (cached) return cached;
  const info = await requireMethod<[string], Promise<{ gatewayAuthority: string }>>(ctx.gateway, "fetchGatewayInfo")(endpoint);
  const authority = parseSolanaPubkey(info.gatewayAuthority, "gateway authority");
  discoveredAuthorities.set(endpoint, authority);
  return authority;
}

const clusterNetworks = new WeakMap<object, Promise<string>>();

/** CAIP-2 id of the SOLANA_RPC cluster: `solana:` + the first 32 chars of its genesis hash. */
export function clusterNetwork(connection: Pick<Connection, "getGenesisHash">): Promise<string> {
  let pending = clusterNetworks.get(connection);
  if (!pending) {
    pending = connection.getGenesisHash().then((hash) => `solana:${hash.slice(0, 32)}`);
    pending.catch(() => clusterNetworks.delete(connection));
    clusterNetworks.set(connection, pending);
  }
  return pending;
}

/** The gateway assigns the round's timestamp; a caller sends none. */
function executeBody(plan: RoundPlan): Record<string, unknown> {
  return {
    signatures_required: plan.signaturesRequired,
    registry_version: plan.registryVersion,
    apiConfig: plan.apiConfig
  };
}

function postExecute(endpoint: string, body: Record<string, unknown>, paymentHeader?: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${trimSlash(endpoint)}/v1/x402/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(paymentHeader ? { "PAYMENT-SIGNATURE": paymentHeader } : {})
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {})
  });
}

/** The PAYMENT-REQUIRED header is canonical; the body carries the same object. */
async function readPaymentRequired(res: Response): Promise<unknown> {
  const fromHeader = decodeHeader(res.headers.get("PAYMENT-REQUIRED"));
  if (fromHeader) {
    return fromHeader;
  }
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function decodeHeader(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(Buffer.from(value, "base64").toString("utf8")));
  } catch {
    return undefined;
  }
}

/** The 402's resource description, echoed in the payload; descriptive only. */
function describedResource(required: unknown): Record<string, string> | undefined {
  const resource = asRecord(asRecord(required)?.resource);
  if (typeof resource?.url !== "string") {
    return undefined;
  }
  const out: Record<string, string> = { url: resource.url };
  for (const field of ["description", "mimeType"]) {
    const value = resource[field];
    if (typeof value === "string") out[field] = value;
  }
  return out;
}

function parseGatewayStatus(raw: unknown): X402GatewayStatus {
  const record = asRecord(raw) ?? {};
  const text = (field: string): string => {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`GET /v1/x402/status returned a malformed ${field}`);
    }
    return value;
  };
  const quotedNextPrice = text("quotedNextPrice");
  if (!/^\d+$/.test(quotedNextPrice)) {
    throw new Error("GET /v1/x402/status returned a malformed quotedNextPrice");
  }
  const pendingTickets = record.pendingTickets;
  if (typeof pendingTickets !== "number" || !Number.isInteger(pendingTickets) || pendingTickets < 0) {
    throw new Error("GET /v1/x402/status returned a malformed pendingTickets");
  }

  return {
    gateway: text("gateway"),
    authority: text("authority"),
    payTo: text("payTo"),
    treasuryAta: text("treasuryAta"),
    quotedNextPrice,
    pendingTickets
  };
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    if (!text) return `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const message = parsed.error ?? parsed.message ?? parsed.detail;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {
      // fall back to raw body
    }
    return text;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimSlash(endpoint: string): string {
  return endpoint.replace(/\/$/, "");
}
