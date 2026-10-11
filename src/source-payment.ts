/**
 * Paying a paywalled API source, as an agent tool would.
 *
 * A provider's x402 service charges per fetch, and every node the round selects makes one. The caller pays,
 * from its own wallet, so the one thing that must never happen is a payment the caller did not mean to make.
 * Everything here exists to make that impossible by construction:
 *
 *  - nothing is paid unless the server has a payer key AND an explicit network allowlist;
 *  - the price is read from the source's own unpaid 402 first, and the worst case (price per call times the
 *    nodes that may fetch) is checked against the caller's stated maximum, the per-round cap and the daily cap
 *    BEFORE anything is signed;
 *  - the vetted terms are what gets signed, so the price cannot move between the check and the payment.
 */
import { formatUsdcAtomic, type MolphaConfig, type SourcePaymentConfig } from "./config.js";
import { requireMethod, type RequestContext } from "./clients.js";
import { checkSourceSpendCap, refuseSourcePayment, sourceSpentToday } from "./guardrails.js";
import { expectedUsdcAsset, isAllowedSourcePaymentAsset } from "./source-payment-assets.js";
import { requireSdkExport } from "./sdk.js";

/** A price fetch is a single unpaid request: it must not hold the agent up. */
const PROBE_TIMEOUT_MS = 10_000;

/** The source's own x402 terms, as the SDK reads them from its 402. Passed back to the SDK unchanged to be signed. */
export interface SourceTerms {
  x402Version: 1 | 2;
  network: string;
  chainId: number;
  asset: string;
  payTo: string;
  /** Price per fetch, in token base units. */
  amount: string;
  maxTimeoutSeconds: number;
  paymentIdentifier?: unknown;
  [key: string]: unknown;
}

export interface SourceQuote {
  network: string;
  asset: string;
  payTo: string;
  pricePerCallAtomic: string;
  pricePerCallUsdc: string;
  maxTimeoutSeconds: number;
  requiresPaymentIdentifier: boolean;
  /** Nodes that may fetch this round, and so authorizations signed. */
  eligibleSetSize: number;
  worstCaseAtomic: string;
  worstCaseUsdc: string;
}

export function sourcePaymentEnabled(config: MolphaConfig): boolean {
  const sp = config.sourcePayment;
  return sp !== undefined && sp.payerKey !== undefined && sp.networks.length > 0;
}

export function disabledError(): Error {
  return Object.assign(
    new Error("Paying API sources is not enabled on this server: it has no payer wallet or no allowed network configured."),
    { code: "source_payment_disabled" }
  );
}

/** The configured payer's public address, derived from its key. Never the key. */
export function payerAddress(config: MolphaConfig): string | undefined {
  const key = config.sourcePayment?.payerKey;
  if (!key) return undefined;
  return createPayer(key).address;
}

/** The SDK's EVM signer for the payer. Keys stay in this process: neither Molpha nor the gateway sees one. */
export function createPayer(key: string): { address: string; signDigest(digest: Uint8Array): Promise<Uint8Array> } {
  const create = requireSdkExport<(key: string) => { address: string; signDigest(digest: Uint8Array): Promise<Uint8Array> }>(
    "createEvmSignerFromPrivateKey"
  );
  return create(key);
}

/** How many nodes may fetch a round of this quorum: the number of authorizations the caller would sign. */
export async function eligibleSetSizeFor(context: RequestContext, signaturesRequired: number): Promise<number> {
  const nodes = await requireMethod<[], Promise<unknown[]>>(context.gateway, "getNodes")();
  const selection = (await requireMethod<[], Promise<{ redundancyBuffer: number; nodeCount?: number }>>(
    context.solana,
    "getRegistrySelectionConfig"
  )()) as { redundancyBuffer: number; nodeCount?: number };
  const size = requireSdkExport<(quorum: number, registry: { nodeCount: number; redundancyBuffer: number }) => number>("eligibleSetSize");
  return size(signaturesRequired, { nodeCount: selection.nodeCount ?? nodes.length, redundancyBuffer: selection.redundancyBuffer });
}

