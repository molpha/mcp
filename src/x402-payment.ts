/**
 * x402 `exact` Solana payment primitives for a paid round: the protocol
 * price and request memo this server derives on its own, verification of a
 * gateway's untrusted 402 requirements against them, the on-chain accounts the
 * payment touches, and the payment transaction, unsigned and then checked once
 * its payer has signed it.
 */
import { BorshAccountsCoder, type Idl } from "@anchor-lang/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  address,
  createNoopSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getPublicKeyFromAddress,
  signatureBytes,
  verifySignature,
  type Address,
  type Instruction
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getMintDecoder,
  getTokenDecoder,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token";
import type { AccountInfo, Connection, VersionedTransaction } from "@solana/web3.js";
import { exactBytes } from "./bytes.js";
import { getMolphaProgramId } from "./clients.js";
import { requireSdkExport } from "./sdk.js";
import { toLegacyPublicKey, toLegacyV0Transaction } from "./solana-compat.js";
import type { MolphaSigner } from "./signer/types.js";

const COMPUTE_BUDGET_PROGRAM_ADDRESS = address("ComputeBudget111111111111111111111111111111");
const MEMO_PROGRAM_ADDRESS = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/**
 * The facilitator pays the fee, so ask for little: a TransferChecked plus a
 * 64-byte memo stays well under this limit, and 1 microlamport per CU is far
 * below the scheme's 5 lamports/CU bound.
 */
export const PAYMENT_COMPUTE_UNIT_LIMIT = 40_000;
export const PAYMENT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1n;
const U64_MAX = (1n << 64n) - 1n;

/** One `accepts` entry of an x402 402 body. */
export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, string>;
}

/** What a round's payment must be, derived without trusting the 402. */
export interface ExpectedPayment {
  /** CAIP-2 id of the SOLANA_RPC cluster. */
  network: string;
  /**
   * The protocol treasury: the ProtocolConfig PDA that owns the USDC treasury account. Income is
   * booked from there into epoch pools, so a payment to the gateway authority would never be
   * recognized.
   */
  payTo: Address;
  /** ProtocolConfig `usdc_mint`. */
  asset: Address;
  /** Protocol round price in USDC base units. */
  amount: bigint;
  /** {@link x402RequestMemo} for this request. */
  memo: string;
  /** The paying wallet; it must never be asked to sponsor the fee. */
  payer: Address;
}

export interface VerifiedPayment {
  /** The requirements to echo as the payload's `accepted`, exactly as offered. */
  accepted: X402PaymentRequirements;
  amount: bigint;
  payTo: Address;
  asset: Address;
  feePayer: Address;
  memo: string;
}

/** The ProtocolConfig fields the x402 price and payment depend on. */
export interface X402Pricing {
  usdcMint: Address;
  x402RoundBase: bigint;
  rewardPerSignature: bigint;
  minSigners: number;
}

/**
 * Mirrors `settle_x402_round::compute_x402_price`: the whole selection is paid
 * for, redundancy buffer included.
 */
export function computeX402Price(
  pricing: Pick<X402Pricing, "x402RoundBase" | "rewardPerSignature">,
  signaturesRequired: number,
  redundancyBuffer: number
): bigint {
  const price =
    pricing.x402RoundBase + BigInt(signaturesRequired + redundancyBuffer) * pricing.rewardPerSignature;
  if (price > U64_MAX) {
    throw new Error("x402 round price overflows u64");
  }
  return price;
}

export interface RequestMemoParams {
  programId: Address;
  gatewayPda: Address;
  /** 32-byte sourceId; also the API-config hash the gateway commits to. */
  sourceId: Uint8Array;
  signaturesRequired: number;
  registryVersion: number;
}

/**
 * The gateway's `extra.memo`, which binds the payment to one deployment,
 * gateway, source, quorum, and registry version:
 *
 *   keccak256("MOLPHA_X402_REQUEST_V1" || programId || gatewayPda || sourceId
 *             || quorum u8 || registryVersion u32be)
 *
 * It names no round: the gateway assigns the round's timestamp after it has
 * verified the payment. Checking it keeps a relaying endpoint from getting a
 * payer to pay for a different request.
 */
export function x402RequestMemo(params: RequestMemoParams): string {
  if (params.sourceId.length !== 32) {
    throw new Error(`sourceId must be 32 bytes, got ${params.sourceId.length}`);
  }
  const encoder = getAddressEncoder();
  const sizes = Buffer.alloc(5);
  sizes.writeUInt8(params.signaturesRequired, 0);
  sizes.writeUInt32BE(params.registryVersion, 1);

  return Buffer.from(
    keccak_256(
      Buffer.concat([
        Buffer.from("MOLPHA_X402_REQUEST_V1", "utf8"),
        Buffer.from(encoder.encode(params.programId)),
        Buffer.from(encoder.encode(params.gatewayPda)),
        params.sourceId,
        sizes
      ])
    )
  ).toString("hex");
}

