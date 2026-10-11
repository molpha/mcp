/**
 * Circle USDC (6 decimals) on EVM chains this server may use for paying API sources.
 * Only these contracts are signed; caps are denominated in USDC base units.
 */
const USDC_BY_NETWORK: Readonly<Record<string, string>> = {
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
};

export function normalizeEvmAddress(address: string): string {
  const trimmed = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return trimmed.toLowerCase();
}

export function expectedUsdcAsset(network: string): string | undefined {
  return USDC_BY_NETWORK[network];
}

export function isAllowedSourcePaymentAsset(network: string, asset: string): boolean {
  const expected = expectedUsdcAsset(network);
  if (!expected) {
    return false;
  }
  return normalizeEvmAddress(asset) === normalizeEvmAddress(expected);
}

/** Refuses startup when a configured network has no known USDC contract. */
export function assertSourcePaymentNetworkSupported(network: string): void {
  const usdc = expectedUsdcAsset(network);
  if (!usdc) {
    throw new Error(
      `MOLPHA_SOURCE_PAYMENT_NETWORKS includes ${network}, which has no known USDC contract on this server. Supported networks: ${Object.keys(USDC_BY_NETWORK).join(", ")}.`
    );
  }
}
