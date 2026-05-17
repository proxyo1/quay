import "server-only";

import { NextResponse } from "next/server";

import type { KybStatusResponse } from "@/lib/kyb/types";
import { getSubmission, KybStoreError } from "@/lib/server/kyb-store";
import { verifyPollingToken } from "@/lib/server/polling-token";

export const runtime = "nodejs";

/**
 * Polled by the merchant pending page. Auth is via a per-submission
 * polling token (HS256 JWT) returned by /api/kyb/submit — keeps the
 * endpoint stateless and prevents wallet enumeration.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) {
    return NextResponse.json(
      { error: "missing or malformed Authorization: Bearer <token>" },
      { status: 401 },
    );
  }
  const token = m[1];

  let claims;
  try {
    claims = await verifyPollingToken(token);
  } catch (e) {
    return NextResponse.json(
      { error: `polling token invalid: ${e instanceof Error ? e.message : String(e)}` },
      { status: 401 },
    );
  }

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
  // Defense-in-depth: a token must only be usable for its own submission.
  if (submission.wallet_address.toLowerCase() !== claims.walletAddress.toLowerCase()) {
    return NextResponse.json(
      { error: "token wallet does not match submission wallet" },
      { status: 403 },
    );
  }

  const response: KybStatusResponse = {
    status: submission.status,
    rejection_reason: submission.rejection_reason,
    submitted_at: submission.submitted_at,
    decided_at: submission.decided_at,
    finalized_at: submission.finalized_at,
  };
  return NextResponse.json(response);
}
