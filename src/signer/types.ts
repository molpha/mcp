import type { Address } from "@solana/kit";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";

export interface MolphaSigner {
  readonly publicKey: Address;
  isAvailable(): Promise<boolean>;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}
