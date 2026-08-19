import "server-only";

import { getSupabaseClient } from "@/lib/server/supabase";

/**
 * Attempt limiting for code entry.
 *
 * Reuses the `consume_sponsor_usage` Postgres function and `sponsor_usage`
 * table from the sponsored-gas cap: the increment is atomic inside the
 * function, which a read-then-write through supabase-js is not. Building a
 * second counter would be duplication.
 *
 * It does NOT reuse `checkAndIncrementSponsorUsage`, because that helper
 * **fails open** on purpose (`sponsor.ts`) — the right call for gas grants,
 * where a database outage should not brick withdrawals. Here it would be
 * exactly wrong: failing open means unlimited guesses during an outage, and
 * this counter is the only thing standing between a guesser and someone
 * else's UEN.
 *
 * So this one **fails closed**. A Supabase outage blocks verification, which
 * is annoying and recoverable (the merchant retries later, and the code
 * outlives the outage). Unlimited guessing is neither.
 */

const MAX_ATTEMPTS = 5;

/** Long enough that a lockout is a real stop, short enough to self-heal. */
const WINDOW_MS = 60 * 60 * 1000;

export type AttemptOutcome =
  | { allowed: true; remaining: number }
  | { allowed: false; reason: "locked"; resetAt: number }
  | { allowed: false; reason: "unavailable" };

/**
 * Consume one attempt against a submission. Call BEFORE comparing the code,
 * so a wrong guess costs an attempt whether or not the comparison throws.
 */
export async function consumeCodeAttempt(
  submissionId: string,
): Promise<AttemptOutcome> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error(
      "[verification] attempt counter unavailable (Supabase not configured) — failing CLOSED",
    );
    return { allowed: false, reason: "unavailable" };
  }

  try {
    const { data, error } = await supabase.rpc("consume_sponsor_usage", {
      // Namespaced so it cannot collide with a sponsored-gas key, which is
      // a bare Sui address or `<address>:<route>`.
      p_usage_key: `${submissionId}:verify-code`,
      p_daily_cap: MAX_ATTEMPTS,
      p_window_ms: WINDOW_MS,
    });
    if (error) throw new Error(error.message);

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("consume_sponsor_usage returned no row");

    if (row.allowed) {
      const used = typeof row.current_count === "number" ? row.current_count : 0;
      return { allowed: true, remaining: Math.max(0, MAX_ATTEMPTS - used) };
    }
    return {
      allowed: false,
      reason: "locked",
      resetAt: new Date(row.reset_at).getTime(),
    };
  } catch (e) {
    console.error(
      `[verification] attempt counter failed for ${submissionId}; failing CLOSED: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return { allowed: false, reason: "unavailable" };
  }
}

export { MAX_ATTEMPTS };
