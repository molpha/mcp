import type { ToolDependencies } from "../clients.js";
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

export function registerTools(server: ToolServer, dependencies: ToolDependencies = {}): void {
  registerGetCapabilitiesTool(server, dependencies);
  registerDeriveSourceIdTool(server, dependencies);
  registerDescribeFeedTool(server, dependencies);
  registerGetLatestValueTool(server, dependencies);
  registerGetX402StatusTool(server, dependencies);
  registerExecuteSubscriptionRoundTool(server, dependencies);
  registerExecuteX402RoundTool(server, dependencies);
  registerBuildVerifierCalldataTool(server, dependencies);
  registerSubmitAttestationTool(server, dependencies);
}
