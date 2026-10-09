import { formatUsdcAtomic, type GuardrailConfig, type SourcePaymentConfig } from "./config.js";

interface DailyCounter {
  day: string;
  count: number;
}

interface DailySpend {
  day: string;
  spentAtomic: bigint;
}

const executes: DailyCounter = { day: "", count: 0 };
const x402Spend: DailySpend = { day: "", spentAtomic: 0n };
const sourceSpend: DailySpend = { day: "", spentAtomic: 0n };

/** Chains concurrent x402 spend work so cap checks cannot all pass before any is recorded. */
let x402DailySpendTail: Promise<void> = Promise.resolve();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function bump(counter: DailyCounter, max: number, label: string): void {
  const day = todayKey();
  if (counter.day !== day) {
    counter.day = day;
    counter.count = 0;
  }

  if (counter.count >= max) {
    throw new Error(`${label} cap reached (${max} per day). Adjust MOLPHA_MAX_${label.toUpperCase().replace(/ /g, "_")}_PER_DAY or wait until tomorrow.`);
  }

  counter.count += 1;
}

/** Reset counters — exposed for tests. */
export function resetGuardrailCounters(): void {
  executes.day = "";
  executes.count = 0;
  x402Spend.day = "";
  x402Spend.spentAtomic = 0n;
  sourceSpend.day = "";
  sourceSpend.spentAtomic = 0n;
}

/** Chains concurrent source-payment work, for the same reason as the x402 one above. */
let sourceSpendTail: Promise<void> = Promise.resolve();

/** USDC signed away today to pay API sources, in base units (worst case: every authorization settles). */
export function sourceSpentToday(): bigint {
  return sourceSpend.day === todayKey() ? sourceSpend.spentAtomic : 0n;
}

/** A source payment the server will not make. Nothing has been signed when this is thrown. */
export function refuseSourcePayment(message: string): never {
  throw Object.assign(new Error(message), { code: "source_payment_refused" });
}

/** Checks one round's worst-case source payment against the per-round and the daily cap. Records nothing. */
export function checkSourceSpendCap(worstCaseAtomic: bigint, config: SourcePaymentConfig): void {
  if (worstCaseAtomic > config.maxPerRoundAtomic) {
    refuseSourcePayment(
      `Source payment refused: this round could cost up to ${formatUsdcAtomic(worstCaseAtomic)} USDC, above the per-round cap of ${formatUsdcAtomic(config.maxPerRoundAtomic)} USDC (MOLPHA_SOURCE_MAX_PER_ROUND_USDC).`
    );
  }
  if (config.dailyCapsEnabled === false) return;
  const spent = sourceSpentToday();
  if (spent + worstCaseAtomic > config.maxPerDayAtomic) {
    refuseSourcePayment(
      `Source payment refused: the daily cap of ${formatUsdcAtomic(config.maxPerDayAtomic)} USDC (MOLPHA_SOURCE_MAX_SPEND_PER_DAY_USDC) would be exceeded; ${formatUsdcAtomic(spent)} USDC is already committed today.`
    );
  }
}

/**
 * Records a round's source payment as soon as its authorizations are signed. A signed authorization can settle
 * whether or not the round completes, so counting it only on success would let the cap be exceeded.
 */
export function recordSourceSpend(worstCaseAtomic: bigint): void {
  const day = todayKey();
  if (sourceSpend.day !== day) {
    sourceSpend.day = day;
    sourceSpend.spentAtomic = 0n;
  }
  sourceSpend.spentAtomic += worstCaseAtomic;
}

