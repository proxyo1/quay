import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseClient } from "./supabase";

/**
 * Thin Supabase CRUD around `cashout_requests` (see the migration). The
 * application layer mediates all access (RLS denies direct client reads).
 * Every mutation uses an optimistic-lock `WHERE status = '<expected>'` so a
 * concurrent transition or a retry becomes a no-op/409 rather than a
 * corrupting overwrite — the same posture as kyb-store.
 *
 * Money flow: this store is REQUIRED (no silent no-op when Supabase is
 * unconfigured). Without the row we lose idempotency and the audit trail,
 * which is exactly what protects a merchant's funds.
 */

export type CashoutStatus =
  | "signed"
  | "received"
  | "paying"
  | "paid_out"
  | "failed";

/** Statuses the re-drive script can still act on. */
export const RESUMABLE_STATUSES: CashoutStatus[] = [
  "signed",
  "received",
  "paying",
  "failed",
];

/** Merchant-supplied Wise recipient fields (shape mirrors Wise's account-requirements). */
export interface CashoutRecipient {
  /** Wise account-requirement `type`, e.g. "singapore" or "paynow". */
  type: string;
  /** Field key -> value, exactly as Wise's `details` object expects. */
  details: Record<string, string>;
}

export interface CashoutRow {
  id: string;
  owner: string;
  uen: string | null;
  amount_usdsui_minor: string; // bigint comes back as string
  rate_sgd_per_usd: number;
  fee_bps: number;
  net_sgd_minor: string;
  recipient: CashoutRecipient;
  sui_digest: string | null;
  wise_quote_id: string | null;
  wise_recipient_id: string | null;
  wise_transfer_id: string | null;
  status: CashoutStatus;
  failure_reason: string | null;
  created_at: string;
  received_at: string | null;
  paid_out_at: string | null;
}

export class CashoutStoreError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "CashoutStoreError";
  }
}

function client(): SupabaseClient {
  const c = getSupabaseClient();
  if (!c) {
    throw new CashoutStoreError(
      "Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY",
      500,
    );
  }
  return c;
}

// ─────────────────────────── Reads ─────────────────────────────

export async function getById(id: string): Promise<CashoutRow | null> {
  const { data, error } = await client()
    .from("cashout_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new CashoutStoreError(`getById: ${error.message}`, 500);
  return (data as CashoutRow | null) ?? null;
}

/** Idempotency lookup: has this on-chain transfer already been recorded? */
export async function getByDigest(digest: string): Promise<CashoutRow | null> {
  const { data, error } = await client()
    .from("cashout_requests")
    .select("*")
    .eq("sui_digest", digest)
    .maybeSingle();
  if (error) throw new CashoutStoreError(`getByDigest: ${error.message}`, 500);
  return (data as CashoutRow | null) ?? null;
}

export async function listResumable(): Promise<CashoutRow[]> {
  const { data, error } = await client()
    .from("cashout_requests")
    .select("*")
    .in("status", RESUMABLE_STATUSES)
    .order("created_at", { ascending: true });
  if (error) throw new CashoutStoreError(`listResumable: ${error.message}`, 500);
  return (data ?? []) as CashoutRow[];
}

// ─────────────────────────── Writes ─────────────────────────────

export interface InsertSignedInput {
  owner: string;
  uen: string | null;
  amountUsdsuiMinor: bigint;
  rateSgdPerUsd: number;
  feeBps: number;
  netSgdMinor: bigint;
  recipient: CashoutRecipient;
}

/** Create the row at /api/cashout/initiate with the LOCKED quote (D4). */
export async function insertSigned(
  input: InsertSignedInput,
): Promise<{ id: string; createdAt: string }> {
  const { data, error } = await client()
    .from("cashout_requests")
    .insert({
      owner: input.owner,
      uen: input.uen,
      amount_usdsui_minor: input.amountUsdsuiMinor.toString(),
      rate_sgd_per_usd: input.rateSgdPerUsd,
      fee_bps: input.feeBps,
      net_sgd_minor: input.netSgdMinor.toString(),
      recipient: input.recipient,
      status: "signed",
    })
    .select("id, created_at")
    .single();
  if (error) throw new CashoutStoreError(`insertSigned: ${error.message}`, 500);
  return { id: data.id, createdAt: data.created_at };
}

/**
 * Bind the on-chain digest to the row and move signed -> received. The
 * UNIQUE(sui_digest) constraint + the status optimistic-lock together make
 * this the replay/idempotency guard: a foreign or reused digest 409s.
 */
export async function markReceived(id: string, digest: string): Promise<CashoutRow> {
  const { data, error } = await client()
    .from("cashout_requests")
    .update({ status: "received", sui_digest: digest, received_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "signed") // optimistic lock
    .select("*")
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      throw new CashoutStoreError("this transfer digest was already used", 409);
    }
    throw new CashoutStoreError(`markReceived: ${error.message}`, 500);
  }
  if (!data) {
    throw new CashoutStoreError(
      "no signed row to mark received — already processed or not found",
      409,
    );
  }
  return data as CashoutRow;
}

export interface MarkPayingInput {
  id: string;
  wiseQuoteId: string;
  wiseRecipientId: string;
  wiseTransferId?: string | null;
}

/** Record the Wise ids and move received -> paying. */
export async function markPaying(input: MarkPayingInput): Promise<CashoutRow> {
  const { data, error } = await client()
    .from("cashout_requests")
    .update({
      status: "paying",
      wise_quote_id: input.wiseQuoteId,
      wise_recipient_id: input.wiseRecipientId,
      wise_transfer_id: input.wiseTransferId ?? null,
    })
    .eq("id", input.id)
    .eq("status", "received") // optimistic lock
    .select("*")
    .maybeSingle();
  if (error) throw new CashoutStoreError(`markPaying: ${error.message}`, 500);
  if (!data) {
    throw new CashoutStoreError("no received row to mark paying", 409);
  }
  return data as CashoutRow;
}

/** Terminal success: paying|received -> paid_out. */
export async function markPaidOut(id: string, wiseTransferId: string): Promise<CashoutRow> {
  const { data, error } = await client()
    .from("cashout_requests")
    .update({
      status: "paid_out",
      wise_transfer_id: wiseTransferId,
      paid_out_at: new Date().toISOString(),
    })
    .eq("id", id)
    .in("status", ["received", "paying"]) // optimistic lock
    .select("*")
    .maybeSingle();
  if (error) throw new CashoutStoreError(`markPaidOut: ${error.message}`, 500);
  if (!data) throw new CashoutStoreError("no in-flight row to mark paid_out", 409);
  return data as CashoutRow;
}

/** Mark a post-receipt failure. Recoverable via the re-drive script. */
export async function markFailed(id: string, reason: string): Promise<void> {
  const { error } = await client()
    .from("cashout_requests")
    .update({ status: "failed", failure_reason: reason.slice(0, 500) })
    .eq("id", id)
    .in("status", ["received", "paying", "failed"]);
  if (error) throw new CashoutStoreError(`markFailed: ${error.message}`, 500);
}
