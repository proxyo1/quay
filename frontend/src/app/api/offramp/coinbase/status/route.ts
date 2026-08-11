import "server-only";

import { NextResponse } from "next/server";

import { getFeatureFlag } from "@/lib/server/feature-flags";
import {
  OfframpAuthError,
  authorizeOfframpRequest,
} from "@/lib/server/coinbase-auth";
import {
  CoinbaseOfframpError,
  cashoutCurrency,
  getUserTransactions,
  isCoinbaseConfigured,
} from "@/lib/server/coinbase-offramp";
import {
  OfframpStoreError,
  canTransition,
  getById,
  getOpenForOwner,
  markExpired,
  markSent,
  markSettled,
  markUnmatched,
  isStaleOpenOrder,
  isStalledSend,
  type OfframpRow,
} from "@/lib/server/coinbase-offramp-store";

export const runtime = "nodejs";

/**
 * Poll a cash-out, reconciling the row against Coinbase.
 *
 * Serves two callers: the tab that is waiting for the merchant to finish in
 * the widget, and a merchant returning later whose UI needs rehydrating.
 * Rehydration recovers the **row**, not the signing key — only a client with
 * the zkLogin session can sign, which is why an abandoned pre-send order is
 * unrecoverable and the UI has to route that case to re-login.
 *
 * Reconciliation is one-directional and conservative: it only ever applies
 * transitions the state machine already permits, so a late or duplicated poll
 * cannot resurrect a terminal row or settle one that never sent.
 */

const FEATURE_FLAG_NAME = "coinbase_offramp_enabled";

