/**
 * Single source of truth for KYB shapes shared between client and server.
 */

/**
 * Submission lifecycle.
 *
 *   pending ──send cent──▶ awaiting_code ──correct code──▶ approved ──▶ finalized
 *                              │  │
 *            too many wrong ───┘  └─── expired (swept, row released)
 *                    ▼
 *               code_failed
 *
 * `approved` is retained as the terminal pre-registration state because
 * /api/kyb/finalize gates on it; a code-verified merchant lands there exactly
 * as an admin-approved one used to.
 */
export type KybStatus =
  | "pending"
  | "awaiting_code"
  | "code_failed"
  | "approved"
  | "rejected"
  | "finalized"
  | "collision";

export type KybDecision = "approved" | "rejected";

/** How ownership was proven. Bound into evidence_content v2. */
export type VerificationMethod = "paynow_microdeposit" | "in_person";

/**
 * What the ACRA register said when the claim was made.
 *
 * Every key is always present, null when unknown. JCS canonicalization treats
 * an absent key and a null value as different bytes, so the convention has to
 * be fixed or the evidence hash becomes irreproducible.
 */
export interface AcraSnapshot {
  entity_name: string | null;
  entity_status: string | null;
  entity_type: string | null;
  checked_at_ms: number;
  /** Why the lookup produced nothing, when it produced nothing. Lets an
   *  auditor tell "deregistered" apart from "we could not reach ACRA". */
  note: string | null;
}

/**
 * Mirror of the `kyb_submissions` row, normalized for JSON transport.
 *
 * The document fields are nullable: onboarding stopped collecting them when
 * proof of account control replaced document review. Rows submitted before
 * that still carry them, which is why they are relaxed rather than dropped.
 *
 * `code_hash` is deliberately absent. It never leaves the server.
 */
export interface KybSubmission {
  id: string;
  wallet_address: string;
  uen: string;
  /** ACRA-registered entity name. Bound on chain. */
  business_name: string | null;
  /** The signboard name customers know. Shown to payers. */
  trading_name: string | null;
  ciphertext_blob_id: string | null;
  ciphertext_nonce_b64: string | null;
  wrapped_dek_b64: string | null;
  original_mime_type: string | null;
  kyb_doc_hash_hex: string | null;
  status: KybStatus;
  rejection_reason: string | null;
  evidence_hash: string | null;
  evidence_blob_id: string | null;
  verification_method: VerificationMethod | null;
  /** ACRA register state at claim time. Hashed into evidence_content v2. */
  acra_snapshot: AcraSnapshot | null;
  /** e.g. "QUAY-7F3K9M". Safe to show: support needs it, and it does not
   *  reveal the code to anyone who cannot already read the bank statement. */
  code_reference: string | null;
  code_sent_at: string | null;
  code_expires_at: string | null;
  verified_at: string | null;
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
  /** Lets the await-code screen tell the merchant what to look for. */
  code_reference: string | null;
  code_sent_at: string | null;
  code_expires_at: string | null;
}

/** Admin-only listing row. */
export interface KybAdminListItem {
  id: string;
  wallet_address: string;
  uen: string;
  business_name: string | null;
  trading_name: string | null;
  ciphertext_blob_id: string | null;
  ciphertext_nonce_b64: string | null;
  wrapped_dek_b64: string | null;
  original_mime_type: string | null;
  kyb_doc_hash_hex: string | null;
  status: KybStatus;
  rejection_reason: string | null;
  verification_method: VerificationMethod | null;
  code_reference: string | null;
  code_sent_at: string | null;
  code_expires_at: string | null;
  submitted_at: string;
  decided_at: string | null;
  decided_by: string | null;
}
