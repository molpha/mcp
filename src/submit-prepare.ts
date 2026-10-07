/**
 * The Solana settle path for a wallet this server does not hold: the same
 * `submit_attestation` transaction the stdio server sends, built unsigned for a
 * named payer, and accepted back only as that exact transaction carrying the
 * payer's signature.
 *
 * The transaction is not rebuilt here. The SDK builds it, as it does for the stdio
 * server, against a wallet that keeps what it is asked to sign and signs nothing,
 * so what a caller is handed is what the SDK would have sent, whatever the SDK
 * needs to put in it.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { getBase58Decoder, getPublicKeyFromAddress, signatureBytes, verifySignature, type Address } from "@solana/kit";
import { Transaction, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { setTimeout as delay } from "node:timers/promises";
import { toSdkAttestation } from "./artifacts.js";
import { exactBytes } from "./bytes.js";
import { createSolanaClient, getMolphaProgramId, requireMethod, type RequestLifecycle } from "./clients.js";
import type { MolphaConfig } from "./config.js";
import { enforceExecuteCap } from "./guardrails.js";
import type { MolphaSigner } from "./signer/types.js";
import { toLegacyPublicKey } from "./solana-compat.js";
import type { SubmitOutcome } from "./submit.js";

export interface SubmitContext {
  lifecycle?: RequestLifecycle;
  config: MolphaConfig;
  connection: Connection;
}

/** Everything send_signed_transaction needs to recognize, send and report a prepared submit. Plain JSON. */
export interface PreparedSubmit {
  payer: Address;
  feed: string;
  sourceId: string;
  signaturesRequired: number;
  registryVersion: number;
  /** Hex SHA-256 of the unsigned transaction's message. */
  messageSha256: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/** How often, and for how long, a sent transaction is polled for confirmation. Mutable for tests. */
export const submitTiming = { pollMs: 1_000, timeoutMs: 60_000 };

class Captured extends Error {
  constructor(readonly transaction: Transaction | VersionedTransaction) {
    super("captured");
  }
}

/**
 * Builds the unsigned `submit_attestation` transaction for `payer`, who pays its
 * fee and becomes the feed's submitter. `result` is a prepared signed result
 * (see prepareSignedResult).
 */
export async function prepareSubmit(
  ctx: SubmitContext,
  result: Record<string, unknown>,
  payer: Address,
  createClient: typeof createSolanaClient = createSolanaClient
): Promise<{ prepared: PreparedSubmit; transaction: VersionedTransaction }> {
  ctx.lifecycle?.signal.throwIfAborted();
  // Signs nothing: it takes the transaction the SDK is about to sign and send, and stops it there.
  const refuse = async (tx: Transaction | VersionedTransaction): Promise<never> => {
    throw new Captured(tx);
  };
  const wallet: MolphaSigner = {
    publicKey: payer,
    isAvailable: async () => true,
    signMessage: async () => {
      throw new Error("the hosted server holds no key");
    },
    signTransaction: refuse,
    signAllTransactions: async (txs) => refuse(txs[0]!)
  };
  const client = createClient(ctx.config, wallet, ctx.connection);
  const built = await requireMethod<[Record<string, unknown>], Promise<unknown>>(client, "submitAttestation")(
    toSdkAttestation(result)
  ).then(
    () => undefined,
    (error: unknown) => {
      if (error instanceof Captured) return error.transaction;
      throw error;
    }
  );
  if (!(built instanceof Transaction)) {
    throw new Error("the SDK did not hand over a submit_attestation transaction to sign");
  }

  // The program's instruction lists submitter, registry, feed, ...: the feed is its third account.
  const programId = getMolphaProgramId();
  const submit = built.instructions.find((ix) => ix.programId.toBase58() === programId);
  const feed = submit?.keys[2]?.pubkey.toBase58();
  if (!submit || !feed || submit.keys[0]?.pubkey.toBase58() !== payer) {
    throw new Error("the SDK built a transaction that does not submit an attestation for this payer");
  }

  // Recompiled as v0 with a blockhash whose expiry height is known, so its lifetime can be reported and checked.
  const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash();
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: toLegacyPublicKey(payer),
      recentBlockhash: blockhash,
      instructions: built.instructions
    }).compileToV0Message()
  );

  return {
    transaction,
    prepared: {
      payer,
      feed,
      sourceId: String(result.sourceId),
      signaturesRequired: Number(result.signaturesRequired),
      registryVersion: Number(result.registryVersion),
      messageSha256: Buffer.from(sha256(transaction.message.serialize())).toString("hex"),
      blockhash,
      lastValidBlockHeight
    }
  };
}

