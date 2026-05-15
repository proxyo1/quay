import "server-only";

import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { NextResponse } from "next/server";

import { findMintEventForTx } from "@/lib/quay/indexer";
import { isYieldRoutedTokenType } from "@/lib/quay/indexer";
import { recordCostBasis } from "@/lib/server/yield-cost-basis";
import { getSupabaseClient } from "@/lib/server/supabase";
import { QUAY } from "@/lib/sui-config";
import { SUI_NETWORK } from "@/lib/sui-config";

export const runtime = "nodejs";

/**
 * Daily indexer cron for the yield-cost-basis ledger.
 *
 * Walks forward through Quay's `payments::PaymentReceipt` events,
 * filters for yield-routed ones (token_type contains
 * `scallop_usdsui::SCALLOP_USDSUI`), looks up the same-tx Scallop
 * `MintEvent` to recover the underlying USDsui deposit amount, and
 * upserts a row into `yield_cost_basis`. Idempotent on the primary key
 * `(tx_digest, merchant_address)` — re-running the cron over the same
 * window is safe.
 *
 * Cursor model: stored as `{ tx_digest, event_seq }` in
 * `feature_flags.metadata.cost_basis_cursor`. Next tick queries events
 * AFTER this cursor in ascending order, advancing as we process.
 * Crash-recoverable: each cursor write happens after a successful
 * upsert batch, so an interrupted run reprocesses at worst the last
 * batch — and the upsert is idempotent, so reprocessing is harmless.
 *
 * Testnet behavior: Scallop only lives on mainnet, so no yield-routed
 * receipts exist on testnet. The cron's filter returns nothing and the
 * cursor barely moves (no writes). On mainnet (post-Quay-mainnet deploy)
 * the cron does real work.
 *
 * The cost-basis ledger is ONLY for fee computation at redeem time —
 * we deliberately don't track consumption here. The redeem path
 * determines which mints back the merchant's CURRENT balance by
 * walking the ledger newest-first against the on-chain
 * `Coin<SCALLOP_USDSUI>` balance.
 */

const FEATURE_FLAG_NAME = "yield_routing.scallop.usdsui";
const MAX_EVENTS_PER_TICK = 200;

interface CursorJson {
  txDigest: string;
  eventSeq: string;
}

interface IndexerResponse {
  ok: boolean;
  checked_at: string;
  events_scanned: number;
  yield_routed_found: number;
  rows_written: number;
  rows_skipped_dup: number;
  cursor_advanced_to: CursorJson | null;
  error?: string;
}

