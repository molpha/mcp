import { createKeyPairFromBytes, getAddressFromPublicKey, signBytes, type Address } from "@solana/kit";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { toLegacyPublicKey } from "../../solana-compat.js";
import type { MolphaSigner } from "../types.js";
import { exactBytes } from "../../bytes.js";

export class MemorySigner implements MolphaSigner {
  readonly publicKey: Address;
  private readonly keyPair: CryptoKeyPair;

  private constructor(keyPair: CryptoKeyPair, address: Address) {
    this.keyPair = keyPair;
    this.publicKey = address;
  }

  static async fromSecretKey(secretKey: Uint8Array): Promise<MemorySigner> {
    const keyPair = await createKeyPairFromBytes(secretKey);
    const address = await getAddressFromPublicKey(keyPair.publicKey);
    return new MemorySigner(keyPair, address);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    const messageBytes = tx instanceof VersionedTransaction ? tx.message.serialize() : tx.serializeMessage();
    const signature = await signBytes(this.keyPair.privateKey, exactBytes(messageBytes));
    tx.addSignature(toLegacyPublicKey(this.publicKey), Buffer.from(signature));
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return Promise.all(txs.map((tx) => this.signTransaction(tx)));
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await signBytes(this.keyPair.privateKey, exactBytes(message)));
  }
}

