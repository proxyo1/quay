import "server-only";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load the quay attestation issuer keypair.
 *
 * Priority:
 *   1. SUIQR_ISSUER_SECRET_KEY_HEX env var (preferred for production)
 *   2. SUIQR_ISSUER_SECRET_KEY_BECH32 env var (the `suiprivkey1...` format)
 *   3. `<repo>/.secrets/issuer-testnet.json` for local dev
 *
 * The local-dev path matches what scripts/day2-deploy.ts produces.
 *
 * IMPORTANT: this module is server-only ("server-only" import). Do NOT
 * import from a client component or the secret can leak into the bundle.
 */
export function loadIssuerKeypair(): Ed25519Keypair {
  const hex = process.env.SUIQR_ISSUER_SECRET_KEY_HEX;
  if (hex) {
    const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
    if (bytes.length !== 32) throw new Error(`SUIQR_ISSUER_SECRET_KEY_HEX must be 32 bytes, got ${bytes.length}`);
    return Ed25519Keypair.fromSecretKey(new Uint8Array(bytes));
  }
  const bech = process.env.SUIQR_ISSUER_SECRET_KEY_BECH32;
  if (bech) {
    const { secretKey } = decodeSuiPrivateKey(bech);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  // Local dev fallback — read from .secrets file produced by day2-deploy
  const dotSecrets = join(process.cwd(), "..", ".secrets", "issuer-testnet.json");
  const raw = readFileSync(dotSecrets, "utf8");
  const j = JSON.parse(raw) as { secret_key_hex: string };
  const bytes = Buffer.from(j.secret_key_hex, "hex");
  if (bytes.length !== 32) throw new Error(`secret key in ${dotSecrets} must be 32 bytes, got ${bytes.length}`);
  return Ed25519Keypair.fromSecretKey(new Uint8Array(bytes));
}
