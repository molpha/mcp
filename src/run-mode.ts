import { resolveEnvString } from "./config.js";

export type RunMode =
  | { mode: "signer" }
  | { mode: "read-only"; reason: string };

/**
 * Whether the local server holds a signer or runs read-only. Read-only is chosen by `--read-only`,
 * `SIGNER_BACKEND=none`, or by configuring no signer at all, so a bare install is useful instead of offering
 * tools that can only fail. A named backend with missing credentials is still an error, never a downgrade.
 */
export function resolveRunMode(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): RunMode {
  if (argv.includes("--read-only")) return { mode: "read-only", reason: "started with --read-only" };

  const backend = resolveEnvString(env.SIGNER_BACKEND);
  if (backend === "none") return { mode: "read-only", reason: "SIGNER_BACKEND=none" };

  const named = backend !== undefined || resolveEnvString(env.KEYCHAIN_BACKEND) !== undefined;
  const keypair = resolveEnvString(env.OWNER_KEYPAIR ?? env.AGENT_KEYPAIR);
  if (!named && keypair === undefined) {
    return { mode: "read-only", reason: "no signer is configured (set OWNER_KEYPAIR, or SIGNER_BACKEND=keychain with Privy or Turnkey, to enable writes)" };
  }
  return { mode: "signer" };
}
