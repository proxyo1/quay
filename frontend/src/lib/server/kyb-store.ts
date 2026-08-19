import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AcraSnapshot,
  KybAdminListItem,
  KybDecision,
  KybStatus,
  KybSubmission,
  VerificationMethod,
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
  /** ACRA-registered entity name. */
  businessName?: string;
  /** Signboard name customers know, shown to payers. */
  tradingName?: string;
  /** What ACRA said at claim time. Hashed into evidence_content v2 and never
   *  re-fetched at finalize, so the commitment describes the fact the claim
   *  was actually accepted under. */
  acraSnapshot?: AcraSnapshot;
  /**
   * Document fields, all optional.
   *
   * Onboarding no longer collects a document: an ACRA business profile is a
   * public record anyone can buy for S$5.50, so reviewing one never proved
   * ownership. Proof of control over the UEN's PayNow account replaced it.
   * These stay in the signature so the legacy shape still type-checks and
   * pre-existing rows remain readable.
   */
  ciphertextBlobId?: string;
  ciphertextNonceB64?: string;
  wrappedDekB64?: string;
  originalMimeType?: string;
  kybDocHashHex?: string;
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
      trading_name: input.tradingName ?? null,
      acra_snapshot: input.acraSnapshot ?? null,
      // Written only when actually supplied. Passing explicit nulls would be
      // equivalent, but omitting keeps the insert honest about what a
      // document-free submission contains.
      ciphertext_blob_id: input.ciphertextBlobId ?? null,
      ciphertext_nonce: input.ciphertextNonceB64
        ? b64ToHexLiteral(input.ciphertextNonceB64)
        : null,
      wrapped_dek: input.wrappedDekB64
        ? b64ToHexLiteral(input.wrappedDekB64)
        : null,
      original_mime_type: input.originalMimeType ?? null,
      kyb_doc_hash: input.kybDocHashHex
        ? hexToHexLiteral(input.kybDocHashHex)
        : null,
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

// ──────────────────── PayNow micro-deposit verification ───────────────────

export interface StartVerificationInput {
  id: string;
  /** blake2b256 of the code, hex. The plaintext is never stored. */
  codeHashHex: string;
  /** The reference as sent, e.g. "QUAY-7F3K9M". */
  reference: string;
  expiresAt: Date;
}

/**
 * pending → awaiting_code, attaching a freshly issued code.
 *
 * Optimistic-locked on `status = 'pending'`, so a double-submit issues one
 * code rather than silently replacing a live one (which would strand a
 * merchant holding a code that no longer verifies).
 *
 * Also used for resend, where the caller first moves the row back to pending.
 */
export async function startVerification(
  input: StartVerificationInput,
): Promise<KybSubmission> {
  const { data, error } = await client()
    .from("kyb_submissions")
    .update({
      status: "awaiting_code",
      code_hash: hexToHexLiteral(input.codeHashHex),
      code_reference: input.reference,
      code_expires_at: input.expiresAt.toISOString(),
      code_sent_at: null,
    })
    .eq("id", input.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) throw new KybStoreError(`startVerification: ${error.message}`, 500);
  if (!data) {
    throw new KybStoreError(
      "no pending row to start verification — already started or row not found",
      409,
    );
  }
  return rowToSubmission(data);
}

/** Records that the cent actually left. Until this is set, the row is the
 *  operator's send queue (see ManualCentSender). */
