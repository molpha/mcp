import { z } from "zod";
import { getMolphaContext, type ToolDependencies } from "../clients.js";
import { settle } from "../errors.js";
import { x402SpentToday } from "../guardrails.js";
import { toolHandler } from "../mcp.js";
import { fetchX402Status } from "../x402.js";
import { readPayerUsdc } from "../x402-payment.js";
import { settleFailure } from "./outputs.js";
import { signaturesRequiredSchema } from "./schemas.js";
import { type ToolServer } from "./types.js";

const outputSchema = z.object({
  endpoint: z.string().describe("The gateway that answered."),
  signaturesRequired: z.union([z.number().int(), z.literal("protocol minimum")]),
  quotedNextPriceAtomicUsdc: z.string(),
  withinPerRoundCap: z.boolean().describe("Whether the quote is within MOLPHA_X402_MAX_PRICE_USDC."),
  gateway: z
    .object({
      gateway: z.string().describe("The Gateway account PDA."),
      authority: z.string(),
      payTo: z.string().describe("Where payment goes: the protocol treasury owner (ProtocolConfig PDA), not the gateway."),
      treasuryAta: z.string().describe("The treasury's USDC token account."),
      pendingTickets: z.number().int().describe("Rounds the gateway still owes an on-chain submit_ticket for.")
    })
    .describe("The gateway and the protocol treasury it quotes for. Callers do not fund the gateway; the payment is the whole cost of a round."),
  note: z.string().optional(),
  payer: z.string().optional(),
  payerUsdc: z
    .union([
      z.object({ usdcMint: z.string(), ata: z.string(), exists: z.boolean(), balanceAtomicUsdc: z.string() }),
      settleFailure()
    ])
    .optional()
    .describe("The signer's USDC, which pays each round."),
  caps: z.object({
    dailyCapsEnabled: z.boolean().optional(),
    maxPriceUsdcAtomic: z.string(),
    maxSpendPerDayUsdcAtomic: z.string().optional(),
    spentTodayUsdcAtomic: z.string().optional(),
    remainingTodayUsdcAtomic: z.string().optional()
  }),
  warning: z.string().optional()
});

export function registerGetX402StatusTool(server: ToolServer, dependencies: ToolDependencies = {}): void {
  server.registerTool(
    "get_x402_status",
    {
      title: "Get x402 gateway status",
      description:
        "Advisory read before execute_x402_round: the next x402 round's quoted price for a quorum; where payment goes (the protocol treasury, which the gateway does not control) and the rounds the gateway still has to submit tickets for; the signer's own USDC balance, which pays each round; and the remaining MOLPHA_X402_MAX_SPEND_PER_DAY_USDC budget. Signs and spends nothing.",
      inputSchema: {
        signaturesRequired: signaturesRequiredSchema
          .optional()
          .describe("Quorum to quote. Omit for the protocol minimum (min_signers).")
      },
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    toolHandler(outputSchema, async ({ signaturesRequired }: { signaturesRequired?: number }) => {
      const { config, signer, connection, lifecycle } = await (dependencies.getContext ?? getMolphaContext)();
      const [{ endpoint, status }, payerUsdc] = await Promise.all([
        fetchX402Status(config, signaturesRequired, lifecycle?.signal),
        signer ? settle("solana.readPayerUsdc", () => readPayerUsdc(connection, signer.publicKey)) : Promise.resolve(undefined)
      ]);

      const price = BigInt(status.quotedNextPrice);
      const { maxPriceUsdcAtomic, maxSpendPerDayUsdcAtomic } = config.x402;
      const spentToday = x402SpentToday();
      const pinnedAuthority = config.gatewayAuthorities[config.gatewayEndpoints.indexOf(endpoint)];

      return {
        endpoint,
        signaturesRequired: signaturesRequired ?? "protocol minimum",
        quotedNextPriceAtomicUsdc: status.quotedNextPrice,
        withinPerRoundCap: price <= maxPriceUsdcAtomic,
        gateway: {
          gateway: status.gateway,
          authority: status.authority,
          payTo: status.payTo,
          treasuryAta: status.treasuryAta,
          pendingTickets: status.pendingTickets
        },
        ...(signer && payerUsdc ? { payer: signer.publicKey, payerUsdc: payerUsdc.ok ? payerUsdc.value : payerUsdc }
          : { note: "Payer details omitted: supply managed-signer headers for payer balances." }),
        caps: {
          maxPriceUsdcAtomic: maxPriceUsdcAtomic.toString(),
          ...(config.x402.dailyCapsEnabled === false ? { dailyCapsEnabled: false } : {
            maxSpendPerDayUsdcAtomic: maxSpendPerDayUsdcAtomic.toString(),
            spentTodayUsdcAtomic: spentToday.toString(),
            remainingTodayUsdcAtomic: (spentToday < maxSpendPerDayUsdcAtomic
              ? maxSpendPerDayUsdcAtomic - spentToday
              : 0n
            ).toString()
          })
        },
        ...(pinnedAuthority && pinnedAuthority !== status.authority
          ? {
              warning: `the gateway reports authority ${status.authority}, but GATEWAY_AUTHORITIES pins ${pinnedAuthority}; execute_x402_round will refuse to pay it`
            }
          : {})
      };
    })
  );
}