/** Runs one round's cap check, signing and spend recording at a time, so concurrent rounds cannot all pass the check first. */
export async function withSourceSpendSerialization<T>(fn: () => Promise<T>): Promise<T> {
  const previous = sourceSpendTail;
  let release!: () => void;
  sourceSpendTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export function enforceExecuteCap(config: GuardrailConfig): void {
  if (config.dailyCapsEnabled === false) return;
  bump(executes, config.maxExecutesPerDay, "execute");
}

/** Checks a proposed round price against the per-round cap only. */
export function checkX402PerRoundCap(priceAtomic: bigint, maxPriceUsdcAtomic: bigint): void {
  if (priceAtomic > maxPriceUsdcAtomic) {
    throw new Error(
      `x402 per-round price cap reached: round price (${formatUsdcAtomic(priceAtomic)} USDC) exceeds MOLPHA_X402_MAX_PRICE_USDC (${formatUsdcAtomic(maxPriceUsdcAtomic)} USDC).`
    );
  }
}

/** x402 USDC signed away today, in base units. */
export function x402SpentToday(): bigint {
  return x402Spend.day === todayKey() ? x402Spend.spentAtomic : 0n;
}

/** Checks a proposed wallet outflow against the daily spend cap only. */
export function checkX402DailySpendCap(amountAtomic: bigint, maxSpendPerDayUsdcAtomic: bigint): void {
  const spentToday = x402SpentToday();
  if (spentToday + amountAtomic > maxSpendPerDayUsdcAtomic) {
    throw new Error(
      `x402 daily spend cap reached (${formatUsdcAtomic(maxSpendPerDayUsdcAtomic)} USDC per day, ${formatUsdcAtomic(spentToday)} USDC already spent). Adjust MOLPHA_X402_MAX_SPEND_PER_DAY_USDC or wait until tomorrow.`
    );
  }
}

/**
 * Checks a proposed x402 round's price against the per-round and daily
 * spend caps, without recording the spend (call {@link recordX402Spend}
 * once a payment is signed).
 */
export function checkX402SpendCap(
  priceAtomic: bigint,
  maxPriceUsdcAtomic: bigint,
  maxSpendPerDayUsdcAtomic: bigint
): void {
  checkX402PerRoundCap(priceAtomic, maxPriceUsdcAtomic);
  checkX402DailySpendCap(priceAtomic, maxSpendPerDayUsdcAtomic);
}

/**
 * Records an x402 payment against the daily cap as soon as it is signed and
 * handed to a gateway. A signed transfer can settle whether or not the round
 * completes, so counting it only on success would let the cap be exceeded.
 */
export function recordX402Spend(priceAtomic: bigint): void {
  const day = todayKey();
  if (x402Spend.day !== day) {
    x402Spend.day = day;
    x402Spend.spentAtomic = 0n;
  }

  x402Spend.spentAtomic += priceAtomic;
}

/**
 * Runs one x402 round's daily-cap check, signing, and spend recording at a time
 * when daily caps are enabled. Without this, concurrent rounds can pass
 * {@link checkX402SpendCap} before any {@link recordX402Spend} runs.
 */
export async function withX402DailySpendSerialization<T>(
  dailyCapsEnabled: boolean,
  fn: () => Promise<T>
): Promise<T> {
  if (!dailyCapsEnabled) return fn();

  const previous = x402DailySpendTail;
  let release!: () => void;
  x402DailySpendTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Whether a write tool runs as a dry run. `MOLPHA_DRY_RUN=true` is a lock: a call cannot opt out of it with
 * `dryRun: false`, so going live takes a change to the server's config, not to one tool call. Without the lock,
 * a call's own `dryRun` wins and the default is live.
 */
export function resolveDryRun(requested: boolean | undefined, config: GuardrailConfig): boolean {
  if (config.dryRunDefault) {
    if (requested === false) {
      throw Object.assign(
        new Error("This server is locked to dry-run (MOLPHA_DRY_RUN=true), so dryRun: false is refused. Nothing was signed or sent."),
        { code: "dry_run_locked" }
      );
    }
    return true;
  }
  return requested ?? false;
}

export interface WritePreview {
  dryRun: true;
  action: string;
  summary: Record<string, unknown>;
}

export function previewWrite(action: string, summary: Record<string, unknown>): WritePreview {
  return { dryRun: true, action, summary };
}
