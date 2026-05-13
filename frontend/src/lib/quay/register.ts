import { Transaction } from "@mysten/sui/transactions";

import { QUAY } from "@/lib/sui-config";

export interface BuildRegisterTxInputs {
  /** Raw UEN string (e.g., "202412345Z"). Encoded as vector<u8> on chain. */
  uen: string;
  /** 32-byte nonce that was included in the canonical ClaimMessage. */
  nonce: Uint8Array;
  /** 64-byte ed25519 signature over blake2b256(BCS(ClaimMessage)) by the issuer key. */
  attestation: Uint8Array;
  /** Unix-ms expiry encoded in the ClaimMessage. The Move side enforces clock <= expires_at_ms. */
  expiresAtMs: bigint;
  /**
   * Bare Walrus blob ID for the merchant's profile (logo), per D5.
   * The frontend constructs the aggregator URL on read.
   * Undefined → on-chain `metadata_uri` is None (no logo).
   */
  metadataBlobId?: string;
  /**
   * 32-byte blake2b256 of the issuer-verified evidence content, per D8.
   * Must match the `evidence_hash` the issuer signed inside ClaimMessage.
   */
  evidenceHash: Uint8Array;
}

/**
 * Build a `payments::register_merchant` PTB. The merchant is the tx sender;
 * the registered MerchantEntry will record `tx_context::sender()` as the
 * merchant address. The issuer signature must be over the same ClaimMessage
 * (chain_id, UEN, claimer, nonce, expires_at_ms, evidence_hash) using the
 * BCS shape the Move side reconstructs.
 */
export function buildRegisterTx(input: BuildRegisterTxInputs): Transaction {
  if (input.attestation.length !== 64) {
    throw new Error(`expected 64-byte ed25519 sig, got ${input.attestation.length}`);
  }
  if (input.evidenceHash.length !== 32) {
    throw new Error(`expected 32-byte evidence_hash, got ${input.evidenceHash.length}`);
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${QUAY.packageId}::payments::register_merchant`,
    arguments: [
      tx.object(QUAY.registryId),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(input.uen))),
      tx.pure.vector("u8", Array.from(input.nonce)),
      tx.pure.vector("u8", Array.from(input.attestation)),
      tx.pure.u64(input.expiresAtMs),
      input.metadataBlobId
        ? tx.pure.option("string", input.metadataBlobId)
        : tx.pure.option("string", null),
      tx.pure.vector("u8", Array.from(input.evidenceHash)),
      tx.object(QUAY.clockId),
    ],
  });
  return tx;
}

/**
 * Validate a bare Walrus blob ID per D5. Walrus blob IDs are base64url-encoded
 * 32-byte digests (typically 43-44 chars; the trailing `=` padding is omitted).
 * Reject anything else to keep the on-chain field disciplined.
 */
export function isAllowedBlobId(s: string): boolean {
  return /^[A-Za-z0-9_-]{40,48}$/.test(s);
}
