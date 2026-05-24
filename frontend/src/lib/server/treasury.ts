import "server-only";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load the cash-out treasury wallet. This is the address that briefly holds
 * a merchant's USDsui between the on-chain transfer and the Wise (sandbox)
 * SGD payout. Custodial by design — see the plan's "honest mechanic": this
 * exists only for the manual sandbox demo and is deleted when the licensed
 * V2 settlement leg lands.
 *
 * Same key-source precedence as the sponsor (env hex → env bech32 → file).
 * The treasury holds USDsui only; it never pays gas (the sponsor does), so
 * it needs no SUI balance.
 *
 * Server-only — never import from a client component.
 */
export function loadTreasuryKeypair(): Ed25519Keypair {
  const hex = process.env.QUAY_TREASURY_SECRET_KEY_HEX;
  if (hex) {
    const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
    if (bytes.length !== 32) {
      throw new Error(
        `QUAY_TREASURY_SECRET_KEY_HEX must be 32 bytes, got ${bytes.length}`,
      );
    }
    return Ed25519Keypair.fromSecretKey(new Uint8Array(bytes));
  }
  const bech = process.env.QUAY_TREASURY_SECRET_KEY_BECH32;
  if (bech) {
    const { secretKey } = decodeSuiPrivateKey(bech);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  const path = join(process.cwd(), "..", ".secrets", "treasury-mainnet.json");
  const j = JSON.parse(readFileSync(path, "utf8")) as { secret_key_hex: string };
  const bytes = Buffer.from(j.secret_key_hex, "hex");
  if (bytes.length !== 32) throw new Error(`treasury key in ${path} must be 32 bytes`);
  return Ed25519Keypair.fromSecretKey(new Uint8Array(bytes));
}

/** The treasury's Sui address (no key material). Cheap to call. */
export function treasuryAddress(): string {
  return loadTreasuryKeypair().toSuiAddress();
}
