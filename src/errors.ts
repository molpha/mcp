import { ROUND_TICK_MS } from "./protocol.js";

export interface NormalizedToolError {
  code: string;
  message: string;
  status?: number;
  details?: unknown;
  remediation?: string;
}

export type SettleResult<T> =
  | { ok: true; value: T }
  | { ok: false; label: string; error: NormalizedToolError };

/** Runs `run()`, capturing a failure as a normalized error instead of throwing. */
export async function settle<T>(label: string, run: () => Promise<T>): Promise<SettleResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, label, error: normalizeError(error) };
  }
}

/** Codes an error names for itself; they are reported as given instead of being inferred from its text. */
const OWN_CODES = new Set([
  "authentication_required",
  "submitter_required",
  "missing_config",
  "invalid_challenge",
  "payment_expired",
  "transaction_expired",
  "signed_transaction_mismatch",
  "invalid_signature",
  "sign_in_rejected",
  "session_invalid",
  "sessions_unavailable",
  "source_payment_disabled",
  "source_payment_refused",
  "dry_run_locked"
]);

/** What to do next, for the own codes that have a clear next step. */
const OWN_REMEDIATION: Record<string, string> = {
  source_payment_disabled:
    "Paying a source needs a payer wallet and an explicit network allowlist on the server: set MOLPHA_SOURCE_PAYER_KEY (an EVM key) and MOLPHA_SOURCE_PAYMENT_NETWORKS (e.g. eip155:84532 for Base Sepolia). Nothing is paid until both are set.",
  source_payment_refused:
    "Nothing was signed or paid. Call quote_source_payment to see the price, network and worst case, then retry with a sourcePayment.maxSpendUsdc that covers it, if it is within this server's caps.",
  dry_run_locked:
    "Retry with dryRun: true (or omit it) to preview. To run live, the user must set MOLPHA_DRY_RUN=false (or remove it) in the server's config and restart it; do not ask for a per-call override."
};

