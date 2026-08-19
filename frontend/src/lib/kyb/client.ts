/**
 * Browser-side fetch helpers for the KYB flow. All inputs are typed; all
 * errors surface a useful message for the UI to display.
 */

import type {
  KybAdminListItem,
  KybDecision,
  KybStatus,
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
  /** Registered name. Only used when ACRA cannot supply one. */
  businessName?: string;
  /** Signboard name customers know. Shown to payers. */
  tradingName?: string;
  claimer: string;
}

export interface SubmitKybResponse {
  submissionId: string;
  pollingToken: string;
  status: "awaiting_code";
  submittedAt: string;
  /** ACRA-registered name, resolved server-side. */
  businessName: string;
  /** What to look for on the bank statement, e.g. "QUAY-7F3K9M". */
  codeReference: string;
  codeExpiresAt: string;
  /** False on the manual rail: a human still has to send the cent. */
  centSent: boolean;
  /** Why ACRA produced nothing, when it produced nothing. */
  acraNote: string | null;
}

export async function submitKyb(input: SubmitKybInput): Promise<SubmitKybResponse> {
  const res = await fetch("/api/kyb/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      uen: input.uen,
      business_name: input.businessName,
      trading_name: input.tradingName,
      claimer: input.claimer,
    }),
  });
  if (!res.ok) throw await readError(res, "kyb submit failed");
  const json = (await res.json()) as {
    submission_id: string;
    polling_token: string;
    status: "awaiting_code";
    submitted_at: string;
    business_name: string;
    code_reference: string;
    code_expires_at: string;
    cent_sent: boolean;
    acra_note: string | null;
  };
  return {
    submissionId: json.submission_id,
    pollingToken: json.polling_token,
    status: json.status,
    submittedAt: json.submitted_at,
    businessName: json.business_name,
    codeReference: json.code_reference,
    codeExpiresAt: json.code_expires_at,
    centSent: json.cent_sent,
    acraNote: json.acra_note,
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

export interface VerifyCodeResult {
  status: "verified" | "wrong" | "locked" | "unavailable" | "no_pending_code";
  remaining?: number;
}

/**
 * Submit the code the merchant read off their bank statement.
 *
 * Every non-2xx here is a MEANINGFUL state, not a failure to surface raw:
 * a wrong code with attempts left, a lockout, a temporary outage, and an
 * expired code all need different copy and different next actions. So this
 * reads the body on both paths rather than throwing on !res.ok.
 */
export async function verifyKybCode(
  pollingToken: string,
  code: string,
): Promise<VerifyCodeResult> {
  const res = await fetch("/api/kyb/verify-code", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pollingToken}`,
    },
    body: JSON.stringify({ code }),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<VerifyCodeResult>;
  if (json.status) return json as VerifyCodeResult;
  // No recognizable body: treat as a transient outage rather than inventing
  // a verdict about the merchant's code.
  if (!res.ok) return { status: "unavailable" };
  return { status: "verified" };
}

export interface ResendCodeResult {
  code_reference: string;
  code_expires_at: string;
  cent_sent: boolean;
}

export async function resendKybCode(
  pollingToken: string,
): Promise<ResendCodeResult> {
  const res = await fetch("/api/kyb/resend-code", {
    method: "POST",
    headers: { authorization: `Bearer ${pollingToken}` },
  });
  if (!res.ok) throw await readError(res, "could not send a new code");
  return (await res.json()) as ResendCodeResult;
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
  status: KybStatus = "pending",
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
