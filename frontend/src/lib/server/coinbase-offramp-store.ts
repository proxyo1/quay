import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseClient } from "./supabase";

/**
 * Supabase CRUD around `coinbase_offramp_requests`.
 *
 * The state machine lives in the pure `nextStatus` function below rather than
 * inside the query builders. That is the difference between transition rules
 * that are tested and transition rules that are not: Supabase-touching methods
 * are verified by hand in this repo (see the note in kyb-store.test.ts), so
 * logic buried in a `.eq()` guard is logic with no coverage. The double-pay and
 * premature-settle rules are exactly the ones that must not be untested.
 *
 * Money flow: this store is REQUIRED. It does not silently no-op when Supabase
 * is unconfigured, because the row is what provides idempotency and the audit
 * trail — the things protecting a merchant's funds.
 */

export type OfframpStatus =
  | "created"
  | "committed"
  | "sent"
  | "settled"
  | "expired"
  | "unmatched"
  | "failed";

/** Statuses where the merchant still has an open order. */
export const OPEN_STATUSES: OfframpStatus[] = ["created", "committed", "sent"];

/**
 * How long a pre-send row stays open before it is considered abandoned.
 *
 * Without a local TTL such a row can never expire, and the per-owner in-flight
 * lock then blocks that merchant from ever cashing out again — precisely what
 * happens when someone opens the widget and closes it.
 *
 * 30 minutes is well past the CDP session token's ~5-minute life, so a row this
 * old cannot be resumed anyway.
 */
export const CREATED_TTL_MS = 30 * 60 * 1000;

/**
 * True when a pre-send row has aged out and should be expired.
 *
 * Covers two shapes, both of which lack any Coinbase clock to expire against:
 *
 *  - **`created`** — no deadline exists until the merchant commits.
 *  - **`committed` with no deadline** — the row bound to a Coinbase order that
 *    never supplied one. `prepare` refuses to hand out a send once that order
 *    is no longer live, and rightly so, but the row would then poll forever
 *    holding the lock. The deadline-based expiry in the callers handles every
 *    committed row that does have a clock; this is the remainder.
 */
export function isStaleOpenOrder(row: {
  status: OfframpStatus;
  created_at: string;
  deadline_at?: string | null;
}): boolean {
  const unclocked =
    row.status === "created" || (row.status === "committed" && !row.deadline_at);
  if (!unclocked) return false;
  const created = Date.parse(row.created_at);
  return Number.isFinite(created) && Date.now() - created > CREATED_TTL_MS;
}

/** Statuses a returning merchant can resume from. */
export const RESUMABLE_STATUSES: OfframpStatus[] = ["created", "committed", "sent"];

/** Terminal statuses — nothing further happens to these rows. */
export const TERMINAL_STATUSES: OfframpStatus[] = [
  "settled",
  "expired",
  "unmatched",
  "failed",
];

/**
 * How long a `sent` row waits for Coinbase to complete the sale.
 *
 * Without this a send that Coinbase never matches to its order sits in `sent`
 * forever: the deposit is delivered, so nothing expires, and the order status
 * never reaches a terminal value for the reconcilers to act on. Observed live —
 * an order held `TRANSACTION_STATUS_STARTED` with an empty `tx_hash` while the
 * USDC had already been credited to the merchant's Coinbase balance as an
 * ordinary crypto deposit.
 *
 * 45 minutes, down from a first-guess 24h. Coinbase quotes "less than 5
 * minutes" for the cash to arrive and resolved the one observed failure in
 * ~31, so a day of silence taught the merchant nothing they could act on.
 *
 * The tradeoff is real and one-directional: `unmatched` is terminal, so a
 * genuinely slow success flagged at 45 minutes keeps a wrong label
 * permanently. That is a confusing message about money the merchant does have,
 * against a day of not knowing about money they do not. Hence the wording on
 * this transition never claims Coinbase is finished — only that Quay stopped
 * waiting.
 */