export async function markCentSent(id: string): Promise<void> {
  const { error } = await client()
    .from("kyb_submissions")
    .update({ code_sent_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "awaiting_code");
  if (error) throw new KybStoreError(`markCentSent: ${error.message}`, 500);
}

/**
 * The stored code hash, or null if there is nothing to verify against.
 * Server-only by construction: `code_hash` is excluded from every mapped
 * shape, so this is the sole read path.
 */
export async function getCodeHash(id: string): Promise<Uint8Array | null> {
  const { data, error } = await client()
    .from("kyb_submissions")
    .select("code_hash")
    .eq("id", id)
    .eq("status", "awaiting_code")
    .maybeSingle();
  if (error) throw new KybStoreError(`getCodeHash: ${error.message}`, 500);
  const raw = (data as { code_hash: string | null } | null)?.code_hash;
  if (!raw) return null;
  return Uint8Array.from(Buffer.from(byteaToHex(raw), "hex"));
}

/**
 * awaiting_code → approved. Clears the code hash: it has done its job and
 * keeping it serves no purpose.
 */
export async function markVerified(
  id: string,
  method: VerificationMethod,
): Promise<KybSubmission> {
  const now = new Date().toISOString();
  const { data, error } = await client()
    .from("kyb_submissions")
    .update({
      status: "approved",
      verification_method: method,
      verified_at: now,
      decided_at: now,
      decided_by: method === "in_person" ? "operator" : "paynow-microdeposit",
      code_hash: null,
    })
    .eq("id", id)
    .eq("status", "awaiting_code")
    .select("*")
    .maybeSingle();
  if (error) throw new KybStoreError(`markVerified: ${error.message}`, 500);
  if (!data) {
    throw new KybStoreError(
      "no awaiting_code row to verify — expired, locked out, or already verified",
      409,
    );
  }
  return rowToSubmission(data);
}

/** Too many wrong guesses. Terminal until an operator intervenes. */
export async function markCodeFailed(id: string): Promise<void> {
  const { error } = await client()
    .from("kyb_submissions")
    .update({ status: "code_failed", code_hash: null })
    .eq("id", id)
    .eq("status", "awaiting_code");
  if (error) throw new KybStoreError(`markCodeFailed: ${error.message}`, 500);
}

/**
 * Release verifications whose code expired.
 *
 * Load-bearing, not housekeeping: `awaiting_code` sits inside the
 * one-active-per-uen unique index, so an abandoned attempt holds a real
 * business's UEN hostage until this runs. Rows go back to `pending` rather
 * than a terminal state so the merchant can simply request a new code.
 *
 * Returns the affected ids so the caller can log what it freed.
 */
export async function releaseExpiredVerifications(): Promise<string[]> {
  const { data, error } = await client()
    .from("kyb_submissions")
    .update({ status: "pending", code_hash: null, code_reference: null })
    .eq("status", "awaiting_code")
    .lt("code_expires_at", new Date().toISOString())
    .select("id");
  if (error) {
    throw new KybStoreError(`releaseExpiredVerifications: ${error.message}`, 500);
  }
  return (data ?? []).map((r) => (r as { id: string }).id);
}

/**
 * Move a live verification back to `pending` so a fresh code can be issued.
 *
 * Only from `awaiting_code`. A `code_failed` row is a lockout and must not be
 * self-serve resettable, or the attempt cap means nothing — a guesser would
 * just resend their way to unlimited tries.
 */
export async function resetForResend(id: string): Promise<void> {
  const { data, error } = await client()
    .from("kyb_submissions")
    .update({ status: "pending", code_hash: null, code_reference: null })
    .eq("id", id)
    .eq("status", "awaiting_code")
    .select("id")
    .maybeSingle();
  if (error) throw new KybStoreError(`resetForResend: ${error.message}`, 500);
  if (!data) {
    throw new KybStoreError(
      "nothing to resend — the verification is not awaiting a code",
      409,
    );
  }
}

/** Rows waiting on a human to send the cent. The operator's work queue. */
export async function listAwaitingSend(): Promise<KybAdminListItem[]> {
  const { data, error } = await client()
    .from("kyb_submissions")
    .select("*")
    .eq("status", "awaiting_code")
    .is("code_sent_at", null)
    .order("submitted_at", { ascending: true });
  if (error) throw new KybStoreError(`listAwaitingSend: ${error.message}`, 500);
  return (data ?? []).map(rowToAdminItem);
}

export async function markCollision(id: string): Promise<void> {
  const { error } = await client()
    .from("kyb_submissions")
    .update({ status: "collision" })
    .eq("id", id)
    // awaiting_code included: a merchant can be mid-verification when someone
    // else lands the UEN on chain, and that row must not stay active.
    .in("status", ["approved", "pending", "awaiting_code"]);
  if (error) throw new KybStoreError(`markCollision: ${error.message}`, 500);
}

// ──────────────────────────── Row mapping ─────────────────────────────

interface KybRow {
  id: string;
  wallet_address: string;
  uen: string;
  business_name: string | null;
  trading_name: string | null;
  // Nullable since the document was dropped from onboarding. Legacy rows
  // still carry values here.
  ciphertext_blob_id: string | null;
  ciphertext_nonce: string | null; // bytea returned as `\x...` hex literal
  wrapped_dek: string | null;
  original_mime_type: string | null;
  kyb_doc_hash: string | null;
  status: KybStatus;
  rejection_reason: string | null;
  evidence_hash: string | null;
  evidence_blob_id: string | null;
  verification_method: VerificationMethod | null;
  acra_snapshot: AcraSnapshot | null;
  /** bytea. Never leaves the server — excluded from every mapped shape. */
  code_hash: string | null;
  code_reference: string | null;
  code_sent_at: string | null;
  code_expires_at: string | null;
  verified_at: string | null;
  submitted_at: string;
  decided_at: string | null;
  decided_by: string | null;
  finalized_at: string | null;
}

/** bytea helpers that tolerate a null column. */
function byteaToBase64OrNull(v: string | null): string | null {
  return v === null ? null : byteaToBase64(v);
}
function byteaToHexOrNull(v: string | null): string | null {
  return v === null ? null : byteaToHex(v);
}

function rowToSubmission(r: KybRow): KybSubmission {
  return {
    id: r.id,
    wallet_address: r.wallet_address,
    uen: r.uen,
    business_name: r.business_name,
    trading_name: r.trading_name,
    ciphertext_blob_id: r.ciphertext_blob_id,
    ciphertext_nonce_b64: byteaToBase64OrNull(r.ciphertext_nonce),
    wrapped_dek_b64: byteaToBase64OrNull(r.wrapped_dek),
    original_mime_type: r.original_mime_type,
    kyb_doc_hash_hex: byteaToHexOrNull(r.kyb_doc_hash),
    status: r.status,
    rejection_reason: r.rejection_reason,
    evidence_hash: r.evidence_hash,
    evidence_blob_id: r.evidence_blob_id,
    verification_method: r.verification_method,
    acra_snapshot: r.acra_snapshot,
    code_reference: r.code_reference,
    code_sent_at: r.code_sent_at,
    code_expires_at: r.code_expires_at,
    verified_at: r.verified_at,
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
    trading_name: r.trading_name,
    ciphertext_blob_id: r.ciphertext_blob_id,
    ciphertext_nonce_b64: byteaToBase64OrNull(r.ciphertext_nonce),
    wrapped_dek_b64: byteaToBase64OrNull(r.wrapped_dek),
    original_mime_type: r.original_mime_type,
    kyb_doc_hash_hex: byteaToHexOrNull(r.kyb_doc_hash),
    status: r.status,
    rejection_reason: r.rejection_reason,
    verification_method: r.verification_method,
    code_reference: r.code_reference,
    code_sent_at: r.code_sent_at,
    code_expires_at: r.code_expires_at,
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
