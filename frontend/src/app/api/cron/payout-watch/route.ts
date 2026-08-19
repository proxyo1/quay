import "server-only";

import { NextResponse } from "next/server";

import { queryEventsPageAscending } from "@/lib/quay/events";
import { getSupabaseClient } from "@/lib/server/supabase";
import { QUAY } from "@/lib/sui-config";

export const runtime = "nodejs";

/**
 * Watches for merchants' payout addresses changing.
 *
 * **This detects, it cannot prevent.** `update_merchant_address`
 * (`payments.move:372`) asserts only that the caller currently holds the
 * entry, and Sui's compatible-upgrade rules forbid changing an existing
 * public function's signature, so no attestation can be demanded of it. A
 * v2 function would leave v1 callable forever. And unlike a spend cap, where
 * the capped party is the payer and not the adversary, here the adversary IS
 * the caller: someone with a stolen zkLogin session calls the contract
 * directly and never touches our app, so any check in the UI stops nobody.
 *
 * What is achievable is shrinking time-to-discovery from "whenever the
 * merchant notices their money stopped arriving" to minutes. Do not describe
 * this as protection anywhere a merchant can read it.
 *
 * Two ways this job can lie about having seen everything, both guarded:
 *
 *   1. **Retention.** Sui's GraphQL keeps only a recent window of events. If
 *      this job is down long enough, older events are simply gone and a naive
 *      poll returns success having seen nothing.
 *   2. **Paging.** Sui caps a page at 50 rows (fixed in 1d6ad04 for a related
 *      bug). Reading one page and stopping silently drops the rest.
 *
 * So the watermark is compared against the oldest event still retained. If
 * retention has moved past where we last were, that is a GAP and it alerts,
 * because a watcher that cannot tell you it missed something is not a watcher.
 */

const FLAG_NAME = "payout_watch";
const EVENT_TYPE = `${QUAY.packageId}::payments::MerchantAddressUpdated`;
const PAGE_SIZE = 50;
/** Bounds a single tick so a long backlog cannot time out the function. */
const MAX_PAGES_PER_TICK = 20;

interface Watermark {
  /** Opaque GraphQL cursor of the last event processed. */
  cursor: string | null;
  /** Timestamp of that event. Used for gap detection against retention. */
  lastSeenMs: number | null;
}

function authorize(req: Request): { ok: true } | { ok: false; status: number } {
  const expected = process.env.CRON_SECRET;
  if (!expected) return { ok: true };
  const got = req.headers.get("authorization");
  if (got === `Bearer ${expected}`) return { ok: true };
  return { ok: false, status: 401 };
}

/**
 * The event's own `timestamp_ms` field, not an envelope timestamp — QuayEvent
 * carries no envelope time, and the Move struct's value is the authoritative
 * one regardless. Move u64 arrives as a string over GraphQL.
 */
function eventTimestampMs(ev: { parsedJson: unknown } | undefined): number | null {
  if (!ev) return null;
  const raw = (ev.parsedJson as Record<string, unknown> | null)?.timestamp_ms;
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseWatermark(raw: unknown): Watermark {
  if (!raw || typeof raw !== "object") return { cursor: null, lastSeenMs: null };
  const o = raw as Record<string, unknown>;
  return {
    cursor: typeof o.cursor === "string" ? o.cursor : null,
    lastSeenMs: typeof o.lastSeenMs === "number" ? o.lastSeenMs : null,
  };
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: auth.status });
  }

  const checkedAt = new Date().toISOString();
  const supabase = getSupabaseClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, checked_at: checkedAt, error: "Supabase not configured" },
      { status: 500 },
    );
  }

  const { data: flagRow } = await supabase
    .from("feature_flags")
    .select("metadata")
    .eq("flag_name", FLAG_NAME)
    .maybeSingle();

  const metadata = ((flagRow?.metadata ?? {}) as Record<string, unknown>) ?? {};
  const watermark = parseWatermark(metadata.watermark);

  let gapDetected = false;
  let gapReason: string | null = null;

  try {
    // ── Gap check, before reading anything new ──
    //
    // Ask for the oldest event still retained. If we have a watermark and
    // that oldest event is NEWER than it, the events in between aged out
    // while we were not looking, and they are unrecoverable.
    if (watermark.lastSeenMs !== null) {
      const oldest = await queryEventsPageAscending(EVENT_TYPE, 1, null);
      const oldestMs = eventTimestampMs(oldest.events[0]);
      if (oldestMs !== null && oldestMs > watermark.lastSeenMs) {
        gapDetected = true;
        gapReason =
          `retention window no longer reaches the watermark: oldest retained event is ` +
          `${new Date(oldestMs).toISOString()}, last processed ${new Date(watermark.lastSeenMs).toISOString()}`;
        console.error(`[payout-watch] EVENT GAP — ${gapReason}`);
      }
    }

    // ── Drain forward, paging fully ──
    let cursor = watermark.cursor;
    let lastSeenMs = watermark.lastSeenMs;
    const changes: Array<{
      uen_hash: string;
      old_address: string;
      new_address: string;
      timestamp_ms: number;
    }> = [];

    for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
      const result = await queryEventsPageAscending(EVENT_TYPE, PAGE_SIZE, cursor);
      for (const ev of result.events) {
        const fields = (ev.parsedJson ?? {}) as Record<string, unknown>;
        const ts = eventTimestampMs(ev);
        changes.push({
          uen_hash: String(fields.uen_hash ?? ""),
          old_address: String(fields.old_address ?? ""),
          new_address: String(fields.new_address ?? ""),
          timestamp_ms: ts ?? 0,
        });
        if (ts !== null) lastSeenMs = ts;
      }
      cursor = result.endCursor ?? cursor;
      if (!result.hasNextPage) break;
      if (page === MAX_PAGES_PER_TICK - 1) {
        // Not an error, but say so: a silently truncated sweep is the exact
        // failure this job exists to avoid.
        console.warn(
          `[payout-watch] hit MAX_PAGES_PER_TICK with more pages pending; will continue next tick`,
        );
      }
    }

    for (const c of changes) {
      // The merchant is the party who needs to know, and right now the only
      // delivery channel in this stack is the log drain. Recorded loudly so
      // adding a real channel later is a swap, not an archaeology exercise.
      console.error(
        `[payout-watch] PAYOUT ADDRESS CHANGED uen_hash=${c.uen_hash} ` +
          `${c.old_address} → ${c.new_address} at ${new Date(c.timestamp_ms).toISOString()}`,
      );
    }

    await supabase.from("feature_flags").upsert(
      {
        flag_name: FLAG_NAME,
        enabled: true,
        metadata: {
          ...metadata,
          watermark: { cursor, lastSeenMs } satisfies Watermark,
          last_run_at: checkedAt,
          last_gap_detected: gapDetected ? checkedAt : (metadata.last_gap_detected ?? null),
        },
      },
      { onConflict: "flag_name" },
    );

    return NextResponse.json({
      ok: true,
      checked_at: checkedAt,
      changes_seen: changes.length,
      gap_detected: gapDetected,
      gap_reason: gapReason,
      changes,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[payout-watch] failed: ${message}`);
    return NextResponse.json(
      { ok: false, checked_at: checkedAt, error: message, gap_detected: gapDetected },
      { status: 500 },
    );
  }
}