function apiConfigUrl(apiConfig: unknown): string {
  if (!apiConfig || typeof apiConfig !== "object" || typeof (apiConfig as { url?: unknown }).url !== "string") {
    throw new Error("apiConfig.url is required");
  }
  return (apiConfig as { url: string }).url;
}

/**
 * Reads x402 accepts from a 402 body when the SDK refuses non-USDC terms but the caller still needs
 * the quoted network, asset and price for policy checks.
 */
async function fetchSourceTermsFrom402(apiConfig: unknown, timeoutMs: number): Promise<SourceTerms | null> {
  const url = apiConfigUrl(apiConfig);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    if (response.status !== 402) {
      return null;
    }
    const body = (await response.json()) as {
      x402Version?: number;
      accepts?: Array<Record<string, unknown>>;
      extensions?: Record<string, unknown>;
    };
    const accept = body.accepts?.[0];
    if (!accept) {
      return null;
    }
    const { network, asset, amount, payTo, maxTimeoutSeconds, chainId } = accept;
    if (typeof network !== "string" || typeof asset !== "string" || typeof amount !== "string" || typeof payTo !== "string") {
      return null;
    }
    const terms: SourceTerms = {
      x402Version: body.x402Version === 2 ? 2 : 1,
      network,
      chainId: typeof chainId === "number" ? chainId : 0,
      asset,
      payTo,
      amount,
      maxTimeoutSeconds: typeof maxTimeoutSeconds === "number" ? maxTimeoutSeconds : 60
    };
    const paymentIdentifier = body.extensions?.["payment-identifier"];
    if (paymentIdentifier !== undefined) {
      terms.paymentIdentifier = paymentIdentifier;
    }
    return terms;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the source's own price with one unpaid request. Null when the source is not paywalled. */
export async function probeSourceTerms(apiConfig: unknown): Promise<SourceTerms | null> {
  const probe = requireSdkExport<(config: unknown, options?: { timeoutMs?: number }) => Promise<SourceTerms | null>>("probeSource");
  try {
    return await probe(apiConfig, { timeoutMs: PROBE_TIMEOUT_MS });
  } catch (error) {
    const fallback = await fetchSourceTermsFrom402(apiConfig, PROBE_TIMEOUT_MS);
    if (fallback !== null) {
      return fallback;
    }
    throw error;
  }
}

export function describeQuote(terms: SourceTerms, eligibleSetSize: number): SourceQuote {
  const price = BigInt(terms.amount);
  const worst = price * BigInt(eligibleSetSize);
  return {
    network: terms.network,
    asset: terms.asset,
    payTo: terms.payTo,
    pricePerCallAtomic: price.toString(),
    pricePerCallUsdc: formatUsdcAtomic(price),
    maxTimeoutSeconds: terms.maxTimeoutSeconds,
    requiresPaymentIdentifier: terms.paymentIdentifier !== undefined,
    eligibleSetSize,
    worstCaseAtomic: worst.toString(),
    worstCaseUsdc: formatUsdcAtomic(worst)
  };
}

export interface PaymentPolicy {
  enabled: boolean;
  /** The payer's public address, when one is configured. */
  payer?: string;
  allowedNetworks: string[];
  networkAllowed?: boolean;
  /** Whether the source's asset is the USDC contract this server signs on that network. */
  assetAllowed?: boolean;
  perRoundCapUsdc: string;
  dailyCapUsdc: string;
  spentTodayUsdc: string;
  /** Whether this server would pay this round, given its configuration and caps. */
  wouldPay: boolean;
  /** Why not, when it would not. */
  reasons: string[];
}

/** What this server's configuration says about paying for a round, without paying or signing anything. */
export function evaluatePolicy(config: MolphaConfig, quote?: SourceQuote): PaymentPolicy {
  const sp: SourcePaymentConfig | undefined = config.sourcePayment;
  const reasons: string[] = [];
  const enabled = sourcePaymentEnabled(config);
  if (!enabled) reasons.push("Source payment is not enabled: configure MOLPHA_SOURCE_PAYER_KEY and MOLPHA_SOURCE_PAYMENT_NETWORKS.");

  const policy: PaymentPolicy = {
    enabled,
    ...(enabled ? { payer: payerAddress(config) as string } : {}),
    allowedNetworks: sp?.networks ?? [],
    perRoundCapUsdc: formatUsdcAtomic(sp?.maxPerRoundAtomic ?? 0n),
    dailyCapUsdc: formatUsdcAtomic(sp?.maxPerDayAtomic ?? 0n),
    spentTodayUsdc: formatUsdcAtomic(sourceSpentToday()),
    wouldPay: false,
    reasons
  };

  if (quote && sp) {
    const allowed = sp.networks.includes(quote.network);
    policy.networkAllowed = allowed;
    if (!allowed) reasons.push(`The source asks to be paid on ${quote.network}, which is not in this server's allowed networks.`);
    const assetOk = allowed && isAllowedSourcePaymentAsset(quote.network, quote.asset);
    policy.assetAllowed = assetOk;
    if (allowed && !assetOk) {
      const expected = expectedUsdcAsset(quote.network);
      reasons.push(
        expected
          ? `The source asks to be paid in token ${quote.asset}, but this server only signs USDC (${expected}) on ${quote.network}.`
          : `The source asks to be paid on ${quote.network}, which has no known USDC contract on this server.`
      );
    }
    const worst = BigInt(quote.worstCaseAtomic);
    if (worst > sp.maxPerRoundAtomic) {
      reasons.push(`Worst case ${quote.worstCaseUsdc} USDC exceeds the per-round cap of ${policy.perRoundCapUsdc} USDC.`);
    }
    if (sourceSpentToday() + worst > sp.maxPerDayAtomic) {
      reasons.push(`Worst case ${quote.worstCaseUsdc} USDC would exceed the daily cap (${policy.spentTodayUsdc} of ${policy.dailyCapUsdc} USDC already committed).`);
    }
  }
  policy.wouldPay = enabled && quote !== undefined && reasons.length === 0;
  return policy;
}

/**
 * Decides whether to pay, and refuses with an explanation otherwise. Throws before anything is signed.
 * The daily cap is checked by the caller inside the spend serialization, together with recording the spend.
 */
export function authorizePayment(config: MolphaConfig, terms: SourceTerms, quote: SourceQuote, authorizedAtomic: bigint): SourcePaymentConfig {
  const sp = config.sourcePayment;
  if (!sp || !sourcePaymentEnabled(config)) throw disabledError();
  if (!sp.networks.includes(terms.network)) {
    refuseSourcePayment(`Source payment refused: the source asks to be paid on ${terms.network}, which is not in MOLPHA_SOURCE_PAYMENT_NETWORKS (${sp.networks.join(", ")}).`);
  }
  if (!isAllowedSourcePaymentAsset(terms.network, terms.asset)) {
    const expected = expectedUsdcAsset(terms.network);
    refuseSourcePayment(
      expected
        ? `Source payment refused: the source asks to be paid in token ${terms.asset}, but this server only signs USDC (${expected}) on ${terms.network}.`
        : `Source payment refused: ${terms.network} has no known USDC contract on this server.`
    );
  }
  const worst = BigInt(quote.worstCaseAtomic);
  if (worst > authorizedAtomic) {
    refuseSourcePayment(
      `Source payment refused: this round could cost up to ${quote.worstCaseUsdc} USDC (${quote.pricePerCallUsdc} x ${quote.eligibleSetSize} fetches), above the ${formatUsdcAtomic(authorizedAtomic)} USDC you authorized.`
    );
  }
  checkSourceSpendCap(worst, sp);
  return sp;
}
