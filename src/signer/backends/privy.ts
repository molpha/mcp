import { createRequire } from "node:module";
import type { Address } from "@solana/kit";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { parseSolanaPubkey } from "../../solana-address.js";
import type { MolphaSigner } from "../types.js";

const require = createRequire(import.meta.url);

interface PrivySolanaService {
  signTransaction(
    walletId: string,
    args: { transaction: Uint8Array }
  ): Promise<{ signed_transaction: string; encoding: "base64" }>;
  signMessage(
    walletId: string,
    args: { message: Uint8Array }
  ): Promise<{ signature: string; encoding: "base64" }>;
}
interface PrivyWalletsService {
  get(walletId: string): Promise<{ id: string; address: string }>;
  solana(): PrivySolanaService;
}
interface PrivyClientLike {
  wallets(): PrivyWalletsService;
}

export interface PrivySignerConfig {
  appId: string;
  appSecret: string;
  walletId: string;
  address: string;
}

export class PrivySigner implements MolphaSigner {
  readonly publicKey: Address;
  private readonly walletId: string;
  private readonly wallets: PrivyWalletsService;

  constructor(config: PrivySignerConfig) {
    this.publicKey = parseSolanaPubkey(config.address, "PRIVY_WALLET_ADDRESS");
    this.walletId = config.walletId;

    let PrivyClient: new (opts: { appId: string; appSecret: string }) => PrivyClientLike;
    try {
      ({ PrivyClient } = require("@privy-io/node") as {
        PrivyClient: new (opts: { appId: string; appSecret: string }) => PrivyClientLike;
      });
    } catch (error) {
      throw new Error(
        "@privy-io/node is not installed. Run `npm install @privy-io/node` to use SIGNER_BACKEND=keychain with KEYCHAIN_BACKEND=privy.",
        { cause: error }
      );
    }
    const privy = new PrivyClient({ appId: config.appId, appSecret: config.appSecret });
    this.wallets = privy.wallets();
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.wallets.get(this.walletId);
      return true;
    } catch {
      return false;
    }
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    const transaction =
      tx instanceof VersionedTransaction
        ? tx.serialize()
        : tx.serialize({ requireAllSignatures: false, verifySignatures: false });

    const { signed_transaction: signedTransaction } = await this.wallets.solana().signTransaction(this.walletId, {
      transaction,
    });

    const decoded = Buffer.from(signedTransaction, "base64");
    return (tx instanceof VersionedTransaction ? VersionedTransaction.deserialize(decoded) : Transaction.from(decoded)) as T;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return Promise.all(txs.map((tx) => this.signTransaction(tx)));
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const { signature } = await this.wallets.solana().signMessage(this.walletId, { message });
    return new Uint8Array(Buffer.from(signature, "base64"));
  }
}
