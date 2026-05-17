/**
 * KYB document cryptography — client-side only (browser).
 *
 * Threat model:
 *   - Server NEVER sees plaintext document bytes or DEKs.
 *   - Merchant browser generates random DEK, AES-256-GCM encrypts doc,
 *     wraps DEK to admin pubkey via NaCl sealed box, uploads ciphertext.
 *   - Admin browser derives X25519 keypair from wallet signature
 *     (deterministic ed25519 sig → HKDF → RFC 7748 clamp), unwraps DEK,
 *     decrypts doc inline. Private key cached only in JS memory.
 *
 * Symbols intentionally exported for /admin/setup, /admin/kyb/[id], and
 * the merchant onboard flow.
 */

import { gcm } from "@noble/ciphers/aes.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import sodium from "libsodium-wrappers";

const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const X25519_KEY_BYTES = 32;
const ED25519_SIG_BYTES = 64;

// Sui signPersonalMessage returns base64 of [scheme_flag(1) || sig(64) || pubkey(32)]
const SUI_SIG_TOTAL_LEN = 97;
const SCHEME_FLAG_ED25519 = 0x00;

// HKDF info string for the X25519 derivation. Bumping this version invalidates
// every existing wrapped DEK — only do so as part of a coordinated rotation.
const DERIVE_INFO_V1 = "QUAY_KYB_DECRYPT_KEY_V1";

let sodiumReadyPromise: Promise<void> | null = null;
async function ensureSodium(): Promise<void> {
  if (!sodiumReadyPromise) sodiumReadyPromise = sodium.ready;
  await sodiumReadyPromise;
}

// ─────────────────────── Document encryption ──────────────────────────

/** Generate a random 32-byte AES-256-GCM data encryption key. */
export function generateDek(): Uint8Array {
  const dek = new Uint8Array(DEK_BYTES);
  crypto.getRandomValues(dek);
  return dek;
}

export interface EncryptedDoc {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

/** AES-256-GCM encrypt; random 12-byte nonce per call. No AAD. */
export function encryptDocument(plaintext: Uint8Array, dek: Uint8Array): EncryptedDoc {
  if (dek.length !== DEK_BYTES) {
    throw new Error(`DEK must be ${DEK_BYTES} bytes, got ${dek.length}`);
  }
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const ciphertext = gcm(dek, nonce).encrypt(plaintext);
  return { ciphertext, nonce };
}

/** AES-256-GCM decrypt; throws on AEAD tag failure (tampered ciphertext or wrong key). */
export function decryptDocument(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  dek: Uint8Array,
): Uint8Array {
  if (dek.length !== DEK_BYTES) {
    throw new Error(`DEK must be ${DEK_BYTES} bytes, got ${dek.length}`);
  }
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`Nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`);
  }
  return gcm(dek, nonce).decrypt(ciphertext);
}

// ──────────────────────────── DEK wrapping ────────────────────────────

/**
 * Wrap a DEK to the admin's X25519 public key using NaCl sealed box.
 * Anonymous sender, recipient-only-decrypt. Output size: input + 48 bytes
 * (32 ephemeral pubkey + 16 MAC).
 */
export async function wrapDek(
  dek: Uint8Array,
  adminX25519PubKey: Uint8Array,
): Promise<Uint8Array> {
  await ensureSodium();
  if (adminX25519PubKey.length !== X25519_KEY_BYTES) {
    throw new Error(`Admin pubkey must be ${X25519_KEY_BYTES} bytes, got ${adminX25519PubKey.length}`);
  }
  return sodium.crypto_box_seal(dek, adminX25519PubKey);
}

/** Reverse of wrapDek. Throws if wrapped bytes were tampered or wrong key. */
export async function unwrapDek(
  wrapped: Uint8Array,
  adminX25519PrivKey: Uint8Array,
  adminX25519PubKey: Uint8Array,
): Promise<Uint8Array> {
  await ensureSodium();
  if (adminX25519PrivKey.length !== X25519_KEY_BYTES) {
    throw new Error(`Admin privkey must be ${X25519_KEY_BYTES} bytes, got ${adminX25519PrivKey.length}`);
  }
  if (adminX25519PubKey.length !== X25519_KEY_BYTES) {
    throw new Error(`Admin pubkey must be ${X25519_KEY_BYTES} bytes, got ${adminX25519PubKey.length}`);
  }
  return sodium.crypto_box_seal_open(wrapped, adminX25519PubKey, adminX25519PrivKey);
}