export const SENT_STALL_TTL_MS = 45 * 60 * 1000;

/**
 * True when a sent row has waited past the TTL for Coinbase to complete.
 *
 * Callers must additionally confirm the remote order is still non-terminal —
 * age alone is not evidence that nothing happened.
 */
export function isStalledSend(row: {
  status: OfframpStatus;
  sent_at: string | null;
}): boolean {
  if (row.status !== "sent" || !row.sent_at) return false;
  const sent = Date.parse(row.sent_at);
  return Number.isFinite(sent) && Date.now() - sent > SENT_STALL_TTL_MS;
}

/**
 * Events that can move a row. Named for what happened, not for the status
 * they produce, so an illegal pairing is expressible and therefore testable.
 */
export type OfframpEvent =
  | "commit" // merchant committed the order on Coinbase; to_address issued
  | "send" // the on-chain USDC send landed
  | "settle" // Coinbase confirmed the sale
  | "expire" // deadline passed with nothing sent
  | "unmatch" // we sent, Coinbase never completed the sale; funds are theirs to resolve
  | "fail"; // unrecoverable error

export class IllegalTransitionError extends Error {
  readonly from: OfframpStatus;
  readonly event: OfframpEvent;
  constructor(from: OfframpStatus, event: OfframpEvent) {
    super(`illegal transition: cannot '${event}' from '${from}'`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.event = event;
  }
}

/**
 * The whole state machine, as data.
 *
 * Two rules are load-bearing and deliberately absent from this table:
 *
 *  - **`settle` is not reachable from `committed`.** A row may only settle
 *    after `sent`. Settling straight from `committed` would mark a cash-out
 *    complete when no USDC ever left the merchant's wallet.
 *  - **`unmatch` is only reachable from `sent`.** It describes a sale that
 *    failed to complete against USDC we actually delivered; allowing it
 *    earlier would report a stranded deposit that was never made.
 */
const TRANSITIONS: Record<OfframpStatus, Partial<Record<OfframpEvent, OfframpStatus>>> = {
  created: {
    commit: "committed",
    expire: "expired",
    fail: "failed",
  },
  committed: {
    send: "sent",
    expire: "expired",
    fail: "failed",
  },
  sent: {
    settle: "settled",
    unmatch: "unmatched",
    fail: "failed",
  },
  // Terminal — no outgoing edges. A late webhook or a duplicated cron tick
  // must not resurrect a finished row.
  settled: {},
  expired: {},
  unmatched: {},
  failed: {},
};

/**
 * Next status for an event, or throw `IllegalTransitionError`.
 *
 * Pure. Callers decide the transition here and the Supabase write then simply
 * persists what was decided.
 */
export function nextStatus(current: OfframpStatus, event: OfframpEvent): OfframpStatus {
  const to = TRANSITIONS[current]?.[event];
  if (!to) throw new IllegalTransitionError(current, event);
  return to;
}

/** Whether a transition is legal, without throwing. */
export function canTransition(current: OfframpStatus, event: OfframpEvent): boolean {
  return Boolean(TRANSITIONS[current]?.[event]);
}

export function isTerminal(status: OfframpStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface OfframpRow {
  id: string;
  owner: string;
  uen: string | null;
  partner_user_ref: string;
  amount_usdsui_minor: string;
  sell_amount_usdc_minor: string | null;
  cashout_total_sgd_minor: string | null;
  coinbase_fee_sgd_minor: string | null;
  coinbase_quote_id: string | null;
  coinbase_transaction_id: string | null;
  to_address: string | null;
  sui_digest: string | null;
  redeemed_share_minor: string | null;
  leftover_share_minor: string | null;
  partial_redeem: boolean;
  performance_fee_underlying_minor: string | null;
  share_price_at_quote: number | null;
  redeem_digest: string | null;
  deadline_at: string | null;
  status: OfframpStatus;
  failure_reason: string | null;
  created_at: string;
  committed_at: string | null;
  sent_at: string | null;
  settled_at: string | null;
}

export class OfframpStoreError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OfframpStoreError";
    this.status = status;
  }
}

