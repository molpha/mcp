import { address, type Address } from "@solana/kit";
import { Connection, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import { loadConfig, type MolphaConfig } from "./config.js";
import { parseSolanaPubkey } from "./solana-address.js";
import { toLegacyPublicKey } from "./solana-compat.js";
import { requireSdkExport } from "./sdk.js";
import { createSigner } from "./signer/factory.js";
import type { MolphaSigner } from "./signer/types.js";

export interface MolphaContext {
  hosted?: boolean;
  lifecycle?: RequestLifecycle;
  config: MolphaConfig;
  gateway: Record<string, unknown>;
  solana: Record<string, unknown>;
  signer: MolphaSigner;
  connection: Connection;
}

export interface RequestLifecycle {
  signal: AbortSignal;
  /** Public reconciliation data only; never credentials or tool arguments. */
  reconciliation?: Record<string, unknown>;
  effectStarted?: boolean;
}

export type RequestContext = Omit<MolphaContext, "signer"> & {
  signer?: MolphaSigner;
};
export interface SharedRuntime {
  config: MolphaConfig;
  connection: Connection;
}
export interface ToolDependencies {
  getContext?: () => Promise<RequestContext>;
  config?: MolphaConfig;
}

export function assertActive(context: RequestContext): void {
  context.lifecycle?.signal.throwIfAborted();
}

export function requireSigner(context: RequestContext): asserts context is RequestContext & { signer: MolphaSigner } {
  if (!context.signer) {
    throw Object.assign(new Error("Supply X-Molpha-Signer and managed-signer headers, or use npx @molpha/mcp locally."), {
      code: "authentication_required"
    });
  }
  assertActive(context);
}

/** Loads only non-credential settings in hosted mode. */
export function getSharedRuntime(env: NodeJS.ProcessEnv = process.env): SharedRuntime {
  const allowed = ["GATEWAY_ENDPOINTS", "GATEWAY_AUTHORITIES", "SOLANA_RPC", "MOLPHA_EVM_NETWORKS",
    "MOLPHA_STARKNET_NETWORKS", "MOLPHA_DRY_RUN", "MOLPHA_X402_MAX_PRICE_USDC",
    "MOLPHA_MAX_EXECUTES_PER_DAY", "MOLPHA_X402_MAX_SPEND_PER_DAY_USDC"];
  const config = loadConfig(Object.fromEntries(allowed.map(key => [key, env[key]])));
  if (env.MOLPHA_HTTP_DAILY_CAPS !== undefined && !["true", "false"].includes(env.MOLPHA_HTTP_DAILY_CAPS)) {
    throw new Error("MOLPHA_HTTP_DAILY_CAPS must be true or false");
  }
  config.guardrails.dailyCapsEnabled = env.MOLPHA_HTTP_DAILY_CAPS === "true";
  config.x402.dailyCapsEnabled = config.guardrails.dailyCapsEnabled;
  return { config, connection: new Connection(config.solanaRpc, "confirmed") };
}

export function createRequestContext(runtime: SharedRuntime, signer?: MolphaSigner, lifecycle?: RequestLifecycle): RequestContext {
  const guarded = signer && lifecycle ? guardSigner(signer, lifecycle) : signer;
  const wallet = guarded ?? {
    publicKey: address("11111111111111111111111111111111"),
    isAvailable: async () => false,
    signMessage: async () => { throw new Error("Read-only wallet cannot sign"); },
    signTransaction: async () => { throw new Error("Read-only wallet cannot sign"); },
    signAllTransactions: async () => { throw new Error("Read-only wallet cannot sign"); }
  };
  const solana = createSolanaClient(runtime.config, wallet, runtime.connection);
  return {
    ...runtime, solana, gateway: createGateway(runtime.config, solana, guarded), hosted: true,
    ...(guarded ? { signer: guarded } : {}), ...(lifecycle ? { lifecycle } : {})
  };
}

function guardSigner(signer: MolphaSigner, lifecycle: RequestLifecycle): MolphaSigner {
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    lifecycle.signal.throwIfAborted();
    const result = await run();
    lifecycle.signal.throwIfAborted();
    return result;
  };
  return {
    publicKey: signer.publicKey,
    isAvailable: () => guard(() => signer.isAvailable()),
    signMessage: msg => guard(() => signer.signMessage(msg)),
    signTransaction: tx => guard(() => signer.signTransaction(tx)),
    signAllTransactions: txs => guard(() => signer.signAllTransactions(txs))
  };
}

let cachedContextPromise: Promise<MolphaContext> | undefined;

export function getMolphaContext(): Promise<MolphaContext> {
  cachedContextPromise ??= createMolphaContext(loadConfig());
  return cachedContextPromise;
}

export async function createMolphaContext(config: MolphaConfig): Promise<MolphaContext> {
  const signer = await createSigner(config);
  const connection = new Connection(config.solanaRpc, "confirmed");
  const solana = createSolanaClient(config, signer, connection);

  return {
    config,
    gateway: createGateway(config, solana, signer),
    solana,
    signer,
    connection
  };
}

export function createGateway(
  config: MolphaConfig,
  solana: Record<string, unknown>,
  signer?: MolphaSigner
): Record<string, unknown> {
  const Gateway = requireSdkExport<new (...args: unknown[]) => Record<string, unknown>>("MolphaGateway");
  // SDK Signer type = (message: Uint8Array) => Promise<Uint8Array>
  const defaultSigner = signer ? (msg: Uint8Array) => signer.signMessage(msg) : undefined;
  // Request auth binds each gateway's PDA; without a configured authority the SDK
  // looks it up via GET /v1/info, which not every gateway serves.
  const endpoints = config.gatewayEndpoints.map((url, index) => {
    const gatewayAuthority = config.gatewayAuthorities[index];
    return gatewayAuthority ? { url, gatewayAuthority } : url;
  });

  return new Gateway(
    endpoints,
    () => requireMethod<[], Promise<Record<string, unknown>>>(solana, "getRegistrySelectionConfig")(),
    defaultSigner,
    {
      ...(signer ? { defaultSubscriptionOwner: signer.publicKey } : {}),
      // Private API secrets are only encrypted to node keys that match the on-chain registry.
      verifyNodeKeys: (args: unknown) =>
        requireMethod<[unknown], Promise<void>>(solana, "verifyNodeKeysForPrivateApi")(args)
    }
  );
}

export function createSolanaClient(
  config: MolphaConfig,
  signer: MolphaSigner,
  connection: Connection = new Connection(config.solanaRpc, "confirmed")
): Record<string, unknown> {
  const SolanaClient = requireSdkExport<{
    create: (opts: Record<string, unknown>) => Record<string, unknown>;
  }>("MolphaSolanaClient");
  const wallet = {
    publicKey: toLegacyPublicKey(signer.publicKey),
    signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => signer.signTransaction(tx),
    signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]) => signer.signAllTransactions(txs),
  };

  return SolanaClient.create({
    connection,
    wallet
  });
}

export function getMolphaProgramId(): Address {
  return parseSolanaPubkey(requireSdkExport<string>("MOLPHA_PROGRAM_ADDRESS"), "MOLPHA_PROGRAM_ADDRESS");
}

export function requireMethod<TArgs extends unknown[], TResult>(
  target: Record<string, unknown>,
  methodName: string
): (...args: TArgs) => TResult {
  const method = target[methodName];
  if (typeof method !== "function") {
    throw new Error(`Molpha SDK client is missing ${methodName}()`);
  }

  return method.bind(target) as (...args: TArgs) => TResult;
}