/** `["molpha_gateway", authority]`: the Gateway account an authority registers. */
export async function deriveGatewayPda(authority: Address, programId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [Buffer.from("molpha_gateway"), Buffer.from(getAddressEncoder().encode(authority))]
  });
  return pda;
}

/** `["molpha_config"]`: ProtocolConfig, which owns the treasury ATA that x402 pays. */
export async function deriveProtocolConfigPda(programId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: programId, seeds: [Buffer.from("molpha_config")] });
  return pda;
}

/**
 * Treats the gateway's 402 body as untrusted: the `exact` offer for this
 * cluster must name exactly the payTo, asset, amount, and memo this server
 * derived, and a facilitator fee payer other than this signer, before anything
 * is signed.
 */
export function verifyPaymentRequirements(required: unknown, expected: ExpectedPayment): VerifiedPayment {
  const body = asRecord(required);
  if (body?.x402Version !== 2) {
    throw new Error(`x402 402 response has an unsupported x402Version (${JSON.stringify(body?.x402Version)}), expected 2`);
  }

  const offers = (Array.isArray(body.accepts) ? body.accepts : [])
    .map(asRecord)
    .filter((offer): offer is Record<string, unknown> => offer !== undefined);
  const offer = offers.find((entry) => entry.scheme === "exact" && entry.network === expected.network);
  if (!offer) {
    const offered = offers.map((entry) => `${String(entry.scheme)} on ${String(entry.network)}`).join(", ");
    throw new Error(
      `x402 402 response offers no "exact" payment on ${expected.network} (the SOLANA_RPC cluster); it offers ${offered || "nothing"}`
    );
  }

  const accepted: X402PaymentRequirements = {
    scheme: "exact",
    network: expected.network,
    amount: requireString(offer.amount, "amount"),
    asset: requireString(offer.asset, "asset"),
    payTo: requireString(offer.payTo, "payTo"),
    maxTimeoutSeconds: requirePositiveInteger(offer.maxTimeoutSeconds, "maxTimeoutSeconds"),
    extra: requireStringMap(offer.extra, "extra")
  };

  if (accepted.payTo !== expected.payTo) {
    throw mismatch("payTo", accepted.payTo, `the protocol treasury ${expected.payTo}`);
  }
  if (accepted.asset !== expected.asset) {
    throw mismatch("asset", accepted.asset, `the protocol USDC mint ${expected.asset}`);
  }
  if (!/^\d+$/.test(accepted.amount) || BigInt(accepted.amount) !== expected.amount) {
    throw mismatch("amount", accepted.amount, `the protocol round price ${expected.amount}`);
  }

  const feePayer = parseAddress(accepted.extra.feePayer, "extra.feePayer");
  if (feePayer === expected.payer) {
    throw new Error(
      "x402 402 response names the payer as extra.feePayer; the facilitator must sponsor the fee. Refusing to sign."
    );
  }
  if (accepted.extra.memo !== expected.memo) {
    throw mismatch("extra.memo", String(accepted.extra.memo), `this request's commitment ${expected.memo}`);
  }

  return {
    accepted,
    amount: expected.amount,
    payTo: expected.payTo,
    asset: expected.asset,
    feePayer,
    memo: expected.memo
  };
}

let accountsCoder: BorshAccountsCoder | undefined;

function programAccounts(): BorshAccountsCoder {
  accountsCoder ??= new BorshAccountsCoder(requireSdkExport<Idl>("MOLPHA_IDL"));
  return accountsCoder;
}

/** Decodes a Molpha program account by its IDL name, refusing one the program does not own. */
export function decodeProgramAccount<T>(info: AccountInfo<Buffer>, name: string, account: Address, programId: Address): T {
  if (info.owner.toBase58() !== programId) {
    throw new Error(`${name} account ${account} is not owned by the Molpha program ${programId}`);
  }
  return programAccounts().decode(name, info.data) as T;
}

/** ProtocolConfig's USDC mint and x402 price inputs. */
export async function readX402Pricing(
  connection: Pick<Connection, "getAccountInfo">,
  programId: Address
): Promise<X402Pricing> {
  const pda = await deriveProtocolConfigPda(programId);
  const info = await connection.getAccountInfo(toLegacyPublicKey(pda));
  if (!info) {
    throw new Error(`ProtocolConfig ${pda} not found — is SOLANA_RPC on the Molpha program's cluster?`);
  }
  const config = decodeProgramAccount<{
    usdc_mint: { toBase58(): string };
    x402_round_base: { toString(): string };
    reward_per_signature: { toString(): string };
    min_signers: number;
  }>(info, "ProtocolConfig", pda, programId);

  return {
    usdcMint: address(config.usdc_mint.toBase58()),
    x402RoundBase: BigInt(config.x402_round_base.toString()),
    rewardPerSignature: BigInt(config.reward_per_signature.toString()),
    minSigners: config.min_signers
  };
}

