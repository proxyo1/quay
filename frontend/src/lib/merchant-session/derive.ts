import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { blake2b } from "@noble/hashes/blake2.js";

/**
 * Deterministic per-email Sui keypair derivation.
 *
 * The user's "wallet" is derived from:
 *   seed = blake2b256("SUIQR_MERCHANT_V1" || domain_salt || email_lower)
 *
 * Same email + same domain_salt → same Sui address, every time. The
 * keypair is owned by the user via their email; suiqr never sees it.
 *
 * This is a V0 demo path that gives merchants a real Sui wallet without
 * needing to install a wallet extension or set up Google OAuth. The
 * production path is full Sui zkLogin (Google OAuth + Mysten salt
 * service + ZK proof); see docs/GOOGLE_OAUTH_SETUP.md. Both modes
 * produce the same shape of MerchantSession, so the rest of the app
 * doesn't care which one signed.
 */

const DOMAIN_TAG = "SUIQR_MERCHANT_V1";

/**
 * The salt MUST be the same across runs for a given user. For testnet we
 * hardcode it (anyone with the email can derive the wallet — testnet
 * threat model is fine with that). For mainnet, replace this path with
 * real zkLogin and the salt service.
 */
const TESTNET_SALT = "suiqr-testnet-2026-05-12-v1";

export function deriveMerchantKeypair(email: string): Ed25519Keypair {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) {
    throw new Error(`'${email}' doesn't look like an email`);
  }
  const seedInput = new TextEncoder().encode(`${DOMAIN_TAG}|${TESTNET_SALT}|${normalized}`);
  const seed = blake2b(seedInput, { dkLen: 32 });
  return Ed25519Keypair.fromSecretKey(seed);
}

/** Produce a stable "salt hash" we can show in the UI (not the secret). */
export function emailFingerprint(email: string): string {
  const normalized = email.trim().toLowerCase();
  const bytes = blake2b(new TextEncoder().encode(normalized), { dkLen: 4 });
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
