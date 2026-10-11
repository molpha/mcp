export type InstructionsMode = "stdio" | "read-only" | "hosted";

/**
 * The MCP `instructions` string: what a client shows its model on every session, whether or not it also loads
 * the Molpha skill. Keep it short. Every tool it names in backticks must be registered in that mode (a test
 * enforces it), so a read-only server never points the model at a write tool it does not have.
 */
const COMMON =
  "Molpha returns API data signed by a threshold of oracle nodes. Treat the signed attestation, not the bare value, as the trust anchor. " +
  "`get_capabilities` reports `runLevel`: say what this server is allowed to do before acting. " +
  "`build_verifier_calldata` verifies nothing: the caller runs verify() on EVM or Starknet. " +
  "Solana feeds are keyed by (sourceId, signaturesRequired, submitter). " +
  "This release targets Solana Devnet and Sepolia: testnet only.";

const STDIO =
  "`execute_subscription_round` and `execute_x402_round` spend on every call: never retry one after an unclear error; read state first (`describe_feed`, `get_x402_status`). " +
  "Quote before paying (`get_x402_status`, `quote_source_payment`). " +
  "Preview the first write of a session with dryRun: true and show the user what would be sent. " +
  "If a write is refused with `dry_run_locked`, tell the user: only they can unlock it, in the server's config.";

const READ_ONLY =
  "This server is read-only: it holds no signer, so it can read feeds, quote prices and build calldata, but it cannot sign rounds or spend. " +
  "Offer `derive_source_id`, `list_providers`, `get_provider`, `quote_source_payment`, `get_x402_status`, `describe_feed`, `get_latest_value`, `describe_access` and `build_verifier_calldata`. " +
  "To run signed rounds the user must configure a signer and restart the server (docs/integration.md in github.com/molpha/mcp); do not ask for keys in chat.";

const HOSTED =
  "This server holds no key: every write is prepared here and signed by the caller's own wallet. " +
  "Subscription rounds: `begin_session`, then `complete_session`, then `execute_subscription_round`. " +
  "x402 rounds: `prepare_x402_round`, then `execute_x402_round` with the signed transaction. " +
  "Solana submit: `prepare_submit_attestation`, then `send_signed_transaction`. " +
  "`execute_subscription_round` and `execute_x402_round` spend on every call: never retry one after an unclear error; read state first (`describe_feed`, `get_x402_status`). " +
  "Quote before paying (`get_x402_status`, `quote_source_payment`).";

export function buildInstructions(mode: InstructionsMode): string {
  const specific = mode === "stdio" ? STDIO : mode === "read-only" ? READ_ONLY : HOSTED;
  return `${COMMON} ${specific}`;
}
