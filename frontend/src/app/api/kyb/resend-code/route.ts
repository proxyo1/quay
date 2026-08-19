import "server-only";

import { NextResponse } from "next/server";

import { lookupAcraUen } from "@/lib/acra";
import {
  getSubmission,
  resetForResend,
  KybStoreError,
} from "@/lib/server/kyb-store";
import { verifyPollingToken } from "@/lib/server/polling-token";
import { issueVerification, resolvePayoutAddress } from "@/lib/server/verification";

export const runtime = "nodejs";

/**
 * Send a new cent with a new code.
 *
 * Reachable only from `awaiting_code`. A locked-out row (`code_failed`) is
 * deliberately NOT resendable: if it were, the attempt cap would mean
 * nothing, since a guesser could simply resend their way to unlimited tries.
 * Clearing a lockout is an operator action.
 *
 * Issuing a new code invalidates the old one — `startVerification` overwrites
 * the hash — so a merchant who eventually finds the first cent will be told
 * the code is stale rather than being silently let in on a superseded code.
 */
export async function POST(req: Request): Promise<NextResponse> {
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

  let submission;
  try {
    submission = await getSubmission(claims.submissionId);
  } catch (e) {
    if (e instanceof KybStoreError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
  if (!submission) {
    return NextResponse.json({ error: "submission not found" }, { status: 404 });
  }
  if (submission.wallet_address.toLowerCase() !== claims.walletAddress.toLowerCase()) {
    return NextResponse.json(
      { error: "token wallet does not match submission wallet" },
      { status: 403 },
    );
  }
  if (submission.status === "code_failed") {
    return NextResponse.json(
      {
        error:
          "this verification is locked after too many incorrect codes — contact support to reset it",
        code: "locked",
      },
      { status: 409 },
    );
  }

  try {
    await resetForResend(submission.id);
  } catch (e) {
    if (e instanceof KybStoreError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const holderName = submission.business_name ?? submission.uen;
  const acra = await lookupAcraUen(submission.uen);
  const registeredName =
    acra.status === "found" ? acra.record.entityName : submission.business_name;
  const payout = registeredName
    ? await resolvePayoutAddress(submission.uen, registeredName)
    : { address: null, line: null };

  const issued = await issueVerification({
    submissionId: submission.id,
    uen: submission.uen,
    accountHolderName: registeredName ?? holderName,
    address: payout.address,
  });

  if (issued.status !== "issued") {
    return NextResponse.json(
      {
        error:
          issued.status === "conflict"
            ? issued.message
            : `could not reissue: ${issued.reason}`,
      },
      { status: issued.status === "conflict" ? 409 : 502 },
    );
  }

  return NextResponse.json({
    status: "awaiting_code" as const,
    code_reference: issued.reference,
    code_expires_at: issued.expiresAt.toISOString(),
    cent_sent: issued.sent,
  });
}
