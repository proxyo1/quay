/**
 * Sui network configuration — values mirror scripts/deploy-testnet.json
 * (the deploy artifact). For V0 these are hardcoded for simplicity; a
 * Day 12.5 build step (or NEXT_PUBLIC_* env vars) will pick the right
 * network at build time once we have a mainnet deploy.
 */

export const SUI_NETWORK = "testnet" as const;

export const SUIQR = {
  network: "testnet" as const,
  chainId: 0,
  packageId: "0x46398f18d42864b8325c0089bd0ae6ba439c85d02510412738ce273c53ce167e",
  registryId: "0x00148a23a4e120142965ed011370b39a42e858174aec98d5fac079a834c1e5e1",
  adminCapId: "0x622f8c06080c324eb1a76d5ba199ab90aeb3a57f2953b12c46c44c1110e1e0ec",
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
