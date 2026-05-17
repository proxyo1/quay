import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  KybAdminListItem,
  KybDecision,
  KybStatus,
  KybSubmission,
} from "@/lib/kyb/types";

import { getSupabaseClient } from "./supabase";

/**
 * Thin Supabase CRUD around `kyb_submissions`.
 *
 * The application layer mediates all reads/writes (RLS denies direct
 * client access). Every method that mutates uses an optimistic-lock
 * `WHERE status = '<expected>'` to make double-write a no-op rather than
 * a corrupting overwrite.
 */

export class KybStoreError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "KybStoreError";
  }
}

function client(): SupabaseClient {
  const c = getSupabaseClient();
  if (!c) {
    throw new KybStoreError(
      "Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY",
      500,
    );
  }
  return c;
}

// ─────────────────────────── Read helpers ─────────────────────────────

export async function getSubmission(id: string): Promise<KybSubmission | null> {
  const { data, error } = await client()
    .from("kyb_submissions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new KybStoreError(`getSubmission: ${error.message}`, 500);
  if (!data) return null;
  return rowToSubmission(data);
}

export async function getPendingByWallet(
  walletAddress: string,
): Promise<KybSubmission | null> {
  const { data, error } = await client()
    .from("kyb_submissions")
    .select("*")
    .eq("wallet_address", walletAddress)
    .eq("status", "pending")
    .maybeSingle();
  if (error) throw new KybStoreError(`getPendingByWallet: ${error.message}`, 500);
  if (!data) return null;
  return rowToSubmission(data);
}

export async function listByStatus(status: KybStatus): Promise<KybAdminListItem[]> {
  const { data, error } = await client()
    .from("kyb_submissions")
    .select("*")
    .eq("status", status)
    .order("submitted_at", { ascending: false });
  if (error) throw new KybStoreError(`listByStatus: ${error.message}`, 500);
  return (data ?? []).map(rowToAdminItem);
}

// ─────────────────────────── Write helpers ────────────────────────────

export interface InsertSubmissionInput {
  walletAddress: string;
  uen: string;
  businessName?: string;
  ciphertextBlobId: string;
  ciphertextNonceB64: string;
  wrappedDekB64: string;
  originalMimeType: string;
  kybDocHashHex: string;
}

/**
 * Insert a new pending submission. Throws KybStoreError(409) on either
 * partial unique-index collision (one-pending-per-wallet or one-active-per-uen).
 */
export async function insertSubmission(
  input: InsertSubmissionInput,
): Promise<{ id: string; submittedAt: string }> {
  const { data, error } = await client()
    .from("kyb_submissions")
    .insert({
      wallet_address: input.walletAddress,
      uen: input.uen,
      business_name: input.businessName ?? null,
      ciphertext_blob_id: input.ciphertextBlobId,
      ciphertext_nonce: b64ToHexLiteral(input.ciphertextNonceB64),
      wrapped_dek: b64ToHexLiteral(input.wrappedDekB64),
      original_mime_type: input.originalMimeType,
      kyb_doc_hash: hexToHexLiteral(input.kybDocHashHex),
      status: "pending",
    })
    .select("id, submitted_at")
    .single();

  if (error) {
    // Postgres unique violation = SQLSTATE 23505.
    if (error.code === "23505") {
      throw new KybStoreError(
        "submission collides with an existing pending/active row for this wallet or UEN",
        409,
      );
    }
    throw new KybStoreError(`insertSubmission: ${error.message}`, 500);
  }
  return { id: data.id, submittedAt: data.submitted_at };
}

export interface UpdateDecisionInput {
  id: string;
  decision: KybDecision;
  rejectionReason?: string;
  adminAddress: string;
}

/**
 * Move a row from pending → approved | rejected. Uses
 * `WHERE status = 'pending'` so a concurrent decision (race or admin
 * double-click) becomes a 409, not an overwrite.
 */
export async function updateDecision(
  input: UpdateDecisionInput,
): Promise<KybSubmission> {
  if (input.decision === "rejected" && !input.rejectionReason?.trim()) {
    throw new KybStoreError("rejection requires a non-empty reason", 400);
  }
  const { data, error } = await client()
    .from("kyb_submissions")
    .update({
      status: input.decision,
      decided_at: new Date().toISOString(),
      decided_by: input.adminAddress,
      rejection_reason:
        input.decision === "rejected" ? (input.rejectionReason ?? "").trim() : null,
    })
    .eq("id", input.id)
    .eq("status", "pending") // optimistic lock
    .select("*")
    .maybeSingle();
  if (error) throw new KybStoreError(`updateDecision: ${error.message}`, 500);
  if (!data) {
    throw new KybStoreError(
      "no pending row to decide — already decided or row not found",
      409,
    );
  }
  return rowToSubmission(data);
}

export interface MarkFinalizedInput {
  id: string;
  evidenceHashHex: string;
  evidenceBlobId: string;
}

/**
 * Move a row from approved → finalized. Optimistic-locked on
 * status='approved' so a re-finalize attempt becomes 409.
 */
export async function markFinalized(
  input: MarkFinalizedInput,
): Promise<KybSubmission> {
  const { data, error } = await client()
    .from("kyb_submissions")
    .update({
      status: "finalized",
      evidence_hash: input.evidenceHashHex.toLowerCase(),
      evidence_blob_id: input.evidenceBlobId,
      finalized_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .eq("status", "approved") // optimistic lock
    .select("*")
    .maybeSingle();
  if (error) throw new KybStoreError(`markFinalized: ${error.message}`, 500);
  if (!data) {
    throw new KybStoreError(
      "no approved row to finalize — already finalized or row not found",
      409,
    );
  }
  return rowToSubmission(data);
}

export async function markCollision(id: string): Promise<void> {
  const { error } = await client()
    .from("kyb_submissions")
    .update({ status: "collision" })
    .eq("id", id)
    .in("status", ["approved", "pending"]);
  if (error) throw new KybStoreError(`markCollision: ${error.message}`, 500);
}

// ──────────────────────────── Row mapping ─────────────────────────────

interface KybRow {
  id: string;
  wallet_address: string;
  uen: string;
  business_name: string | null;
  ciphertext_blob_id: string;
  ciphertext_nonce: string; // bytea returned as `\x...` hex literal
  wrapped_dek: string;
  original_mime_type: string;
  kyb_doc_hash: string;
  status: KybStatus;
  rejection_reason: string | null;
  evidence_hash: string | null;
  evidence_blob_id: string | null;
  submitted_at: string;
  decided_at: string | null;
  decided_by: string | null;
  finalized_at: string | null;
}

function rowToSubmission(r: KybRow): KybSubmission {
  return {
    id: r.id,
    wallet_address: r.wallet_address,
    uen: r.uen,
    business_name: r.business_name,
    ciphertext_blob_id: r.ciphertext_blob_id,
    ciphertext_nonce_b64: byteaToBase64(r.ciphertext_nonce),
    wrapped_dek_b64: byteaToBase64(r.wrapped_dek),
    original_mime_type: r.original_mime_type,
    kyb_doc_hash_hex: byteaToHex(r.kyb_doc_hash),
    status: r.status,
    rejection_reason: r.rejection_reason,
    evidence_hash: r.evidence_hash,
    evidence_blob_id: r.evidence_blob_id,
    submitted_at: r.submitted_at,
    decided_at: r.decided_at,
    decided_by: r.decided_by,
    finalized_at: r.finalized_at,
  };
}

function rowToAdminItem(r: KybRow): KybAdminListItem {
  return {
    id: r.id,
    wallet_address: r.wallet_address,
    uen: r.uen,
    business_name: r.business_name,
    ciphertext_blob_id: r.ciphertext_blob_id,
    ciphertext_nonce_b64: byteaToBase64(r.ciphertext_nonce),
    wrapped_dek_b64: byteaToBase64(r.wrapped_dek),
    original_mime_type: r.original_mime_type,
    kyb_doc_hash_hex: byteaToHex(r.kyb_doc_hash),
    status: r.status,
    rejection_reason: r.rejection_reason,
    submitted_at: r.submitted_at,
    decided_at: r.decided_at,
    decided_by: r.decided_by,
  };
}

// ─── Postgres bytea ↔ JS bytes plumbing ───
//
// Supabase returns bytea columns as a hex-encoded string prefixed with
// `\x`. To insert, we pass a hex literal of the same shape. These helpers
// are deliberately small and tested in __tests__/.

export function b64ToHexLiteral(b64: string): string {
  const bytes = Buffer.from(b64, "base64");
  return "\\x" + bytes.toString("hex");
}

export function hexToHexLiteral(hex: string): string {
  return "\\x" + hex.toLowerCase();
}

export function byteaToBase64(bytea: string): string {
  if (!bytea.startsWith("\\x")) return bytea; // already raw
  return Buffer.from(bytea.slice(2), "hex").toString("base64");
}

export function byteaToHex(bytea: string): string {
  if (!bytea.startsWith("\\x")) return bytea;
  return bytea.slice(2).toLowerCase();
}