export async function GET(req: Request) {
  const flag = await getFeatureFlag(FEATURE_FLAG_NAME);
  if (!flag?.enabled) {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  const url = new URL(req.url);
  const requestId = url.searchParams.get("request_id");
  const ownerParam = url.searchParams.get("owner") ?? undefined;

  let claims;
  try {
    claims = await authorizeOfframpRequest({
      authorizationHeader: req.headers.get("authorization"),
      owner: ownerParam,
    });
  } catch (e) {
    if (e instanceof OfframpAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  let row: OfframpRow | null;
  try {
    row = requestId ? await getById(requestId) : await getOpenForOwner(claims.owner);
  } catch (e) {
    if (e instanceof OfframpStoreError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  if (!row) {
    return NextResponse.json({ found: false });
  }
  if (row.owner !== claims.owner) {
    return NextResponse.json({ error: "not your cash-out" }, { status: 403 });
  }

  // Terminal rows need no reconciliation — report and stop.
  if (!canTransition(row.status, "settle") && !canTransition(row.status, "expire")) {
    return NextResponse.json({ found: true, ...serialize(row) });
  }

  // Deadline first: an expired order should not be reported as merely waiting.
  //
  // A `created` row has no Coinbase deadline (one is only issued on commit), so
  // it is aged out locally instead. Without that it could never expire, and the
  // in-flight lock would bar the merchant from ever cashing out again — the
  // exact outcome of opening the widget and closing it.
  const deadlineMs = row.deadline_at ? Date.parse(row.deadline_at) : null;
  const deadlinePassed = deadlineMs !== null && deadlineMs < Date.now();
  if ((deadlinePassed || isStaleOpenOrder(row)) && canTransition(row.status, "expire")) {
    try {
      row = await markExpired(row.id, row.status);
    } catch (e) {
      if (!(e instanceof OfframpStoreError)) throw e;
      // Concurrent writer got there first; re-read below.
    }
    const refreshed = await getById(row.id);
    return NextResponse.json({ found: true, ...serialize(refreshed ?? row) });
  }

  if (!isCoinbaseConfigured()) {
    return NextResponse.json({ found: true, ...serialize(row) });
  }

  let remote;
  try {
    const transactions = await getUserTransactions(row.partner_user_ref);
    remote =
      transactions.find(
        (t) => t.transactionId && t.transactionId === row!.coinbase_transaction_id,
      ) ??
      transactions[0] ??
      null;
  } catch (e) {
    if (e instanceof CoinbaseOfframpError) {
      // A Coinbase outage must not corrupt local state — report what we have.
      return NextResponse.json({
        found: true,
        ...serialize(row),
        coinbase_unavailable: true,
      });
    }
    throw e;
  }

  if (remote) {
    if (remote.status === "success" && canTransition(row.status, "settle")) {
      try {
        row = await markSettled(row.id, row.status);
      } catch (e) {
        if (!(e instanceof OfframpStoreError)) throw e;
      }
    } else if (remote.status === "failed" && canTransition(row.status, "unmatch")) {
      // Failed AFTER we sent: the USDC reached Coinbase but the sale did not
      // complete. Whether they returned it on-chain or kept it as a crypto
      // credit is not knowable from here, so the row says only what happened.
      try {
        row = await markUnmatched(row.id, row.status);
      } catch (e) {
        if (!(e instanceof OfframpStoreError)) throw e;
      }
    } else if (isStalledSend(row) && canTransition(row.status, "unmatch")) {
      // Delivered but never matched to the order — see SENT_STALL_TTL_MS.
      try {
        row = await markUnmatched(
          row.id,
          row.status,
          `Coinbase did not match the deposit within 24h (order status '${remote.status}')`,
        );
      } catch (e) {
        if (!(e instanceof OfframpStoreError)) throw e;
      }
    }
  }

  const refreshed = await getById(row.id);
  return NextResponse.json({
    found: true,
    ...serialize(refreshed ?? row),
    coinbase_status: remote?.status ?? null,
    to_address: remote?.toAddress ?? row.to_address,
  });
}

/**
 * Record the digest of a send the client just submitted.
 *
 * The client is the only party that can sign, so it is the only party that
 * learns the digest. `sui_digest` is uniquely indexed, so a replay is a 409
 * rather than a second payout.
 */
export async function POST(req: Request) {
  const flag = await getFeatureFlag(FEATURE_FLAG_NAME);
  if (!flag?.enabled) {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  let body: {
    request_id?: string;
    sui_digest?: string;
    owner?: string;
    action?: "cancel";
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.request_id) {
    return NextResponse.json({ error: "request_id required" }, { status: 400 });
  }
  if (body.action !== "cancel" && !body.sui_digest) {
    return NextResponse.json(
      { error: "sui_digest required unless action is 'cancel'" },
      { status: 400 },
    );
  }

  let claims;
  try {
    claims = await authorizeOfframpRequest({
      authorizationHeader: req.headers.get("authorization"),
      owner: body.owner,
    });
  } catch (e) {
    if (e instanceof OfframpAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  try {
    const row = await getById(body.request_id);
    if (!row) return NextResponse.json({ error: "cash-out not found" }, { status: 404 });
    if (row.owner !== claims.owner) {
      return NextResponse.json({ error: "not your cash-out" }, { status: 403 });
    }
    // Explicit abandon. Releases the in-flight lock immediately rather than
    // making the merchant wait out the TTL. Only legal before the send — once
    // funds have moved, the order is Coinbase's to resolve.
    if (body.action === "cancel") {
      if (!canTransition(row.status, "expire")) {
        return NextResponse.json(
          { error: `a '${row.status}' cash-out cannot be cancelled`, status: row.status },
          { status: 409 },
        );
      }
      const cancelled = await markExpired(row.id, row.status, "cancelled by the merchant");
      return NextResponse.json({ ok: true, ...serialize(cancelled) });
    }
    if (row.status === "sent" && row.sui_digest === body.sui_digest) {
      // Idempotent retry of the same submission.
      return NextResponse.json({ ok: true, ...serialize(row) });
    }
    const updated = await markSent(row.id, row.status, body.sui_digest!);
    return NextResponse.json({ ok: true, ...serialize(updated) });
  } catch (e) {
    if (e instanceof OfframpStoreError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

function serialize(row: OfframpRow) {
  return {
    request_id: row.id,
    status: row.status,
    amount_usdsui_minor: row.amount_usdsui_minor,
    sell_amount_usdc_minor: row.sell_amount_usdc_minor,
    estimated_sgd_minor: row.cashout_total_sgd_minor,
    coinbase_fee_sgd_minor: row.coinbase_fee_sgd_minor,
    // The row predates the currency being configurable and has no column for
    // it, so this reports the server's current setting. Flipping the env
    // mid-flight therefore relabels an in-flight row — display only, and the
    // stored amounts are whatever Coinbase quoted.
    cashout_currency: cashoutCurrency(),
    to_address: row.to_address,
    sui_digest: row.sui_digest,
    deadline_at: row.deadline_at,
    deadline_at_ms: row.deadline_at ? Date.parse(row.deadline_at) : null,
    partial_redeem: row.partial_redeem,
    leftover_share_minor: row.leftover_share_minor,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
  };
}
