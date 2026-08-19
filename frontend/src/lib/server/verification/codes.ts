import "server-only";

import { randomInt, timingSafeEqual } from "node:crypto";

import { blake2b } from "@noble/hashes/blake2.js";

/**
 * Reference codes for the PayNow micro-deposit.
 *
 * The code travels in the PayNow reference of a S$0.01 transfer to the UEN
 * on the merchant's SGQR sticker. They read it off their bank statement and
 * type it back, which proves they can see deposits into that account — the
 * exact account the sticker pays into.
 *
 * Three constraints shape the format:
 *
 *   1. It must survive the reference field. `lib/server/wise.ts` slices to 35
 *      chars, but the inbound customer reference a merchant actually reads is
 *      documented at 25 and banks may truncate further. "QUAY-XXXXXX" is 11,
 *      which clears every limit we know of. Confirm against a real statement
 *      before widening (docs/wise-paynow-probe.md).
 *
 *   2. It gets read off a screen and retyped, sometimes by someone squinting
 *      at a phone in a hawker centre. The alphabet excludes I, L, O, U, 0 and
 *      1 so there is no character pair a human can confuse.
 *
 *   3. It is a secret. 30^6 is ~729 million codes; with the attempt cap in
 *      attempts.ts, guessing is not a viable attack.
 */

/** Crockford-ish: no I, L, O, U, 0, 1. U is dropped to avoid accidental words. */
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LENGTH = 6;
const PREFIX = "QUAY-";

/** Longest reference we will ever emit. Asserted in tests. */
export const MAX_REFERENCE_LENGTH = PREFIX.length + CODE_LENGTH;

/**
 * A fresh code. Uses `randomInt` (CSPRNG) rather than Math.random: this is
 * the secret the whole verification rests on.
 */
export function generateCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/** What actually goes in the PayNow reference field. */
export function formatReference(code: string): string {
  return `${PREFIX}${code}`;
}

/**
 * Normalize merchant input before comparing.
 *
 * Merchants paste from their banking app, so the input arrives with the
 * prefix attached, lowercased, spaced, or wrapped in whatever the bank put
 * around it. All of that is noise. Anything outside the alphabet is dropped,
 * then the prefix is removed if present.
 */
export function normalizeCodeInput(raw: string): string {
  const upper = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return upper.startsWith("QUAY") ? upper.slice(4) : upper;
}

/** blake2b256 of the code. The plaintext is never stored. */
export function hashCode(code: string): Uint8Array {
  return blake2b(new TextEncoder().encode(code), { dkLen: 32 });
}

/**
 * Constant-time comparison.
 *
 * `===` on strings short-circuits at the first differing character, which
 * leaks the code one position at a time to anyone who can measure response
 * time. Comparing the hashes (fixed 32 bytes) also means length never varies,
 * so there is no length oracle either.
 */
export function codeMatches(submitted: string, expectedHash: Uint8Array): boolean {
  if (expectedHash.length !== 32) return false;
  const actual = hashCode(normalizeCodeInput(submitted));
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expectedHash));
}