const TABLE = "coinbase_offramp_requests";

function client(): SupabaseClient {
  const c = getSupabaseClient();
  if (!c) {
    throw new OfframpStoreError(
      "Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY",
      500,
    );
  }
  return c;
}

// ─────────────────────────── Reads ─────────────────────────────

export async function getById(id: string): Promise<OfframpRow | null> {
  const { data, error } = await client().from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw new OfframpStoreError(`getById: ${error.message}`, 500);
  return (data as OfframpRow | null) ?? null;
}

/** The merchant's currently-open cash-out, if any. At most one by construction. */
export async function getOpenForOwner(owner: string): Promise<OfframpRow | null> {
  const { data, error } = await client()
    .from(TABLE)
    .select("*")
    .eq("owner", owner)
    .in("status", OPEN_STATUSES)
    .maybeSingle();
  if (error) throw new OfframpStoreError(`getOpenForOwner: ${error.message}`, 500);
  return (data as OfframpRow | null) ?? null;
}

/** Idempotency lookup: has this on-chain send already been recorded? */
export async function getByDigest(digest: string): Promise<OfframpRow | null> {
  const { data, error } = await client()
    .from(TABLE)
    .select("*")
    .eq("sui_digest", digest)
    .maybeSingle();
  if (error) throw new OfframpStoreError(`getByDigest: ${error.message}`, 500);
  return (data as OfframpRow | null) ?? null;
}

/** Rows the reconcile cron should look at: sent but not yet resolved. */
export async function listReconcilable(limit = 100): Promise<OfframpRow[]> {
  const { data, error } = await client()
    .from(TABLE)
    .select("*")
    .in("status", ["sent", "committed"])
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new OfframpStoreError(`listReconcilable: ${error.message}`, 500);
  return (data ?? []) as OfframpRow[];
}

// ─────────────────────────── Writes ─────────────────────────────

export interface InsertCreatedInput {
  owner: string;
  uen: string | null;
  partnerUserRef: string;
  amountUsdsuiMinor: bigint;
  sellAmountUsdcMinor: bigint;
  cashoutTotalSgdMinor: bigint;
  coinbaseFeeSgdMinor: bigint;
  coinbaseQuoteId: string;
  deadlineAt: Date | null;
  redeem?: {
    redeemedShareMinor: bigint;
    leftoverShareMinor: bigint;
    partial: boolean;
    performanceFeeUnderlyingMinor: bigint;
    sharePriceAtQuote: number;
    redeemDigest: string | null;
  };
}

/**
 * Create the row when the session is minted.
 *
 * A unique-violation here is the per-owner in-flight lock firing, which is a
 * 409 rather than a 500: the merchant already has an open cash-out, and
 * starting a second would invalidate the first one's pinned coin versions.
 */
export async function insertCreated(input: InsertCreatedInput): Promise<OfframpRow> {
  const { data, error } = await client()
    .from(TABLE)
    .insert({
      owner: input.owner,
      uen: input.uen,
      partner_user_ref: input.partnerUserRef,
      amount_usdsui_minor: input.amountUsdsuiMinor.toString(),
      sell_amount_usdc_minor: input.sellAmountUsdcMinor.toString(),
      cashout_total_sgd_minor: input.cashoutTotalSgdMinor.toString(),
      coinbase_fee_sgd_minor: input.coinbaseFeeSgdMinor.toString(),
      coinbase_quote_id: input.coinbaseQuoteId,
      deadline_at: input.deadlineAt?.toISOString() ?? null,
      status: "created" satisfies OfframpStatus,
      redeemed_share_minor: input.redeem?.redeemedShareMinor.toString() ?? null,
      leftover_share_minor: input.redeem?.leftoverShareMinor.toString() ?? null,
      partial_redeem: input.redeem?.partial ?? false,
      performance_fee_underlying_minor:
        input.redeem?.performanceFeeUnderlyingMinor.toString() ?? null,
      share_price_at_quote: input.redeem?.sharePriceAtQuote ?? null,
      redeem_digest: input.redeem?.redeemDigest ?? null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new OfframpStoreError(
        "this merchant already has a cash-out in progress",
        409,
      );
    }
    throw new OfframpStoreError(`insertCreated: ${error.message}`, 500);
  }
  return data as OfframpRow;
}

