/**
 * Sui network configuration — values mirror scripts/deploy-testnet.json
 * (the deploy artifact). For V0 these are hardcoded for simplicity; a
 * Day 12.5 build step (or NEXT_PUBLIC_* env vars) will pick the right
 * network at build time once we have a mainnet deploy.
 */

export const SUI_NETWORK = "testnet" as const;

export const QUAY = {
  network: "testnet" as const,
  chainId: 0,
  // V3 redeploy (2026-05-13): renames module suiqr::payments → quay::payments
  // and bumps the canonical attestation domain tag to QUAY_CLAIM_V1.
  // V1 + V2 packages archived as scripts/deploy-testnet.v{1,2}.json.
  packageId: "0x70631c59a94e74594af10eabcd20e6cf88564ccca985610c8c1c9b100462a87c",
  registryId: "0xa572e59aa755af7a93c2a0b0216639b3debe6b5ecdb4074c763d3484e879645b",
  adminCapId: "0xfb7a3d740324ff2e158d71f1abffdc81b1495a4de6535fc1461fef850f366c40",
  adminAddress: "0xa91644aa47914b16b73258c1de984e3296ef15e40a838ffd3b8fa533b27def2f",
  issuerPubkeyHex: "5d44735e96af7d30d245936458efc03f5fdc4ba042046848afc4ad9dd8d115c8",
  /** Convenience: the on-chain Clock object ID (same on all networks). */
  clockId: "0x6",
} as const;

/** Sui explorer URL for a transaction digest. */
export function txUrl(digest: string): string {
  return `https://suiscan.xyz/${SUI_NETWORK}/tx/${digest}`;
}

/** Sui explorer URL for an object ID. */
export function objectUrl(id: string): string {
  return `https://suiscan.xyz/${SUI_NETWORK}/object/${id}`;
}
