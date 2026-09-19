import { registerBuildVerifierCalldataTool } from "./build_verifier_calldata.js";
import { registerDeriveSourceIdTool } from "./derive_source_id.js";
import { registerDescribeFeedTool } from "./describe_feed.js";
import { registerExecuteSubscriptionRoundTool } from "./execute_subscription_round.js";
import { registerExecuteX402RoundTool } from "./execute_x402_round.js";
import { registerGetCapabilitiesTool } from "./get_capabilities.js";
import { registerGetLatestValueTool } from "./get_latest_value.js";
import { registerGetX402StatusTool } from "./get_x402_status.js";
import { registerSubmitAttestationTool } from "./submit_attestation.js";
import { type ToolServer } from "./types.js";

export function registerTools(server: ToolServer): void {
  registerGetCapabilitiesTool(server);
  registerDeriveSourceIdTool(server);
  registerDescribeFeedTool(server);
  registerGetLatestValueTool(server);
  registerGetX402StatusTool(server);
  registerExecuteSubscriptionRoundTool(server);
  registerExecuteX402RoundTool(server);
  registerBuildVerifierCalldataTool(server);
  registerSubmitAttestationTool(server);
}