/**
 * Sends a prepared submit once its payer has signed it. Only the prepared
 * transaction is ever sent: this is not a relay for arbitrary transactions.
 */
export async function sendPreparedSubmit(
  ctx: SubmitContext,
  prepared: PreparedSubmit,
  signed: VersionedTransaction
): Promise<SubmitOutcome> {
  ctx.lifecycle?.signal.throwIfAborted();
  const message = signed.message.serialize();
  const mismatch = (text: string): Error => Object.assign(new Error(text), { code: "signed_transaction_mismatch" });
  if (Buffer.from(sha256(message)).toString("hex") !== prepared.messageSha256) {
    throw mismatch("the signed transaction is not the one that was prepared; refusing to send it");
  }
  const signature = signed.signatures[0];
  const valid =
    signed.message.header.numRequiredSignatures === 1 &&
    signed.message.staticAccountKeys[0]?.toBase58() === prepared.payer &&
    signature?.length === 64 &&
    (await verifySignature(await getPublicKeyFromAddress(prepared.payer), signatureBytes(exactBytes(signature)), exactBytes(message)));
  if (!valid) {
    throw mismatch(`the transaction is not signed by its payer ${prepared.payer}`);
  }
  if ((await ctx.connection.getBlockHeight()) > prepared.lastValidBlockHeight) {
    throw Object.assign(new Error("the prepared transaction's blockhash has expired; prepare it again"), {
      code: "transaction_expired"
    });
  }

  enforceExecuteCap(ctx.config.guardrails);
  ctx.lifecycle?.signal.throwIfAborted();
  if (ctx.lifecycle) ctx.lifecycle.effectStarted = true;
  const txSignature = await ctx.connection.sendRawTransaction(signed.serialize());
  if (txSignature !== getBase58Decoder().decode(signature!)) {
    throw new Error(`the RPC node reported a different signature (${txSignature}) for the transaction that was sent`);
  }
  await confirm(ctx, txSignature, prepared.lastValidBlockHeight);

  return {
    chain: "solana",
    action: "submit_attestation",
    sourceId: prepared.sourceId,
    signaturesRequired: prepared.signaturesRequired,
    submitter: prepared.payer,
    feed: prepared.feed,
    signature: txSignature
  };
}

/**
 * Polls until the transaction is confirmed, has failed, or can no longer land. Polling keeps
 * a stateless server off a websocket subscription it would have to hold open.
 */
async function confirm(ctx: SubmitContext, signature: string, lastValidBlockHeight: number): Promise<void> {
  const deadline = Date.now() + submitTiming.timeoutMs;
  for (;;) {
    const { value } = await ctx.connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) {
      throw new Error(`submit_attestation transaction ${signature} failed on chain: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return;
    }
    if (!status && (await ctx.connection.getBlockHeight()) > lastValidBlockHeight) {
      throw new Error(`submit_attestation transaction ${signature} expired without landing; prepare and sign it again`);
    }
    if (Date.now() >= deadline) {
      throw Object.assign(
        new Error(`submit_attestation transaction ${signature} was sent but is not yet confirmed; check it before sending another`),
        { code: "round_timeout" }
      );
    }
    await delay(submitTiming.pollMs, undefined, ctx.lifecycle ? { signal: ctx.lifecycle.signal } : undefined);
  }
}
