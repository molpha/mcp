import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { getSdkExport } from "./sdk.js";
import { assertSourcePaymentNetworkSupported } from "./source-payment-assets.js";
import { parseSolanaPubkey } from "./solana-address.js";

const DEFAULT_SOLANA_RPC = "https://api.devnet.solana.com";
const FALLBACK_GATEWAY_ENDPOINT = "https://dev-gateway.molpha.io";

export interface GuardrailConfig {
  dailyCapsEnabled?: boolean;
  maxExecutesPerDay: number;
  dryRunDefault: boolean;
}

export interface X402Config {
  dailyCapsEnabled?: boolean;
  /** Per-round cap in USDC base units (6 decimals). Refuse to pay above this. */
  maxPriceUsdcAtomic: bigint;
  /** Daily cumulative spend cap in USDC base units. */
  maxSpendPerDayUsdcAtomic: bigint;
}

/**
 * Paying a paywalled API source (a provider's x402 service) from an EVM wallet this server holds. It is off
 * until BOTH a payer key and at least one allowed network are configured, and every payment is bounded by a
 * per-round and a per-day cap and by the amount the caller authorizes in that call.
 */
export interface SourcePaymentConfig {
  /** Hex private key of the EVM wallet that pays sources. Never printed, logged or returned by a tool. */
  payerKey: string | undefined;
  /** CAIP-2 networks a source may be paid on, e.g. `eip155:84532` (Base Sepolia). Empty disables payment. */
  networks: string[];
  /** Most one round may sign away, in USDC base units: its worst case, price per call times the eligible set. */
  maxPerRoundAtomic: bigint;
  /** Daily cumulative cap in USDC base units. */
  maxPerDayAtomic: bigint;
  dailyCapsEnabled?: boolean;
}

