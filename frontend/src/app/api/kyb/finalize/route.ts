import "server-only";

import { blake2b } from "@noble/hashes/blake2.js";
import canonicalize from "canonicalize";
import { NextResponse } from "next/server";

import {
  AttestationError,
  signAndBuildRegisterTx,
} from "@/lib/server/kyb-attestation";
import {
  getSubmission,
  KybStoreError,
  markFinalized,
} from "@/lib/server/kyb-store";
import { verifyPollingToken } from "@/lib/server/polling-token";

export const runtime = "nodejs";

interface FinalizeRequestBody {
  claimer?: string;
}

interface FinalizeResponseBody {
  tx_bytes_b64: string;
  sponsor_signature: string;
  sponsor_address: string;
  expires_at_ms: number;
  evidence_hash: string;
  evidence_blob_id: string;
}

/**
 * Called by the merchant after the admin has approved their submission.
 *
 * Builds the canonical evidence_content JSON (JCS-canonicalized for
 * deterministic hashing), runs the existing attestation + sponsored-tx
 * builder, and marks the row as finalized. Returns tx bytes + sponsor
 * signature; the merchant signs as sender on the client and submits via
 * executeTransactionBlock.
 */
export async function POST(req: Request): Promise<NextResponse> {
  // ── Auth: polling token. ──
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) {
    return NextResponse.json(
      { error: "missing or malformed Authorization: Bearer <token>" },
      { status: 401 },
    );
  }
  let claims;
  try {
    claims = await verifyPollingToken(m[1]);
  } catch (e) {
    return NextResponse.json(
      { error: `polling token invalid: ${e instanceof Error ? e.message : String(e)}` },
      { status: 401 },
    );
  }

  let body: FinalizeRequestBody;
  try {
    body = (await req.json()) as FinalizeRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.claimer || !/^0x[0-9a-fA-F]+$/.test(body.claimer)) {
    return NextResponse.json({ error: "claimer address invalid" }, { status: 400 });
  }

  // ── Load submission, verify state + ownership. ──
  let submission;
  try {
    submission = await getSubmission(claims.submissionId);
  } catch (e) {
    if (e instanceof KybStoreError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: `db error: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  if (!submission) {
    return NextResponse.json({ error: "submission not found" }, { status: 404 });
  }
  if (submission.wallet_address.toLowerCase() !== body.claimer.toLowerCase()) {
    return NextResponse.json(
      { error: "claimer address does not match submission wallet" },
      { status: 403 },
    );
  }
  if (submission.wallet_address.toLowerCase() !== claims.walletAddress.toLowerCase()) {
    return NextResponse.json(
      { error: "polling token wallet does not match submission wallet" },
      { status: 403 },
    );
  }
  if (submission.status !== "approved") {
    return NextResponse.json(
      {
        error: `submission status is '${submission.status}', expected 'approved'`,
        status: submission.status,
      },
      { status: 409 },
    );
  }

  // ── Build canonical evidence_content. JCS (RFC 8785) gives identical
  //    bytes across producers, so anyone can re-hash and verify. ──
  const decidedAtMs = submission.decided_at
    ? Date.parse(submission.decided_at)
    : Date.now();
  const submittedAtMs = Date.parse(submission.submitted_at);

  // ── evidence_content v2 ──
  //
  // v1 committed to the KYB document (hash + Walrus blob id). Onboarding no
  // longer collects a document, because an ACRA business profile is a public
  // record anyone can buy for S$5.50 and reviewing one never proved
  // ownership. v2 commits to what actually justified the approval: proof of
  // control over the UEN's PayNow account, plus what the register said at
  // claim time.
  //
  // v1 blobs must keep verifying. Their hashes are committed on chain and
  // cannot be backfilled, so any reader must switch on `v` and keep the v1
  // path alive — breaking it would make every already-registered merchant
  // unverifiable. There is a regression test for exactly this.
  //
  // Every key is always present, null when unknown. JCS treats an absent key
  // and a null value as different bytes, so the convention must be fixed or
  // the hash stops being reproducible.
  const evidenceObject = {
    v: 2,
    uen: submission.uen,
    business_name: submission.business_name ?? "",
    trading_name: submission.trading_name,
    verification_method: submission.verification_method,
    verified_at_ms: submission.verified_at
      ? Date.parse(submission.verified_at)
      : null,
    acra: submission.acra_snapshot,
    submitted_at_ms: submittedAtMs,
    approved_at_ms: decidedAtMs,
    claimer_address: submission.wallet_address,
  };
  const canonical = canonicalize(evidenceObject);
  if (!canonical) {
    return NextResponse.json(
      { error: "canonicalize() returned null — evidence_content contains a non-serializable value" },
      { status: 500 },
    );
  }
  const evidenceBytes = new TextEncoder().encode(canonical);
  const evidenceHash = blake2b(evidenceBytes, { dkLen: 32 });
  const evidenceHashHex = Buffer.from(evidenceHash).toString("hex");

  // ── Sign attestation + build sponsored tx. ──
  let attestation;
  try {
    attestation = await signAndBuildRegisterTx({
      uen: submission.uen,
      claimer: submission.wallet_address,
      evidenceHashHex,
      evidenceContent: canonical,
      // (no metadataBlobId — merchant logo handled separately via update_metadata)
    });
  } catch (e) {
    if (e instanceof AttestationError) {
      return NextResponse.json(
        { error: e.message, upstream: e.upstream, retryable: e.retryable },
        { status: e.status },
      );
    }
    return NextResponse.json(
      { error: `attestation failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  if (!attestation.walrusBlobId) {
    return NextResponse.json(
      { error: "evidence upload did not return a blob id" },
      { status: 502 },
    );
  }

  // ── Mark row finalized. Optimistic-locked on status='approved' so a
  //    duplicate finalize cannot succeed twice. ──
  try {
    await markFinalized({
      id: submission.id,
      evidenceHashHex,
      evidenceBlobId: attestation.walrusBlobId,
    });
  } catch (e) {
    if (e instanceof KybStoreError) {
      // Most likely the row is already finalized (409). Still return the
      // tx bytes so the merchant can submit if they haven't yet — the
      // chain's nonce-replay guard will reject a real double-submit.
      console.warn(`[/api/kyb/finalize] markFinalized: ${e.message}`);
    } else {
      console.warn(
        `[/api/kyb/finalize] markFinalized failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const response: FinalizeResponseBody = {
    tx_bytes_b64: attestation.txBytesB64,
    sponsor_signature: attestation.sponsorSignature,
    sponsor_address: attestation.sponsorAddress,
    expires_at_ms: attestation.expiresAtMs,
    evidence_hash: evidenceHashHex,
    evidence_blob_id: attestation.walrusBlobId,
  };
  return NextResponse.json(response);
}
