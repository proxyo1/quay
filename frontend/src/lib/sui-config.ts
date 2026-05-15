/**
 * Sui network configuration. Values mirror scripts/deploy-mainnet.json
 * (the deploy artifact). Testnet IDs are archived as
 * scripts/deploy-testnet.v{1..4}.json — flip back by restoring the
 * matching block + setting `SUI_NETWORK` to `"testnet"`.
 */

/**
 * Active Sui network for the build. Annotated with the union type (not
 * `as const`) so consumers can branch on `SUI_NETWORK === "mainnet"`
 * without TypeScript collapsing the comparison to a statically-known
 * `false`.
 */
export const SUI_NETWORK: "testnet" | "mainnet" = "mainnet";

export const QUAY = {
  network: "mainnet" as const,
  // chain_id committed on the registry at init. Mainnet = 1 (testnet was 0);
  // the issuer signs over this so a testnet attestation can never replay on
  // mainnet (and vice versa).
  chainId: 1,
  // Mainnet V1 deploy (2026-05-15):
  //   - First mainnet publish; Move source is the V4 testnet code
  //     (adds `update_merchant_metadata`).
  //   - Companion deploy artifact: scripts/deploy-mainnet.json
  packageId: "0xdf4f409344e5e90cb284a9b62b52504817afbecb432dce59cb1bbf08f69296dd",
  registryId: "0x50e3d1a6520b052ee06636808715a336b3d0c9a7cf3e5a7632031629939ddbf1",
  adminCapId: "0xa5c389b37aa21a5d9e033dd76a083319de43f8b8b7147f140050cc3162027e7e",
  adminAddress: "0xa91644aa47914b16b73258c1de984e3296ef15e40a838ffd3b8fa533b27def2f",
  // Same ed25519 issuer key as testnet — issuer pubkey is network-agnostic;
  // the chain_id field above is what prevents cross-network replay.
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
