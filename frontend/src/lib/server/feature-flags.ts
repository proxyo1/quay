import "server-only";

import { getSupabaseClient } from "@/lib/server/supabase";

/**
 * Runtime feature-flag reader. Backed by the `feature_flags` table created
 * in `supabase/migrations/20260515_feature_flags.sql`.
 *
 * Reads are cached in-memory for 10s per server instance (E2). Flips
 * propagate within the cache window — fine for kill-switch semantics
 * (worst-case staleness is 10s after a manual flip or cron auto-flip).
 *
 * Returns `null` when Supabase isn't configured (dev environments without
 * env vars set) so callers can degrade gracefully. Returns `null` when
 * the row doesn't exist — caller treats absence as disabled.
 */

export interface FeatureFlagRow {
  flag_name: string;
  enabled: boolean;
  last_changed_at: string;
  last_changed_reason: string | null;
  metadata: Record<string, unknown>;
}

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { row: FeatureFlagRow | null; at: number }>();

export async function getFeatureFlag(
  flagName: string,
): Promise<FeatureFlagRow | null> {
  const now = Date.now();
  const cached = cache.get(flagName);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.row;

  const supabase = getSupabaseClient();
  if (!supabase) {
    cache.set(flagName, { row: null, at: now });
    return null;
  }

  const { data, error } = await supabase
    .from("feature_flags")
    .select("flag_name, enabled, last_changed_at, last_changed_reason, metadata")
    .eq("flag_name", flagName)
    .maybeSingle();

  if (error) {
    // Don't cache transient errors — let the next request retry.
    return null;
  }

  const row = (data as FeatureFlagRow | null) ?? null;
  cache.set(flagName, { row, at: now });
  return row;
}

/** Test/ops hook: drop the in-memory cache so the next read hits Supabase. */
export function resetFeatureFlagCache(): void {
  cache.clear();
}
