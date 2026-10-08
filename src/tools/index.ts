import type { ToolDependencies } from "../clients.js";
import { registerBuildVerifierCalldataTool } from "./build_verifier_calldata.js";
import { registerDeriveSourceIdTool } from "./derive_source_id.js";
import { registerDescribeAccessTool } from "./describe_access.js";
import { registerDescribeFeedTool } from "./describe_feed.js";
import { registerExecuteSubscriptionRoundTool } from "./execute_subscription_round.js";
import { registerExecuteX402RoundTool } from "./execute_x402_round.js";
import { registerGetCapabilitiesTool } from "./get_capabilities.js";
import { registerGetLatestValueTool } from "./get_latest_value.js";
import { registerGetX402StatusTool } from "./get_x402_status.js";
import { registerGetProviderTool, registerListProvidersTool } from "./providers.js";
import { registerQuoteSourcePaymentTool } from "./quote_source_payment.js";
import { registerBeginSessionTool } from "./hosted/begin_session.js";
import { registerCompleteSessionTool } from "./hosted/complete_session.js";
import { registerExecuteSessionRoundTool } from "./hosted/execute_subscription_round.js";
import { registerExecutePreparedX402RoundTool } from "./hosted/execute_x402_round.js";
import { registerPrepareSubmitAttestationTool } from "./hosted/prepare_submit_attestation.js";
import { registerPrepareX402RoundTool } from "./hosted/prepare_x402_round.js";
import { registerSendSignedTransactionTool } from "./hosted/send_signed_transaction.js";
import { registerSubmitAttestationTool } from "./submit_attestation.js";
import { type ToolServer } from "./types.js";

/**
 * The stdio server holds a signer and offers each operation as one call. The hosted server
 * (`dependencies.hosted`) holds none: the same operations take the caller's wallet address and
 * are split around the one step only that wallet can do, signing.
 */
export function registerTools(server: ToolServer, dependencies: ToolDependencies = {}): void {
  registerGetCapabilitiesTool(server, dependencies);
  registerDeriveSourceIdTool(server, dependencies);
  registerDescribeFeedTool(server, dependencies);
  registerGetLatestValueTool(server, dependencies);
  registerDescribeAccessTool(server, dependencies);
  registerGetX402StatusTool(server, dependencies);
  registerBuildVerifierCalldataTool(server, dependencies);
  // Provider discovery and a price quote need no signer, so every server offers them.
  registerListProvidersTool(server, dependencies);
  registerGetProviderTool(server, dependencies);
  registerQuoteSourcePaymentTool(server, dependencies);
  if (dependencies.hosted) {
    registerBeginSessionTool(server, dependencies);
    registerCompleteSessionTool(server, dependencies);
    registerExecuteSessionRoundTool(server, dependencies);
    registerPrepareX402RoundTool(server, dependencies);
    registerExecutePreparedX402RoundTool(server, dependencies);
    registerPrepareSubmitAttestationTool(server, dependencies);
    registerSendSignedTransactionTool(server, dependencies);
  } else {
    registerExecuteSubscriptionRoundTool(server, dependencies);
    registerExecuteX402RoundTool(server, dependencies);
    registerSubmitAttestationTool(server, dependencies);
  }
}