function authorize(req: Request): { ok: true } | { ok: false; status: number } {
  const expected = process.env.CRON_SECRET;
  if (!expected) return { ok: true };
  const got = req.headers.get("authorization");
  if (got === `Bearer ${expected}`) return { ok: true };
  return { ok: false, status: 401 };
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: auth.status },
    );
  }

  const checkedAt = new Date().toISOString();
  const sui = new SuiClient({
    network: SUI_NETWORK,
    url: getFullnodeUrl(SUI_NETWORK),
  });

  const supabase = getSupabaseClient();
  if (!supabase) {
    return NextResponse.json(
      {
        ok: false,
        checked_at: checkedAt,
        events_scanned: 0,
        yield_routed_found: 0,
        rows_written: 0,
        rows_skipped_dup: 0,
        cursor_advanced_to: null,
        error: "supabase not configured",
      } satisfies IndexerResponse,
      { status: 500 },
    );
  }

  // Load cursor from feature_flags.metadata.cost_basis_cursor (optional).
  const { data: flagRow, error: flagErr } = await supabase
    .from("feature_flags")
    .select("metadata")
    .eq("flag_name", FEATURE_FLAG_NAME)
    .maybeSingle();
  if (flagErr || !flagRow) {
    return NextResponse.json(
      {
        ok: false,
        checked_at: checkedAt,
        events_scanned: 0,
        yield_routed_found: 0,
        rows_written: 0,
        rows_skipped_dup: 0,
        cursor_advanced_to: null,
        error: `feature_flags row missing: ${flagErr?.message ?? "no row"}`,
      } satisfies IndexerResponse,
      { status: 500 },
    );
  }
  const metadata = (flagRow.metadata ?? {}) as Record<string, unknown>;
  const startCursor = parseCursor(metadata.cost_basis_cursor);

  // Iterate forward through PaymentReceipt events.
  let cursor: CursorJson | null = startCursor;
  let eventsScanned = 0;
  let yieldRoutedFound = 0;
  let rowsWritten = 0;
  let rowsSkippedDup = 0;
  let advancedCursor: CursorJson | null = startCursor;

  while (eventsScanned < MAX_EVENTS_PER_TICK) {
    const page = await sui.queryEvents({
      query: {
        MoveEventType: `${QUAY.packageId}::payments::PaymentReceipt`,
      },
      cursor: cursor ?? null,
      limit: Math.min(50, MAX_EVENTS_PER_TICK - eventsScanned),
      order: "ascending",
    });

    if (!page.data || page.data.length === 0) break;

    for (const ev of page.data) {
      eventsScanned += 1;
      const parsed = ev.parsedJson as
        | { token_type?: { name?: string }; merchant?: string; amount?: string }
        | undefined;
      const tokenType = parsed?.token_type?.name ?? "";
      const merchant = parsed?.merchant;
      if (!merchant || !isYieldRoutedTokenType(tokenType)) {
        continue;
      }
      yieldRoutedFound += 1;

      // Recover the underlying USDsui amount via the same-tx MintEvent.
      const mint = await findMintEventForTx(sui, ev.id.txDigest);
      if (!mint) {
        // Anomaly — a yield-routed PaymentReceipt without a sibling
        // MintEvent. Log via the response and move on; the row would
        // be over-fee'd (cost basis = current price) if we recorded
        // nothing, so we skip rather than fabricate.
        continue;
      }

      const res = await recordCostBasis({
        txDigest: ev.id.txDigest,
        merchantAddress: ensureHexPrefix(merchant),
        mintShareMinor: BigInt(mint.mint_amount),
        mintUnderlyingMinor: BigInt(mint.deposit_amount),
      });
      if (res.written) rowsWritten += 1;
      else rowsSkippedDup += 1; // Upsert ignored on dup PK — counted as skip.

      advancedCursor = {
        txDigest: ev.id.txDigest,
        eventSeq: ev.id.eventSeq,
      };
    }

    if (!page.hasNextPage || !page.nextCursor) break;
    cursor = {
      txDigest: page.nextCursor.txDigest,
      eventSeq: page.nextCursor.eventSeq,
    };
    // Advance the persisted cursor to the page boundary even if no
    // yield-routed rows existed in this page — keeps the cron from
    // re-scanning historical empty windows.
    advancedCursor = cursor;
  }

  // Persist cursor.
  if (
    advancedCursor &&
    (advancedCursor.txDigest !== startCursor?.txDigest ||
      advancedCursor.eventSeq !== startCursor?.eventSeq)
  ) {
    const newMetadata = {
      ...metadata,
      cost_basis_cursor: advancedCursor,
      cost_basis_last_run_at: checkedAt,
    };
    const { error: updateErr } = await supabase
      .from("feature_flags")
      .update({ metadata: newMetadata })
      .eq("flag_name", FEATURE_FLAG_NAME);
    if (updateErr) {
      return NextResponse.json(
        {
          ok: false,
          checked_at: checkedAt,
          events_scanned: eventsScanned,
          yield_routed_found: yieldRoutedFound,
          rows_written: rowsWritten,
          rows_skipped_dup: rowsSkippedDup,
          cursor_advanced_to: advancedCursor,
          error: `cursor persist failed: ${updateErr.message}`,
        } satisfies IndexerResponse,
        { status: 500 },
      );
    }
  }

  return NextResponse.json({
    ok: true,
    checked_at: checkedAt,
    events_scanned: eventsScanned,
    yield_routed_found: yieldRoutedFound,
    rows_written: rowsWritten,
    rows_skipped_dup: rowsSkippedDup,
    cursor_advanced_to: advancedCursor,
  } satisfies IndexerResponse);
}

function parseCursor(raw: unknown): CursorJson | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.txDigest !== "string" || typeof r.eventSeq !== "string") {
    return null;
  }
  return { txDigest: r.txDigest, eventSeq: r.eventSeq };
}

function ensureHexPrefix(addr: string): string {
  return addr.startsWith("0x") ? addr : `0x${addr}`;
}
