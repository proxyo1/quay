/**
 * Browser-side fetch helpers for the KYB flow. All inputs are typed; all
 * errors surface a useful message for the UI to display.
 */

import type {
  KybAdminListItem,
  KybDecision,
  KybStatusResponse,
} from "./types";

export class KybClientError extends Error {
  status: number;
  upstream?: string;
  retryable?: boolean;
  constructor(message: string, status: number, extras?: { upstream?: string; retryable?: boolean }) {
    super(message);
    this.name = "KybClientError";
    this.status = status;
    this.upstream = extras?.upstream;
    this.retryable = extras?.retryable;
  }
}

async function readError(res: Response, fallback: string): Promise<KybClientError> {
  let body: { error?: string; upstream?: string; retryable?: boolean } | null = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  return new KybClientError(body?.error ?? `${fallback} (HTTP ${res.status})`, res.status, {
    upstream: body?.upstream,
    retryable: body?.retryable,
  });
}

// ──────────────────────────────── submit ──────────────────────────────

export interface SubmitKybInput {
  uen: string;
  businessName?: string;
  ciphertextB64: string;
  ciphertextNonceB64: string;
  wrappedDekB64: string;
  kybDocHashHex: string;
  originalMimeType: string;
  claimer: string;
}

export interface SubmitKybResponse {
  submissionId: string;
  pollingToken: string;
  status: "pending";
  submittedAt: string;
}

export async function submitKyb(input: SubmitKybInput): Promise<SubmitKybResponse> {
  const res = await fetch("/api/kyb/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      uen: input.uen,
      business_name: input.businessName,
      ciphertext_b64: input.ciphertextB64,
      ciphertext_nonce_b64: input.ciphertextNonceB64,
      wrapped_dek_b64: input.wrappedDekB64,
      kyb_doc_hash_hex: input.kybDocHashHex,
      original_mime_type: input.originalMimeType,
      claimer: input.claimer,
    }),
  });
  if (!res.ok) throw await readError(res, "kyb submit failed");
  const json = (await res.json()) as {
    submission_id: string;
    polling_token: string;
    status: "pending";
    submitted_at: string;
  };
  return {
    submissionId: json.submission_id,
    pollingToken: json.polling_token,
    status: json.status,
    submittedAt: json.submitted_at,
  };
}

// ──────────────────────────────── status ──────────────────────────────

export async function pollKybStatus(pollingToken: string): Promise<KybStatusResponse> {
  const res = await fetch("/api/kyb/status", {
    headers: { authorization: `Bearer ${pollingToken}` },
  });
  if (!res.ok) throw await readError(res, "kyb status fetch failed");
  return (await res.json()) as KybStatusResponse;
}

// ─────────────────────────────── finalize ─────────────────────────────

export interface FinalizeKybResponse {
  txBytesB64: string;
  sponsorSignature: string;
  sponsorAddress: string;
  expiresAtMs: number;
  evidenceHash: string;
  evidenceBlobId: string;
}

export async function finalizeKyb(
  pollingToken: string,
  claimer: string,
): Promise<FinalizeKybResponse> {
  const res = await fetch("/api/kyb/finalize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pollingToken}`,
    },
    body: JSON.stringify({ claimer }),
  });
  if (!res.ok) throw await readError(res, "kyb finalize failed");
  const json = (await res.json()) as {
    tx_bytes_b64: string;
    sponsor_signature: string;
    sponsor_address: string;
    expires_at_ms: number;
    evidence_hash: string;
    evidence_blob_id: string;
  };
  return {
    txBytesB64: json.tx_bytes_b64,
    sponsorSignature: json.sponsor_signature,
    sponsorAddress: json.sponsor_address,
    expiresAtMs: json.expires_at_ms,
    evidenceHash: json.evidence_hash,
    evidenceBlobId: json.evidence_blob_id,
  };
}

// ────────────────────────────── admin helpers ─────────────────────────

/** Fetch the admin's KYB X25519 pubkey. Unauthenticated — the key is public. */
export async function fetchAdminKybPubkey(): Promise<string> {
  const res = await fetch("/api/kyb/admin-pubkey");
  if (!res.ok) throw await readError(res, "admin pubkey fetch failed");
  const json = (await res.json()) as { pubkey_hex: string };
  return json.pubkey_hex;
}

export async function adminListSubmissions(
  status: "pending" | "approved" | "rejected" | "finalized" | "collision" = "pending",
): Promise<KybAdminListItem[]> {
  const url = `/api/admin/kyb/list?status=${encodeURIComponent(status)}`;
  const res = await fetch(url);
  if (!res.ok) throw await readError(res, "admin list fetch failed");
  const json = (await res.json()) as { items: KybAdminListItem[] };
  return json.items;
}

export async function adminGetSubmission(id: string): Promise<KybAdminListItem> {
  const res = await fetch(`/api/admin/kyb/${encodeURIComponent(id)}`);
  if (!res.ok) throw await readError(res, "admin submission fetch failed");
  return (await res.json()) as KybAdminListItem;
}

export interface AdminDecideInput {
  id: string;
  decision: KybDecision;
  reason?: string;
}

export async function adminDecide(input: AdminDecideInput): Promise<void> {
  const res = await fetch(`/api/admin/kyb/${encodeURIComponent(input.id)}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: input.decision, reason: input.reason }),
  });
  if (!res.ok) throw await readError(res, "admin decide failed");
}

export async function adminChallenge(): Promise<{ nonce: string; ts: number }> {
  const res = await fetch("/api/admin/challenge");
  if (!res.ok) throw await readError(res, "challenge fetch failed");
  return (await res.json()) as { nonce: string; ts: number };
}

export async function adminAuth(
  address: string,
  signatureB64: string,
  nonce: string,
  ts: number,
): Promise<void> {
  const res = await fetch("/api/admin/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, signatureB64, nonce, ts }),
  });
  if (!res.ok) throw await readError(res, "admin auth failed");
}