export function normalizeError(error: unknown): NormalizedToolError {
  const ownCode = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (typeof ownCode === "string" && OWN_CODES.has(ownCode)) {
    return {
      code: ownCode,
      message: error instanceof Error ? error.message : "Invalid request",
      ...(OWN_REMEDIATION[ownCode] ? { remediation: OWN_REMEDIATION[ownCode] } : {})
    };
  }

  // The source is paywalled and the call did not authorize paying it. The quote says what it would cost.
  if (error instanceof Error && error.name === "UpstreamPaymentRequiredError") {
    return {
      code: "source_payment_required",
      message: error.message,
      details: (error as Error & { quote?: unknown }).quote,
      remediation:
        "This source charges per fetch. Call quote_source_payment for the price and worst case, then retry execute_subscription_round with sourcePayment.maxSpendUsdc to authorize paying it (needs a payer wallet configured on the server)."
    };
  }
  const status = getStatus(error);
  const message = error instanceof Error ? error.message : String(error);

  // Checked first: a payment went out and the gateway's answer does not say
  // whether it settled, whatever HTTP status that answer carried.
  if (error instanceof Error && error.name === "X402PaymentOutcomeUnknownError") {
    return {
      code: "payment_outcome_unknown",
      message,
      details: (error as Error & { reconciliation?: unknown }).reconciliation,
      remediation:
        "Do not pay for this round again yet: the signed USDC transfer may have settled. Its blockhash expires within about two minutes; after that, look for a transfer to details.payTo carrying details.memo in the signer's USDC account before retrying. A retry is a new round and signs a new payment: the gateway does not accept this one again once its round reached the nodes, even if that round failed (for example HTTP 503 because too few nodes accepted it). One case spent nothing: details.httpStatus 503 with details.gatewayMessage `gateway at capacity` is the gateway's own capacity limit, which refuses a request before reading it."
    };
  }

  if (status === 400) {
    return withStatus("invalid_request", message, status);
  }

  if (status === 401) {
    return {
      ...withStatus("unauthorized", message, status),
      remediation:
        "The request signature binds the program, gateway PDA, sourceId, and quorum. Ensure OWNER_KEYPAIR is the subscription owner and GATEWAY_AUTHORITIES names each gateway's authority."
    };
  }

  if (status === 402) {
    const payload = getX402Payload(error);
    return {
      ...withStatus("payment_required", message, status),
      remediation:
        "The gateway rejected the x402 payment (see details.error). Check the signer's USDC balance and the x402 caps with get_x402_status, then retry, or use execute_subscription_round with an active subscription.",
      ...(payload !== undefined ? { details: payload } : {})
    };
  }

  if (status === 403) {
    return {
      ...withStatus("forbidden", message, status),
      remediation:
        "The gateway refused this signer's subscription (missing, expired, or out of quota). Extend it via the bootstrap CLI, or use execute_x402_round for a self-funded round."
    };
  }

  // Checked before the message is searched for "subscription": the gateway's 409 names the subscription.
  if (status === 409) {
    return {
      ...withStatus("round_conflict", message, status),
      remediation:
        `This consumer or payer already has a round for this feed (the same source and quorum) in the current ${ROUND_TICK_MS} ms tick, or (x402) this payment already reserved a round. Nothing was reserved for this request. Rounds run on a ${ROUND_TICK_MS} ms tick: requests for one feed in the same tick share a round, so a feed runs at most ${1000 / ROUND_TICK_MS} rounds per second and one consumer gets at most one round per tick. Wait at least ${ROUND_TICK_MS} ms, then call again for a new round; an x402 call signs a new payment.`
    };
  }

  if (status === 503) {
    return {
      ...withStatus("round_timeout", message, status),
      remediation:
        "The gateway did not complete the round. The usual cause is the gateway's own capacity limit (`gateway at capacity`): it refuses the request before reading it, so nothing was reserved or spent. Otherwise too few nodes accepted or finished the round (a node refuses a gateway only as a safety limit), or the round timed out. Wait before retrying, and read state first (describe_feed, get_x402_status): a retry is a new round."
    };
  }

  if (isTimeout(error)) {
    return withStatus("round_timeout", message, status);
  }

  if (message.includes("OWNER_KEYPAIR") || message.includes("AGENT_KEYPAIR")) {
    return {
      code: "missing_config",
      message,
      remediation: "Set OWNER_KEYPAIR to the funded owner keypair JSON path in the MCP server env."
    };
  }

  if (
    message.includes("must be a valid Solana address") ||
    message.includes("Non-base58 character")
  ) {
    return {
      code: "invalid_config",
      message,
      remediation:
        "Check PRIVY_WALLET_ADDRESS / TURNKEY_WALLET_ADDRESS and GATEWAY_AUTHORITIES in your MCP env. Use real Solana devnet pubkeys — not placeholders like <base58-solana-address>."
    };
  }

  if (message.includes("GATEWAY_AUTHORITIES")) {
    return { code: "invalid_config", message };
  }

  if (message.includes("/v1/info")) {
    return {
      code: "invalid_config",
      message,
      remediation:
        "This gateway does not publish its identity at GET /v1/info. Set GATEWAY_AUTHORITIES to each gateway's base58 authority, in GATEWAY_ENDPOINTS order."
    };
  }

  if (message.includes("Subscription") || message.includes("subscription")) {
    return {
      code: "subscription_inactive",
      message,
      remediation: "Run the bootstrap CLI to subscribe, or use execute_x402_round for a self-funded round."
    };
  }

  if (message.includes("cap reached")) {
    return { code: "guardrail_exceeded", message };
  }

  if (message.includes('"jsonrpc"') && message.includes("Method not found")) {
    return {
      code: "invalid_config",
      message,
      remediation:
        "GATEWAY_ENDPOINTS is pointing at a Solana RPC URL, not a Molpha gateway. Set it to the Molpha gateway base URL (see README / `molpha-mcp doctor`) and keep SOLANA_RPC separate."
    };
  }

  if (message.includes("/v1/x402/execute") && message.includes("page not found")) {
    return {
      code: "invalid_config",
      message,
      remediation:
        "This gateway host exposes /v1/nodes but not signing routes. Use https://dev-gateway.molpha.io (run `molpha-mcp doctor` to verify)."
    };
  }

  if (message.includes("determinism") || message.includes("live-drifting")) {
    return { code: "determinism_rejected", message };
  }

  return withStatus("internal_error", message, status);
}

function withStatus(code: string, message: string, status: number | undefined): NormalizedToolError {
  return status === undefined ? { code, message } : { code, message, status };
}

function getStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const record = error as Record<string, unknown>;
  const response = record.response as Record<string, unknown> | undefined;
  const cause = record.cause as Record<string, unknown> | undefined;
  const status = record.status ?? record.statusCode ?? response?.status ?? cause?.status;

  return typeof status === "number" ? status : undefined;
}

function getX402Payload(error: unknown): unknown {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  return (error as Record<string, unknown>).x402;
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : undefined;
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  return code === "ETIMEDOUT" || code === "ECONNRESET" || message.includes("timeout");
}