/**
 * Apply an event to a row, persisting whatever `nextStatus` decided.
 *
 * The update is optimistically locked on the status we transitioned *from*, so
 * a concurrent writer that already moved the row produces a 409 instead of
 * clobbering it.
 */
async function applyEvent(
  id: string,
  from: OfframpStatus,
  event: OfframpEvent,
  patch: Record<string, unknown> = {},
): Promise<OfframpRow> {
  const to = nextStatus(from, event);
  const { data, error } = await client()
    .from(TABLE)
    .update({ ...patch, status: to })
    .eq("id", id)
    .eq("status", from)
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      throw new OfframpStoreError("duplicate sui_digest — already recorded", 409);
    }
    throw new OfframpStoreError(`applyEvent(${event}): ${error.message}`, 500);
  }
  if (!data) {
    throw new OfframpStoreError(
      `row ${id} was not in status '${from}' — concurrent update`,
      409,
    );
  }
  return data as OfframpRow;
}

/** Merchant committed the order; Coinbase issued a deposit address. */
export function markCommitted(
  id: string,
  from: OfframpStatus,
  input: {
    toAddress: string;
    sellAmountUsdcMinor: bigint;
    coinbaseTransactionId: string | null;
    deadlineAt: Date | null;
  },
): Promise<OfframpRow> {
  return applyEvent(id, from, "commit", {
    to_address: input.toAddress,
    sell_amount_usdc_minor: input.sellAmountUsdcMinor.toString(),
    coinbase_transaction_id: input.coinbaseTransactionId,
    deadline_at: input.deadlineAt?.toISOString() ?? null,
    committed_at: new Date().toISOString(),
  });
}

/** The on-chain USDC send landed. `suiDigest` is the idempotency key. */
export function markSent(
  id: string,
  from: OfframpStatus,
  suiDigest: string,
): Promise<OfframpRow> {
  return applyEvent(id, from, "send", {
    sui_digest: suiDigest,
    sent_at: new Date().toISOString(),
  });
}

/** Coinbase confirmed the sale. Only legal from `sent`. */
export function markSettled(id: string, from: OfframpStatus): Promise<OfframpRow> {
  return applyEvent(id, from, "settle", { settled_at: new Date().toISOString() });
}

export function markExpired(
  id: string,
  from: OfframpStatus,
  reason = "deadline passed",
): Promise<OfframpRow> {
  return applyEvent(id, from, "expire", { failure_reason: reason });
}

/**
 * We delivered the USDC but Coinbase never completed the sale.
 *
 * Deliberately does **not** claim the funds were returned. In this corridor
 * they usually were not: the deposit lands in the merchant's Coinbase balance
 * as ordinary USDC and the sell order is simply never matched to it, so the
 * money is with Coinbase and the merchant resolves it there. The on-chain
 * return does happen — Coinbase can send USDC back to the source address — but
 * that case is detected from the merchant's actual USDC balance by
 * `StrandedUsdcCard`, not asserted from a row status we cannot verify.
 */
export function markUnmatched(
  id: string,
  from: OfframpStatus,
  reason = "Coinbase did not complete the sale",
): Promise<OfframpRow> {
  return applyEvent(id, from, "unmatch", { failure_reason: reason });
}

export function markFailed(
  id: string,
  from: OfframpStatus,
  reason: string,
): Promise<OfframpRow> {
  return applyEvent(id, from, "fail", { failure_reason: reason });
}
