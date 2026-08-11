import "server-only";

import { NextResponse } from "next/server";

import { getFeatureFlag } from "@/lib/server/feature-flags";
import {
  getUserTransactions,
  isCoinbaseConfigured,
} from "@/lib/server/coinbase-offramp";
import {
  OfframpStoreError,
  canTransition,
  listReconcilable,
  markExpired,
  markSettled,
  markUnmatched,
  isStaleOpenOrder,
  isStalledSend,
} from "@/lib/server/coinbase-offramp-store";

export const runtime = "nodejs";

/**
 * Settle Coinbase cash-outs whose merchant walked away after sending.
 *
 * **This cron cannot sign for a merchant, and is not a fallback for an
 * unsigned order.** Signing is client-only — `zkLoginSign` needs the ephemeral
 * key in the merchant's localStorage, and no server process has it. So a
 * merchant who commits an order and then leaves *before* sending is
 * unrecoverable by construction: the order simply expires at Coinbase and the
 * row is marked `expired`. Do not add a "just send it from the server" branch
 * here later; there is no key to do it with.
 *
 * What this does handle is the case where the send DID happen and the tab then
 * went away before the confirmation landed: the funds are with Coinbase, the
 * sale completes on their side, and only the local row is stale.
 *
 * Chosen over a CDP webhook deliberately — no signature-verification code, no
 * extra CLI dependency, and it reuses the cron pattern already in the repo
 * (scallop-monitor, scallop-cost-basis-indexer).
 *
 * **Not currently on a Vercel schedule.** The Hobby plan allows two cron jobs
 * at daily frequency, and the two Scallop crons already occupy both slots, so
 * adding a third here fails the deployment outright. This endpoint is
 * therefore triggered manually or by an external scheduler until the account
 * moves to a paid tier — see TODOS.
 *
 * That is tolerable because it is a backstop rather than the primary path:
 * `/api/offramp/coinbase/status` performs the same reconciliation on every
 * poll, so any merchant who returns to the wallet settles their own row. This
 * job exists for the merchant who sends and then never comes back — where the
 * funds have already reached Coinbase and the sale completes on their side
 * regardless, leaving only the local row stale.
 */

const FEATURE_FLAG_NAME = "coinbase_offramp_enabled";
const MAX_ROWS_PER_TICK = 100;

function authorize(req: Request): { ok: true } | { ok: false; status: number } {
  const expected = process.env.CRON_SECRET;
  if (!expected) return { ok: true };
  const got = req.headers.get("authorization");
  if (got === `Bearer ${expected}`) return { ok: true };
  return { ok: false, status: 401 };
}

interface ReconcileResponse {
  ok: boolean;
  checked_at: string;
  rows_scanned: number;
  settled: number;
  unmatched: number;
  expired: number;
  errors: number;
  note?: string;
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: auth.status });
  }

  const checkedAt = new Date().toISOString();
  const flag = await getFeatureFlag(FEATURE_FLAG_NAME);
  if (!flag?.enabled) {
    return NextResponse.json({
      ok: true,
      checked_at: checkedAt,
      rows_scanned: 0,
      settled: 0,
      unmatched: 0,
      expired: 0,
      errors: 0,
      note: "coinbase_offramp_enabled is off — nothing to reconcile",
    } satisfies ReconcileResponse);
  }
  if (!isCoinbaseConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        checked_at: checkedAt,
        rows_scanned: 0,
        settled: 0,
        unmatched: 0,
        expired: 0,
        errors: 1,
        note: "CDP credentials not configured",
      } satisfies ReconcileResponse,
      { status: 503 },
    );
  }

  let rows;
  try {
    rows = await listReconcilable(MAX_ROWS_PER_TICK);
  } catch (e) {
    const message = e instanceof OfframpStoreError ? e.message : String(e);
    return NextResponse.json(
      {
        ok: false,
        checked_at: checkedAt,
        rows_scanned: 0,
        settled: 0,
        unmatched: 0,
        expired: 0,
        errors: 1,
        note: message,
      } satisfies ReconcileResponse,
      { status: 500 },
    );
  }

  let settled = 0;
  let unmatched = 0;
  let expired = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      // Expire first: a committed order past its deadline with nothing sent is
      // the unrecoverable abandon case, and there is nothing to poll for.
      const deadlineMs = row.deadline_at ? Date.parse(row.deadline_at) : null;
      if (
        row.status === "committed" &&
        deadlineMs !== null &&
        deadlineMs < Date.now()
      ) {
        await markExpired(
          row.id,
          row.status,
          "deadline passed before the merchant signed the send",
        );
        expired += 1;
        continue;
      }

      // A `created` row never gets a Coinbase deadline, so it is aged out
      // locally — otherwise the in-flight lock traps the merchant forever.
      if (isStaleOpenOrder(row)) {
        await markExpired(row.id, row.status, "abandoned before committing on Coinbase");
        expired += 1;
        continue;
      }

      // Only rows that actually sent can be settled — that is the whole scope
      // of this job.
      if (row.status !== "sent") continue;

      const transactions = await getUserTransactions(row.partner_user_ref);
      const remote =
        transactions.find(
          (t) => t.transactionId && t.transactionId === row.coinbase_transaction_id,
        ) ??
        transactions[0] ??
        null;
      if (!remote) continue;

      if (remote.status === "success" && canTransition(row.status, "settle")) {
        await markSettled(row.id, row.status);
        settled += 1;
      } else if (remote.status === "failed" && canTransition(row.status, "unmatch")) {
        // The sale did not complete against USDC we already delivered. Where
        // the funds ended up is Coinbase's to say, so the row records the
        // outcome and does not assert a return that may not have happened.
        await markUnmatched(row.id, row.status);
        unmatched += 1;
      } else if (isStalledSend(row) && canTransition(row.status, "unmatch")) {
        // Delivered, but the order is still non-terminal well past the point
        // Coinbase resolves one. Left alone this row stays `sent` forever and
        // the merchant is never told to go look.
        await markUnmatched(
          row.id,
          row.status,
          `Coinbase had not completed the sale 45 minutes after the deposit ` +
            `(order status '${remote.status}') — it may still land`,
        );
        unmatched += 1;
      }
    } catch (e) {
      errors += 1;
      console.error(
        `[coinbase-reconcile] row ${row.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    checked_at: checkedAt,
    rows_scanned: rows.length,
    settled,
    unmatched,
    expired,
    errors,
  } satisfies ReconcileResponse);
}
