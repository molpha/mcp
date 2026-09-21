import { createRequire } from "node:module";
import type { Address } from "@solana/kit";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { parseSolanaPubkey } from "../../solana-address.js";
import type { MolphaSigner } from "../types.js";

const require = createRequire(import.meta.url);

interface TurnkeySignerLike {
  addSignature(tx: Transaction | VersionedTransaction, address: string): Promise<void>;
  signMessage(message: Uint8Array, address: string): Promise<Uint8Array>;
}
interface TurnkeyClientLike {
  apiClient(): unknown;
}
interface TurnkeyConstructor {
  new (opts: {
    apiBaseUrl: string;
    apiPublicKey: string;
    apiPrivateKey: string;
    defaultOrganizationId: string;
  }): TurnkeyClientLike;
}
interface TurnkeySignerConstructor {
  new (opts: { organizationId: string; client: unknown }): TurnkeySignerLike;
}

export interface TurnkeySignerConfig {
  apiPublicKey: string;
  apiPrivateKey: string;
  organizationId: string;
  address: string;
}

export class TurnkeySigner implements MolphaSigner {
  readonly publicKey: Address;
  private readonly address: string;
  private readonly signer: TurnkeySignerLike;

  constructor(config: TurnkeySignerConfig) {
    this.publicKey = parseSolanaPubkey(config.address, "TURNKEY_WALLET_ADDRESS");
    this.address = config.address;

    let TurnkeyClass: TurnkeyConstructor;
    let TurnkeySignerClass: TurnkeySignerConstructor;
    try {
      ({ Turnkey: TurnkeyClass } = require("@turnkey/sdk-server") as { Turnkey: TurnkeyConstructor });
      ({ TurnkeySigner: TurnkeySignerClass } = require("@turnkey/solana") as {
        TurnkeySigner: TurnkeySignerConstructor;
      });
    } catch (error) {
      throw new Error(
        "@turnkey/sdk-server and @turnkey/solana are not installed. Run `npm install @turnkey/sdk-server @turnkey/solana`.",
        { cause: error }
      );
    }

    const client = new TurnkeyClass({
      apiBaseUrl: "https://api.turnkey.com",
      apiPublicKey: config.apiPublicKey,
      apiPrivateKey: config.apiPrivateKey,
      defaultOrganizationId: config.organizationId,
    });

    this.signer = new TurnkeySignerClass({
      organizationId: config.organizationId,
      client: client.apiClient(),
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      const signature = await this.signer.signMessage(new Uint8Array(1), this.address);
      return signature instanceof Uint8Array && signature.length > 0;
    } catch {
      return false;
    }
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    await this.signer.addSignature(tx, this.address);
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    await Promise.all(txs.map((tx) => this.signer.addSignature(tx, this.address)));
    return txs;
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const signature = await this.signer.signMessage(message, this.address);
    return signature instanceof Uint8Array ? signature : new Uint8Array(signature);
  }
}
