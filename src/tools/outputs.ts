/**
 * Output-schema pieces that more than one tool returns. Each is a factory, not
 * a shared instance: the SDK renders a sub-schema that appears twice in one
 * tool's schema as a `$ref`, which not every client resolves.
 *
 * Values are described as they appear after JSON conversion: bigints, BNs, and
 * u64s become decimal strings, Solana keys become base58 strings.
 */
import { z } from "zod";

const normalizedErrorShape = () => ({
  code: z.string(),
  message: z.string(),
  status: z.number().int().optional(),
  details: z.unknown().optional(),
  remediation: z.string().optional()
});

/** A read that failed inside an otherwise-successful result (see `settle`). */
export const settleFailure = () =>
  z.object({
    ok: z.literal(false),
    label: z.string().describe("Which read failed."),
    error: z.object(normalizedErrorShape())
  });

export const chains = () =>
  z.object({
    solana: z.string(),
    evm: z.array(z.string()).describe("Configured EVM verifier networks (MOLPHA_EVM_NETWORKS)."),
    starknet: z.array(z.string()).describe("Configured Starknet verifier networks (MOLPHA_STARKNET_NETWORKS).")
  });

const verifierDeployment = () =>
  z.object({ network: z.string(), address: z.string().optional(), error: z.string().optional() });

export const verifierMetadata = () =>
  z.object({
    evm: z.array(verifierDeployment()),
    starknet: z.array(verifierDeployment()),
    evmAbi: z.unknown().optional().describe("The EVM verifier ABI, when includeAbi is set.")
  });

/** Contract-ready verify() arguments per requested chain; calldata only, never executed here. */
export const verifierArgs = () =>
  z.object({
    evm: z
      .object({
        verifier: z.array(z.object({ network: z.string(), address: z.string().optional() })),
        chainIds: z.array(z.number().int()),
        args: z.object({
          attestation: z.object({
            payload: z.object({
              value: z.string().describe("bytes32 packed value, 0x hex (a signed int256 in tolerance mode)."),
              sourceId: z.string().describe("bytes32, 0x hex."),
              registryVersion: z.number().int(),
              signaturesRequired: z.number().int(),
              timestamp: z.string().optional().describe("uint64, decimal string, unix milliseconds."),
            }),
            signature: z.object({
              signature: z.string().describe("bytes32 Schnorr scalar s, 0x hex."),
              commitment: z.string().describe("address of the nonce point R."),
              signersBitmap: z.string().describe("uint256, decimal string.")
            })
          }),
          maxAge: z
            .string()
            .describe(
              "verify(attestation, maxAge) freshness window in seconds (uint64, decimal string). 0 disables the check: the stateless verifier then accepts a correctly signed attestation forever, so enforce freshness or ordering in the consumer."
            )
        })
      })
      .optional(),
    starknet: z
      .object({
        verifier: z.string().optional(),
        args: z.object({
          attestation: z.object({
            payload: z.object({
              value: z.string().describe("u256, decimal string (a signed int256's two's-complement bits in tolerance mode)."),
              source_id: z.string().describe("u256, decimal string."),
              registry_version: z.number().int(),
              signatures_required: z.number().int(),
              // `timestamp` (unix milliseconds) in the current SDK; `canonical_timestamp` in the one this server
              // was first built against. Either is accepted.
              timestamp: z.number().int().optional(),
              canonical_timestamp: z.number().int().optional()
            }),
            signature: z.object({
              signature: z.string().describe("u256, decimal string."),
              commitment: z.string().describe("Felt, decimal string."),
              signers_bitmap: z.string().describe("u256, decimal string.")
            })
          }),
          maxAge: z
            .number()
            .int()
            .describe(
              "verify(attestation, max_age) freshness window in seconds. 0 disables the check: the stateless verifier then accepts a correctly signed attestation forever, so enforce freshness or ordering in the consumer."
            )
        })
      })
      .optional(),
    errors: z
      .array(z.object({ target: z.string(), message: z.string() }))
      .optional()
      .describe("Chains whose arguments could not be built, and why.")
  });

/** A Solana feed account as the feed tools present it. */
export const feedAccount = () =>
  z
    .object({
      sourceId: z.string().describe("0x-prefixed hex."),
      value: z.string().describe("Stored bytes, 0x-prefixed hex: the raw payload or its keccak digest, per valueKind."),
      valueKind: z
        .union([z.enum(["value", "hash"]), z.record(z.unknown())])
        .describe("Attested encoding of `value` — not a scale hint. Molpha attests no decimals."),
      valueKindMeaning: z.string().optional(),
      // The program's feed account names this `timestamp`, in unix MILLISECONDS (the gateway assigns it); the
      // program this server was first built against called it `timestamp`, in seconds. Whichever the
      // installed SDK decodes is passed through, so a correct feed read is never rejected for its key.
      timestamp: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Unix MILLISECONDS of the stored attestation (u64, decimal string). Divide by 1000 for seconds."),
      signaturesRequired: z.number().int(),
      signersBitmap: z.string().describe("0x-prefixed hex."),
      registryVersion: z.number().int(),
      bump: z.number().int().optional()
    })
    .passthrough();

/** What a Solana submit returns (submit_attestation, or a round tool's autoSubmit). */
export const submitOutcome = () =>
  z.object({
    chain: z.literal("solana"),
    action: z.literal("submit_attestation"),
    sourceId: z.string(),
    signaturesRequired: z.number().int(),
    submitter: z.string().describe("Wallet that paid for the write; Solana feeds are keyed per submitter."),
    feed: z.string().describe("Feed PDA written."),
    signature: z.string().describe("Solana transaction signature.")
  });

/** A failed autoSubmit: the signed artifact is still in the response. */
export const submitFailure = () =>
  z.object({
    ok: z.literal(false),
    ...normalizedErrorShape(),
    retry: z.string()
  });

/** The USDC payment an x402 round settled. */
export const x402PaymentReceipt = () =>
  z.object({
    endpoint: z.string(),
    network: z.string().describe("CAIP-2 id of the Solana cluster."),
    payer: z.string(),
    payTo: z
      .string()
      .describe("Where payment went: the protocol treasury owner (ProtocolConfig PDA), not the gateway."),
    asset: z.string().describe("USDC mint."),
    amountAtomicUsdc: z.string(),
    feePayer: z.string(),
    memo: z
      .string()
      .describe("The request's commitment (deployment, gateway, source, quorum, registry version); every payment for the same request carries it."),
    transaction: z.string().optional().describe("Settlement transaction, when the gateway reports one.")
  });
