import { requireMethod } from "./clients.js";

export interface SubscriptionStatus {
  active: boolean;
  owner?: string;
  planType?: unknown;
  validUntil?: string;
  /** The plan's round quota. The program no longer counts rounds; the gateway's outbox does. */
  maxRounds?: number;
  message?: string;
}

export async function readSubscriptionStatus(
  solana: Record<string, unknown>,
  hosted = false
): Promise<SubscriptionStatus> {
  const readSubscription = requireMethod<[], Promise<Record<string, unknown> | null>>(solana, "readSubscription");

  try {
    const subscription = await readSubscription();

    if (!subscription) {
      return {
        active: false,
        message:
          "No active subscription found. Run `npx -y @molpha/mcp provision subscribe` with OWNER_KEYPAIR, or use execute_x402_round for a self-funded pay-per-request round."
      };
    }

    const validUntil = BigInt(String(subscription.validUntil ?? 0));
    const now = BigInt(Math.floor(Date.now() / 1000));
    const maxRounds = BigInt(String(subscription.maxRounds ?? 0));
    // Rounds used are no longer on-chain, so only expiry can be judged here; the gateway enforces the quota.
    const active = validUntil > now;

    return {
      active,
      owner: subscription.owner?.toString?.() ?? String(subscription.owner ?? ""),
      planType: subscription.planType,
      validUntil: validUntil.toString(),
      maxRounds: Number(maxRounds),
      ...(active
        ? {}
        : { message: "Subscription expired. Extend via the bootstrap CLI before requesting data." })
    };
  } catch (error) {
    return {
      active: false,
      message: hosted ? "Subscription status unavailable." : error instanceof Error ? error.message : String(error)
    };
  }
}
