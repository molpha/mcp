import { address, type Address } from "@solana/kit";

export function parseSolanaPubkey(value: string, envVar: string): Address {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${envVar} is required`);
  }

  try {
    return address(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${envVar} must be a valid Solana address (base58 pubkey), got ${JSON.stringify(value)}: ${message}`,
      { cause: error }
    );
  }
}

export function validateSolanaPubkey(value: string | undefined, envVar: string): { ok: true } | { ok: false; message: string } {
  if (!value?.trim()) {
    return { ok: false, message: `${envVar} is required` };
  }

  try {
    parseSolanaPubkey(value, envVar);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
