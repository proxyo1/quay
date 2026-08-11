import "server-only";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getSupabaseClient } from "@/lib/server/supabase";

/**
 * Load the quay sponsored-gas wallet. Same key-source-precedence pattern
 * as the issuer (env hex → env bech32 → .secrets file).
 *
 * Server-only — never import from a client component.
 */
export function loadSponsorKeypair(): Ed25519Keypair {
  const hex = process.env.QUAY_SPONSOR_SECRET_KEY_HEX;
  if (hex) {
    const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
    if (bytes.length !== 32) {
      throw new Error(`QUAY_SPONSOR_SECRET_KEY_HEX must be 32 bytes, got ${bytes.length}`);
    }
    return Ed25519Keypair.fromSecretKey(new Uint8Array(bytes));
  }
  const bech = process.env.QUAY_SPONSOR_SECRET_KEY_BECH32;
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

const DAY_MS = 24 * 60 * 60 * 1000;

export type SponsorUsageResult =
  | { ok: true }
  | { ok: false; remaining: 0; resetAt: number };

/**
 * Consume one unit of a sender's daily sponsored-gas allowance.
 *
 * Backed by Supabase (`sponsor_usage` + the `consume_sponsor_usage`
 * function), not a process-local Map. The Map this replaces reset on every
 * cold start and was per-instance, so on Vercel the cap never bound: a caller
 * spread across N serverless instances effectively got N times the allowance.
 *
 * The increment happens inside a Postgres function because a read-then-write
 * through supabase-js is not atomic — two concurrent requests both reading
 * count=4 against a cap of 5 would each write 5 and both be allowed, which is
 * precisely the race the limit exists to stop.
 *
 * **Fails open.** If Supabase is unreachable or unconfigured, this allows the
 * request and logs. Failing closed would brick merchant withdrawals *and*
 * merchant registration (`kyb-attestation.ts` shares this counter) for an
 * outage unrelated to the thing being rate-limited. The hard safety rail is
 * the sponsor's own `LOW_BALANCE_FLOOR_MIST` check, which is on-chain and
 * cannot be bypassed by a database outage.
 *
 * Async by necessity — every call site must `await`.
 */
export async function checkAndIncrementSponsorUsage(
  sender: string,
  dailyCap: number,
): Promise<SponsorUsageResult> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.warn(
      `[sponsor] usage counter unavailable (Supabase not configured) — allowing ${sender} without counting`,
    );
    return { ok: true };
  }

  try {
    const { data, error } = await supabase.rpc("consume_sponsor_usage", {
      p_usage_key: sender,
      p_daily_cap: dailyCap,
      p_window_ms: DAY_MS,
    });
    if (error) throw new Error(error.message);

    // Postgres `returns table` comes back as a one-row array.
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("consume_sponsor_usage returned no row");

    if (row.allowed) return { ok: true };
    return {
      ok: false,
      remaining: 0,
      resetAt: new Date(row.reset_at).getTime(),
    };
  } catch (e) {
    console.error(
      `[sponsor] usage counter failed for ${sender}; failing OPEN: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return { ok: true };
  }
}