export interface MolphaConfig {
  gatewayEndpoints: string[];
  /**
   * Base58 authority per `gatewayEndpoints` entry. Request auth binds the
   * gateway's PDA; `undefined` leaves the SDK to discover it via `GET /v1/info`.
   */
  gatewayAuthorities: Array<string | undefined>;
  solanaRpc: string;
  ownerKeypair: string | undefined;
  evmNetworks: string[];
  starknetNetworks: string[];
  guardrails: GuardrailConfig;
  x402: X402Config;
  /** Absent means source payment is off. */
  sourcePayment?: SourcePaymentConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MolphaConfig {
  const sdkDefaultGateway = getSdkExport<string>("DEFAULT_GATEWAY_ENDPOINT");
  const gatewayEndpoints = parseCsv(
    resolveEnvString(env.GATEWAY_ENDPOINTS) ?? sdkDefaultGateway ?? FALLBACK_GATEWAY_ENDPOINT
  );

  return {
    gatewayEndpoints,
    gatewayAuthorities: parseGatewayAuthorities(
      resolveEnvString(env.GATEWAY_AUTHORITIES),
      gatewayEndpoints.length
    ),
    solanaRpc: resolveEnvString(env.SOLANA_RPC) ?? DEFAULT_SOLANA_RPC,
    ownerKeypair: resolveEnvString(env.OWNER_KEYPAIR ?? env.AGENT_KEYPAIR),
    evmNetworks: parseCsv(resolveEnvString(env.MOLPHA_EVM_NETWORKS) ?? "evm-sepolia"),
    starknetNetworks: parseCsv(resolveEnvString(env.MOLPHA_STARKNET_NETWORKS) ?? "starknet-sepolia"),
    guardrails: {
      maxExecutesPerDay: parsePositiveInt(resolveEnvString(env.MOLPHA_MAX_EXECUTES_PER_DAY), 100),
      dryRunDefault: parseDryRun(resolveEnvString(env.MOLPHA_DRY_RUN))
    },
    x402: {
      maxPriceUsdcAtomic: parseUsdcAtomic(resolveEnvString(env.MOLPHA_X402_MAX_PRICE_USDC), 1_000_000n),
      maxSpendPerDayUsdcAtomic: parseUsdcAtomic(resolveEnvString(env.MOLPHA_X402_MAX_SPEND_PER_DAY_USDC), 10_000_000n)
    },
    sourcePayment: loadSourcePayment(env)
  };
}

/**
 * `MOLPHA_DRY_RUN` is a lock on spending, so it fails safe: unset is live, a recognised "off" value is live,
 * and anything else (a typo, `True`, `yes`) locks to dry-run instead of silently going live.
 */
export function parseDryRun(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/** Quarter of a dollar per round and a dollar a day: enough to try a feed, far from enough to hurt. */
const DEFAULT_SOURCE_MAX_PER_ROUND_ATOMIC = 250_000n;
const DEFAULT_SOURCE_MAX_PER_DAY_ATOMIC = 1_000_000n;

function loadSourcePayment(env: NodeJS.ProcessEnv): SourcePaymentConfig {
  const payerKey = resolveEnvString(env.MOLPHA_SOURCE_PAYER_KEY)?.trim();
  // The message never includes the value: it is a private key.
  if (payerKey !== undefined && !/^(0x)?[0-9a-fA-F]{64}$/.test(payerKey)) {
    throw new Error("MOLPHA_SOURCE_PAYER_KEY must be a 32-byte hex private key (64 hex characters, 0x optional)");
  }
  const networks = parseCsv(resolveEnvString(env.MOLPHA_SOURCE_PAYMENT_NETWORKS) ?? "");
  for (const network of networks) {
    if (!/^eip155:\d+$/.test(network)) {
      throw new Error(`MOLPHA_SOURCE_PAYMENT_NETWORKS entries are CAIP-2 EVM networks such as eip155:84532, got "${network}"`);
    }
    assertSourcePaymentNetworkSupported(network);
  }
  return {
    payerKey,
    networks,
    maxPerRoundAtomic: parseUsdcAtomic(resolveEnvString(env.MOLPHA_SOURCE_MAX_PER_ROUND_USDC), DEFAULT_SOURCE_MAX_PER_ROUND_ATOMIC),
    maxPerDayAtomic: parseUsdcAtomic(resolveEnvString(env.MOLPHA_SOURCE_MAX_SPEND_PER_DAY_USDC), DEFAULT_SOURCE_MAX_PER_DAY_ATOMIC)
  };
}

export function loadOwnerKeypair(config: MolphaConfig): Uint8Array {
  if (!config.ownerKeypair) {
    throw new Error("OWNER_KEYPAIR is required for the Molpha MCP runtime (Model A owner key)");
  }

  return loadKeypair(config.ownerKeypair);
}

/** @deprecated Use loadOwnerKeypair — AGENT_KEYPAIR alias retained for compatibility. */
export function loadAgentKeypair(config: MolphaConfig): Uint8Array {
  return loadOwnerKeypair(config);
}

export function loadKeypair(pathOrJson: string): Uint8Array {
  const raw = isInlineKeypair(pathOrJson) ? pathOrJson : readFileSync(resolvePath(pathOrJson), "utf8");
  const secretKey = JSON.parse(raw) as number[];

  if (!Array.isArray(secretKey) || secretKey.length !== 64) {
    throw new Error("keypair must be a JSON array of 64 secret-key bytes");
  }

  return Uint8Array.from(secretKey);
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * GATEWAY_AUTHORITIES pairs with GATEWAY_ENDPOINTS by position; an empty entry
 * means "discover it". A shifted list would sign every request for the wrong
 * gateway, so the counts must match exactly.
 */
function parseGatewayAuthorities(value: string | undefined, endpointCount: number): Array<string | undefined> {
  if (!value) {
    return Array.from({ length: endpointCount }, () => undefined);
  }

  const entries = value.split(",").map((part) => part.trim());
  if (entries.length !== endpointCount) {
    throw new Error(
      `GATEWAY_AUTHORITIES has ${entries.length} entries but GATEWAY_ENDPOINTS has ${endpointCount}; list one authority per endpoint, in the same order (leave an entry empty to discover it via GET /v1/info)`
    );
  }

  return entries.map((entry, index) =>
    entry ? String(parseSolanaPubkey(entry, `GATEWAY_AUTHORITIES[${index}]`)) : undefined
  );
}

/** Parses a decimal USDC amount (e.g. "1.5") into base units (6 decimals). */
export function parseUsdcAtomic(value: string | undefined, fallback: bigint): bigint {
  if (!value?.trim()) {
    return fallback;
  }

  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) {
    throw new Error(`expected a decimal USDC amount, got "${value}"`);
  }

  const [, whole = "0", fraction = ""] = match;
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, got "${value}"`);
  }

  return parsed;
}

const UNRESOLVED_MCP_USER_CONFIG = /^\$\{user_config\.[a-z0-9_]+\}$/i;

/** Treats empty strings and unresolved MCP bundle `${user_config.*}` placeholders as unset. */
export function resolveEnvString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || UNRESOLVED_MCP_USER_CONFIG.test(trimmed)) {
    return undefined;
  }

  return value;
}

export function resolvePath(path: string): string {
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }

  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/** An OWNER_KEYPAIR value can be a file path or an inline JSON secret-key array. */
export function isInlineKeypair(pathOrJson: string): boolean {
  return pathOrJson.trim().startsWith("[");
}

/** Formats a USDC atomic (6-decimal) amount as a decimal string, e.g. 1_500_000n -> "1.5". */
export function formatUsdcAtomic(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const fraction = atomic % 1_000_000n;
  return fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(6, "0").replace(/0+$/, "")}`;
}
