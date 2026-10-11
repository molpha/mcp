/**
 * What an address may do under a subscription, read from chain: whether it is the
 * owner or one of its delegates, and the limits that apply. The program records
 * who may use a subscription and how much; it does not count use. The gateway
 * does, off chain, so nothing here says how much quota is left.
 */
import { getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import type { Connection } from "@solana/web3.js";
import { getMolphaProgramId, requireMethod } from "./clients.js";
import { toLegacyPublicKey } from "./solana-compat.js";
import { decodeProgramAccount } from "./x402-payment.js";

export interface AccessContext {
  connection: Pick<Connection, "getAccountInfo">;
  solana: Record<string, unknown>;
}

export interface Access {
  address: Address;
  owner: Address;
  role: "owner" | "delegate" | "none";
  subscription?: {
    owner: string;
    planType: unknown;
    /** Unix seconds. */
    validUntil: number;
    active: boolean;
    maxRounds: number;
    maxSigners: number;
    delegateCount: number;
    maxDelegates: number;
  };
  delegate?: { account: Address; maxDataRequests: number };
  /** Rounds this address may request per subscription term: the smaller of the plan's and its own. */
  effectiveMaxRounds?: number;
}

/** `["molpha_delegate", owner, delegate]`: the account `add_delegate` creates and `remove_delegate` closes. */
export async function deriveDelegatePda(owner: Address, delegate: Address, programId: Address): Promise<Address> {
  const encoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [Buffer.from("molpha_delegate"), Buffer.from(encoder.encode(owner)), Buffer.from(encoder.encode(delegate))]
  });
  return pda;
}

export async function readAccess(ctx: AccessContext, address: Address, owner: Address = address): Promise<Access> {
  const programId = getMolphaProgramId();
  const delegatePda = address === owner ? undefined : await deriveDelegatePda(owner, address, programId);
  const [subscription, delegateInfo] = await Promise.all([
    requireMethod<[string], Promise<Record<string, unknown> | null>>(ctx.solana, "readSubscription")(owner),
    delegatePda ? ctx.connection.getAccountInfo(toLegacyPublicKey(delegatePda)) : Promise.resolve(null)
  ]);

  const out: Access = { address, owner, role: "none" };
  if (subscription) {
    const validUntil = Number(subscription.validUntil ?? 0);
    out.subscription = {
      owner: String(subscription.owner ?? owner),
      planType: subscription.planType,
      validUntil,
      active: validUntil > Math.floor(Date.now() / 1000),
      maxRounds: Number(subscription.maxRounds ?? 0),
      maxSigners: Number(subscription.maxSigners ?? 0),
      delegateCount: Number(subscription.delegateCount ?? 0),
      maxDelegates: Number(subscription.maxDelegates ?? 0)
    };
  }
  if (delegatePda && delegateInfo) {
    const account = decodeProgramAccount<{
      owner: { toBase58(): string };
      delegate: { toBase58(): string };
      max_data_requests: { toString(): string };
    }>(delegateInfo, "Delegate", delegatePda, programId);
    if (account.owner.toBase58() === owner && account.delegate.toBase58() === address) {
      out.delegate = { account: delegatePda, maxDataRequests: Number(account.max_data_requests.toString()) };
    }
  }

  if (out.subscription && address === owner) {
    out.role = "owner";
    out.effectiveMaxRounds = out.subscription.maxRounds;
  } else if (out.subscription && out.delegate) {
    out.role = "delegate";
    out.effectiveMaxRounds = Math.min(out.subscription.maxRounds, out.delegate.maxDataRequests);
  }
  return out;
}
