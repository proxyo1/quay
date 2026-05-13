import "server-only";

import { getSupabaseClient, isSupabaseConfigured } from "./supabase";

/**
 * Append-only audit log writer (Phase 4, D8).
 *
 * The Move contract holds the canonical `evidence_hash` on each
 * MerchantEntry (public, content-bound). This table maps each
 * `evidence_hash` to its Walrus blob_id so the operator (and the
 * Phase 6 merchant page) can resolve evidence content from the
 * on-chain commitment.
 *
 * Non-blocking by design: a Supabase outage or missing config logs a
 * warning and returns without throwing. The attestation flow continues
 * because the on-chain evidence_hash is the load-bearing artifact;
 * the blob_id mapping is recoverable from operator-side records.
 */

export interface AuditRow {
  /** 64-char lowercase hex (blake2b256 of evidence content). */
  evidenceHash: string;
  /** Walrus blob ID returned by the publisher. */
  walrusBlobId: string;
  /** Hex-encoded blake2b256("PAYNOW_UEN_V1" || uen). */
  uenHashHex: string;
  /** Unix-ms when the issuer signed the attestation. */
  signedAtMs: number;
  /** Sui address of the claimer (the merchant). */
  claimer: string;
}

export interface AppendResult {
  kind: "written" | "skipped-no-config" | "skipped-error";
  error?: string;
}

export async function appendAuditRow(row: AuditRow): Promise<AppendResult> {
  if (!isSupabaseConfigured()) {
    console.warn(
      "[issuer-audit-log] Supabase not configured — skipping write for evidence_hash",
      row.evidenceHash.slice(0, 16) + "…",
    );
    return { kind: "skipped-no-config" };
  }
  const supabase = getSupabaseClient();
  if (!supabase) return { kind: "skipped-no-config" };

  const { error } = await supabase.from("issuer_audit_log").insert({
    evidence_hash: row.evidenceHash,
    walrus_blob_id: row.walrusBlobId,
    uen_hash: row.uenHashHex,
    signed_at_ms: row.signedAtMs,
    claimer: row.claimer,
  });
  if (error) {
    console.error("[issuer-audit-log] Supabase insert failed:", error.message);
    return { kind: "skipped-error", error: error.message };
  }
  return { kind: "written" };
}

/**
 * Look up the Walrus blob_id for a given evidence_hash (used by the
 * Phase 6 merchant page evidence-link rendering). Returns null on miss
 * or when Supabase is not configured.
 */
export async function lookupBlobIdByEvidenceHash(
  evidenceHashHex: string,
): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("issuer_audit_log")
    .select("walrus_blob_id")
    .eq("evidence_hash", evidenceHashHex)
    .maybeSingle();
  if (error || !data) return null;
  return typeof data.walrus_blob_id === "string" ? data.walrus_blob_id : null;
}