// ─────────────────────────────── Doc hash ─────────────────────────────

/** blake2b-256(plaintext) — committed into evidence_content at finalize. */
export function kybDocHash(plaintext: Uint8Array): Uint8Array {
  return blake2b(plaintext, { dkLen: 32 });
}

// ─────────────── Wallet signature → deterministic X25519 keypair ──────

/**
 * Sui `signPersonalMessage` returns base64 of:
 *   [scheme_flag(1 byte) || ed25519_sig(64) || pubkey(32)]
 * For HKDF input we need the raw 64-byte ed25519 signature only.
 *
 * Requires scheme flag 0x00 (ed25519). zkLogin (0x05), Secp256k1 (0x01),
 * and Multisig (0x03) signatures are NOT deterministic and would break
 * the same-key-every-session invariant. Admin must use a mnemonic-backed
 * Sui wallet.
 */
export function extractEd25519SigBytes(walletSigBase64: string): Uint8Array {
  const decoded = base64ToBytes(walletSigBase64);
  if (decoded.length !== SUI_SIG_TOTAL_LEN) {
    throw new Error(
      `Sui signature must decode to ${SUI_SIG_TOTAL_LEN} bytes ` +
        `(flag + sig + pubkey), got ${decoded.length}. Likely cause: ` +
        `wallet uses zkLogin or a non-ed25519 scheme.`,
    );
  }
  if (decoded[0] !== SCHEME_FLAG_ED25519) {
    throw new Error(
      `Sui signature scheme flag is 0x${decoded[0]
        .toString(16)
        .padStart(2, "0")}, expected 0x00 (ed25519). ` +
        `Admin wallet must be ed25519 (mnemonic-backed Sui wallet, NOT zkLogin).`,
    );
  }
  return decoded.slice(1, 1 + ED25519_SIG_BYTES);
}

export interface AdminX25519Keypair {
  /** 32 bytes, RFC 7748-clamped. */
  x25519PrivKey: Uint8Array;
  /** 32 bytes, X25519 base-point scalar mult of priv. */
  x25519PubKey: Uint8Array;
}

/**
 * HKDF-SHA256(IKM=sig, salt=empty, info="QUAY_KYB_DECRYPT_KEY_V1", L=32)
 *   → 32-byte seed → RFC 7748 clamp → X25519 priv key
 *   → scalarmult_base(priv) → X25519 pub key
 *
 * Ed25519 signatures are deterministic (RFC 8032), so the same wallet
 * signing the same message produces the same signature, which produces
 * the same X25519 keypair every session. No key storage required.
 */
export async function deriveAdminKeypairFromSignature(
  ed25519SigBytes: Uint8Array,
): Promise<AdminX25519Keypair> {
  if (ed25519SigBytes.length !== ED25519_SIG_BYTES) {
    throw new Error(
      `ed25519 signature must be ${ED25519_SIG_BYTES} bytes, got ${ed25519SigBytes.length}`,
    );
  }
  const info = new TextEncoder().encode(DERIVE_INFO_V1);
  const seed = hkdf(sha256, ed25519SigBytes, new Uint8Array(0), info, 32);

  // RFC 7748 X25519 clamping.
  const priv = new Uint8Array(seed);
  priv[0] &= 248;
  priv[31] &= 127;
  priv[31] |= 64;

  await ensureSodium();
  const pub = sodium.crypto_scalarmult_base(priv);
  return { x25519PrivKey: priv, x25519PubKey: pub };
}

// ───────────────────────────── Encoding ───────────────────────────────

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    s += b[i].toString(16).padStart(2, "0");
  }
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToBase64(b: Uint8Array): string {
  if (typeof window !== "undefined" && typeof window.btoa === "function") {
    let bin = "";
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    return window.btoa(bin);
  }
  return Buffer.from(b).toString("base64");
}

export function base64ToBytes(s: string): Uint8Array {
  if (typeof window !== "undefined" && typeof window.atob === "function") {
    const bin = window.atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}
