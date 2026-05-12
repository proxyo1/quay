import "server-only";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load the suiqr sponsored-gas wallet. Same key-source-precedence pattern
 * as the issuer (env hex → env bech32 → .secrets file).
 *
 * Server-only — never import from a client component.
 */
export function loadSponsorKeypair(): Ed25519Keypair {
  const hex = process.env.SUIQR_SPONSOR_SECRET_KEY_HEX;
  if (hex) {
    const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
    if (bytes.length !== 32) {
      throw new Error(`SUIQR_SPONSOR_SECRET_KEY_HEX must be 32 bytes, got ${bytes.length}`);
    }
    return Ed25519Keypair.fromSecretKey(new Uint8Array(bytes));
  }
  const bech = process.env.SUIQR_SPONSOR_SECRET_KEY_BECH32;
  if (bech) {
    const { secretKey } = decodeSuiPrivateKey(bech);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  const path = join(process.cwd(), "..", ".secrets", "sponsor-testnet.json");
  const j = JSON.parse(readFileSync(path, "utf8")) as { secret_key_hex: string };
  const bytes = Buffer.from(j.secret_key_hex, "hex");
  if (bytes.length !== 32) throw new Error(`sponsor key in ${path} must be 32 bytes`);
  return Ed25519Keypair.fromSecretKey(new Uint8Array(bytes));
}

/**
 * Simple in-memory per-sender daily counter (V0). Resets on process
 * restart. Production would use a real KV store or Redis with a daily
 * TTL.
 */
const usage = new Map<string, { count: number; resetAt: number }>();
const DAY_MS = 24 * 60 * 60 * 1000;

export function checkAndIncrementSponsorUsage(
  sender: string,
  dailyCap: number,
): { ok: true } | { ok: false; remaining: 0; resetAt: number } {
  const now = Date.now();
  const e = usage.get(sender);
  if (!e || now > e.resetAt) {
    usage.set(sender, { count: 1, resetAt: now + DAY_MS });
    return { ok: true };
  }
  if (e.count >= dailyCap) {
    return { ok: false, remaining: 0, resetAt: e.resetAt };
  }
  e.count += 1;
  return { ok: true };
}
