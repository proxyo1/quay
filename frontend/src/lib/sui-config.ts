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
  // V4 redeploy (2026-05-13): adds `update_merchant_metadata` so a merchant
  // can change their preferred receive token after onboarding via
  // /merchant/wallet. V1-V3 packages archived as scripts/deploy-testnet.v{1,2,3}.json.
  packageId: "0x69297daea3fb456381cc60684d5b9055fff58c7e13f9848943590e62a4ff55eb",
  registryId: "0xefd4116acd7a73881bab888fd96f2ed068a602bc8fda19ef2acc16cd63f1741c",
  adminCapId: "0x681972e3413716b8bf168f1dd4203cc0952081621aa0ac1ced3d1b8a9ef6dc2b",
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
