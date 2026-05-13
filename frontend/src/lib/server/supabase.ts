import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client. Returns `null` when env vars aren't set —
 * downstream callers degrade gracefully (Phase 4 audit log writes become
 * console-logged no-ops in dev environments without Supabase configured).
 *
 * Required env:
 *   SUPABASE_URL          — e.g., https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_KEY  — service-role key (server-only; never expose)
 *
 * The service-role key bypasses RLS, but the migration uses RLS as
 * defense-in-depth to deny updates/deletes (append-only posture).
 */
let cached: SupabaseClient | null | undefined;

export function getSupabaseClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    cached = null;
    return null;
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export function isSupabaseConfigured(): boolean {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}
