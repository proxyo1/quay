import { Transaction } from "@mysten/sui/transactions";

import { SUIQR } from "@/lib/sui-config";

export interface BuildRegisterTxInputs {
  /** Raw UEN string (e.g., "202412345Z"). Encoded as vector<u8> on chain. */
  uen: string;
  /** 32-byte nonce that was included in the canonical ClaimMessage. */
  nonce: Uint8Array;
  /** 64-byte ed25519 signature over blake2b256(BCS(ClaimMessage)) by the issuer key. */
  attestation: Uint8Array;
  /** Unix-ms expiry encoded in the ClaimMessage. The Move side enforces clock <= expires_at_ms. */
  expiresAtMs: bigint;
  /** Optional merchant profile pointer (https/ipfs URI). Frontend allowlist (AD30). */
  metadataUri?: string;
}

/**
 * Build a `payments::register_merchant` PTB. The merchant is the tx sender;
 * the registered MerchantEntry will record `tx_context::sender()` as the
 * merchant address. The issuer signature must be over the same ClaimMessage
 * (chain_id, UEN, claimer, nonce, expires_at_ms) using the BCS shape the
 * Move side reconstructs.
 */
export function buildRegisterTx(input: BuildRegisterTxInputs): Transaction {
  if (input.attestation.length !== 64) {
    throw new Error(`expected 64-byte ed25519 sig, got ${input.attestation.length}`);
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${SUIQR.packageId}::payments::register_merchant`,
    arguments: [
      tx.object(SUIQR.registryId),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(input.uen))),
      tx.pure.vector("u8", Array.from(input.nonce)),
      tx.pure.vector("u8", Array.from(input.attestation)),
      tx.pure.u64(input.expiresAtMs),
      input.metadataUri
        ? tx.pure.option("string", input.metadataUri)
        : tx.pure.option("string", null),
      tx.object(SUIQR.clockId),
    ],
  });
  return tx;
}

/** Allowlist for the optional metadata URI per AD30: https or ipfs only. */
export function isAllowedMetadataUri(uri: string): boolean {
  return /^(https:\/\/|ipfs:\/\/)[A-Za-z0-9._\-/?=:#&%]+$/.test(uri);
}