/** A USDC token account's balance; `undefined` when the account does not exist. */
export function readTokenAmount(
  info: AccountInfo<Buffer> | null | undefined,
  mint: Address,
  owner: Address
): bigint | undefined {
  if (!info) {
    return undefined;
  }
  if (info.owner.toBase58() !== TOKEN_PROGRAM_ADDRESS) {
    throw new Error(`USDC account of ${owner} is not owned by the SPL Token program`);
  }
  const token = getTokenDecoder().decode(info.data);
  if (token.mint !== mint || token.owner !== owner) {
    throw new Error(`token account does not hold ${mint} for ${owner}`);
  }
  return token.amount;
}

/** A payer's USDC associated token account and balance. */
export async function readPayerUsdc(
  connection: Pick<Connection, "getAccountInfo">,
  payer: Address
): Promise<{ usdcMint: Address; ata: Address; exists: boolean; balanceAtomicUsdc: string }> {
  const { usdcMint } = await readX402Pricing(connection, getMolphaProgramId());
  const [ata] = await findAssociatedTokenPda({ owner: payer, mint: usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const balance = readTokenAmount(await connection.getAccountInfo(toLegacyPublicKey(ata)), usdcMint, payer);
  return { usdcMint, ata, exists: balance !== undefined, balanceAtomicUsdc: (balance ?? 0n).toString() };
}

export interface PaymentAccounts {
  /** The gateway authority the round is requested from (Active on-chain). */
  authority: Address;
  gatewayPda: Address;
  decimals: number;
  payerAta: Address;
  /** 0 when the payer has no USDC account yet. */
  payerBalance: bigint;
  /** The treasury owner (ProtocolConfig PDA): the 402's `payTo`. */
  payTo: Address;
  /** The treasury's USDC associated token account. */
  payToAta: Address;
}

/**
 * The accounts a payment touches, in one RPC call, addressed only from trusted
 * inputs: the program id, ProtocolConfig's mint and the gateway authority
 * (configured, or discovered). The payment goes to the protocol treasury, never
 * to the gateway; the authority must still own an Active Gateway account, so an
 * unpinned endpoint cannot make this server pay for rounds from an unregistered
 * gateway.
 */
export async function readPaymentAccounts(
  connection: Pick<Connection, "getMultipleAccountsInfo">,
  args: { programId: Address; usdcMint: Address; payer: Address; authority: Address }
): Promise<PaymentAccounts> {
  const tokenProgram = TOKEN_PROGRAM_ADDRESS;
  const [gatewayPda, payTo, [payerAta]] = await Promise.all([
    deriveGatewayPda(args.authority, args.programId),
    deriveProtocolConfigPda(args.programId),
    findAssociatedTokenPda({ owner: args.payer, mint: args.usdcMint, tokenProgram })
  ]);
  const [payToAta] = await findAssociatedTokenPda({ owner: payTo, mint: args.usdcMint, tokenProgram });
  const [mintInfo, gatewayInfo, payerInfo, payToInfo] = await connection.getMultipleAccountsInfo(
    [args.usdcMint, gatewayPda, payerAta, payToAta].map(toLegacyPublicKey)
  );

  if (!mintInfo || mintInfo.owner.toBase58() !== tokenProgram) {
    throw new Error(`protocol USDC mint ${args.usdcMint} is missing or is not an SPL Token mint`);
  }
  const { decimals } = getMintDecoder().decode(mintInfo.data);

  if (!gatewayInfo) {
    throw new Error(
      `${args.authority} has no registered Molpha gateway (no Gateway account ${gatewayPda}); refusing to pay it`
    );
  }
  const gateway = decodeProgramAccount<{ authority: { toBase58(): string }; status: Record<string, unknown> }>(
    gatewayInfo,
    "Gateway",
    gatewayPda,
    args.programId
  );
  const status = Object.keys(gateway.status)[0];
  if (gateway.authority.toBase58() !== args.authority || status?.toLowerCase() !== "active") {
    throw new Error(
      `Gateway ${gatewayPda} is not an Active gateway of ${args.authority} (status ${status ?? "unknown"}); refusing to pay it`
    );
  }

  if (readTokenAmount(payToInfo, args.usdcMint, payTo) === undefined) {
    throw new Error(`the protocol treasury ${payTo} has no USDC account ${payToAta} to receive the payment`);
  }

  return {
    authority: args.authority,
    gatewayPda,
    decimals,
    payerAta,
    payerBalance: readTokenAmount(payerInfo, args.usdcMint, args.payer) ?? 0n,
    payTo,
    payToAta
  };
}

export interface PaymentTransactionArgs {
  payer: Address;
  feePayer: Address;
  payerAta: Address;
  payToAta: Address;
  mint: Address;
  decimals: number;
  amount: bigint;
  memo: string;
  recentBlockhash: string;
}

/**
 * The exact-SVM layout: compute-unit limit, compute-unit price,
 * TransferChecked, then the Memo carrying `extra.memo`. The facilitator is the
 * fee payer, and the payer is the only other signer.
 */
export function buildPaymentTransaction(args: PaymentTransactionArgs): VersionedTransaction {
  const limit = Buffer.alloc(5);
  limit.writeUInt8(2, 0);
  limit.writeUInt32LE(PAYMENT_COMPUTE_UNIT_LIMIT, 1);
  const price = Buffer.alloc(9);
  price.writeUInt8(3, 0);
  price.writeBigUInt64LE(PAYMENT_COMPUTE_UNIT_PRICE_MICROLAMPORTS, 1);

  const instructions: Instruction[] = [
    { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: limit },
    { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, data: price },
    getTransferCheckedInstruction({
      source: args.payerAta,
      mint: args.mint,
      destination: args.payToAta,
      // A noop signer gives the authority its signer role in the message; the
      // signature itself comes from the payer's own wallet.
      authority: createNoopSigner(args.payer),
      amount: args.amount,
      decimals: args.decimals
    }),
    { programAddress: MEMO_PROGRAM_ADDRESS, data: Buffer.from(args.memo, "utf8") }
  ];

  return toLegacyV0Transaction(args.feePayer, args.recentBlockhash, instructions);
}

/** What a signed payment transaction must still be: the SHA-256 of the prepared message and its two signers. */
export interface PreparedPaymentIdentity {
  /** Hex SHA-256 of the unsigned transaction's serialized message. */
  messageSha256: string;
  feePayer: Address;
  payer: Address;
}

export function paymentMessageSha256(transaction: VersionedTransaction): string {
  return Buffer.from(sha256(transaction.message.serialize())).toString("hex");
}

/**
 * Accepts a payment transaction signed outside this function only if it is still
 * the prepared one: the same message, signed by exactly the fee payer and the
 * payer, carrying the payer's valid signature. The fee payer's slot belongs to
 * the facilitator and is ignored.
 */
export async function assertSignedPayment(
  prepared: PreparedPaymentIdentity,
  signed: VersionedTransaction
): Promise<void> {
  const message = signed.message.serialize();
  if (Buffer.from(sha256(message)).toString("hex") !== prepared.messageSha256) {
    throw signedMismatch("the signed x402 payment transaction is not the one that was prepared; refusing to send it");
  }

  const required = signed.message.header.numRequiredSignatures;
  const signers = signed.message.staticAccountKeys.slice(0, required).map((key) => key.toBase58());
  if (required !== 2 || signers[0] !== prepared.feePayer || signers[1] !== prepared.payer) {
    throw signedMismatch(`x402 payment must be signed by exactly the fee payer and the payer, got [${signers.join(", ")}]`);
  }

  const signature = signed.signatures[1];
  const valid =
    signature?.length === 64 &&
    (await verifySignature(await getPublicKeyFromAddress(prepared.payer), signatureBytes(exactBytes(signature)), exactBytes(message)));
  if (!valid) {
    throw signedMismatch(`the x402 payment transaction is not signed by its payer ${prepared.payer}`);
  }
}

/**
 * Signs as the transfer authority only. A signer that changes the message, or
 * leaves more signers than the facilitator and itself, is refused.
 */
export async function signPaymentTransaction(
  signer: MolphaSigner,
  transaction: VersionedTransaction,
  feePayer: Address
): Promise<VersionedTransaction> {
  const prepared = { messageSha256: paymentMessageSha256(transaction), feePayer, payer: signer.publicKey };
  const signed = await signer.signTransaction(transaction);
  await assertSignedPayment(prepared, signed);
  return signed;
}

function signedMismatch(message: string): Error {
  return Object.assign(new Error(message), { code: "signed_transaction_mismatch" });
}

function mismatch(field: string, got: string, expected: string): Error {
  return new Error(`x402 402 response ${field} mismatch: got ${got}, expected ${expected}. Refusing to sign.`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`x402 402 response has a malformed ${field}`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`x402 402 response has a malformed ${field}`);
  }
  return value;
}

function requireStringMap(value: unknown, field: string): Record<string, string> {
  const record = asRecord(value);
  if (!record || !Object.values(record).every((entry) => typeof entry === "string")) {
    throw new Error(`x402 402 response has a malformed ${field}`);
  }
  return { ...(record as Record<string, string>) };
}

function parseAddress(value: string | undefined, field: string): Address {
  try {
    return address(value ?? "");
  } catch {
    throw new Error(`x402 402 response ${field} is not a Solana address: ${JSON.stringify(value)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
