/**
 * Single source of truth for KYB shapes shared between client and server.
 */

export type KybStatus = "pending" | "approved" | "rejected" | "finalized" | "collision";

export type KybDecision = "approved" | "rejected";

/** Mirror of the `kyb_submissions` row, normalized for JSON transport. */
export interface KybSubmission {
  id: string;
  wallet_address: string;
  uen: string;
  business_name: string | null;
  ciphertext_blob_id: string;
  ciphertext_nonce_b64: string;
  wrapped_dek_b64: string;
  original_mime_type: string;
  kyb_doc_hash_hex: string;
  status: KybStatus;
  rejection_reason: string | null;
  evidence_hash: string | null;
  evidence_blob_id: string | null;
  submitted_at: string;
  decided_at: string | null;
  decided_by: string | null;
  finalized_at: string | null;
}

/** Public shape returned by /api/kyb/status — strips wallet/blob fields. */
export interface KybStatusResponse {
  status: KybStatus;
  rejection_reason: string | null;
  submitted_at: string;
  decided_at: string | null;
  finalized_at: string | null;
}

/** Admin-only listing row — includes the wrapped DEK + blob id for decrypt. */
export interface KybAdminListItem {
  id: string;
  wallet_address: string;
  uen: string;
  business_name: string | null;
  ciphertext_blob_id: string;
  ciphertext_nonce_b64: string;
  wrapped_dek_b64: string;
  original_mime_type: string;
  kyb_doc_hash_hex: string;
  status: KybStatus;
  rejection_reason: string | null;
  submitted_at: string;
  decided_at: string | null;
  decided_by: string | null;
}
