import "server-only";

import { NextResponse } from "next/server";

import { getSubmission, KybStoreError } from "@/lib/server/kyb-store";
import { verifyPollingToken } from "@/lib/server/polling-token";
import { verifyCode } from "@/lib/server/verification";

export const runtime = "nodejs";

/**
 * The merchant types back the code from their bank statement.
 *
 * This is the whole ownership proof. Passing means they can see deposits
 * into the account the UEN's PayNow proxy pays into, which is the same
 * account the SGQR sticker on their shop pays into.
 *
 * Auth is the polling token, not a session. That is deliberate: verification
 * requires leaving the app for a banking app, and on a phone that round trip
 * can evict the tab and strand the zkLogin key in localStorage. The token
 * lives in an HttpOnly-ish client store tied to the submission, so a merchant
 * returning cold in a fresh tab can still finish. Losing the session must not
 * cost them the work.
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

  let body: { code?: string };
  try {
    body = (await req.json()) as { code?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.code !== "string" || !body.code.trim()) {
    return NextResponse.json({ error: "code is required" }, { status: 400 });
  }
  // Cheap guard against someone posting a megabyte. Normalization in
  // codes.ts strips everything outside the alphabet anyway.
  if (body.code.length > 64) {
    return NextResponse.json({ error: "code too long" }, { status: 400 });
  }

  const outcome = await verifyCode(claims.submissionId, body.code);

  switch (outcome.status) {
    case "verified": {
      // Re-read so the client learns the new status without a second call.
      let submission = null;
      try {
        submission = await getSubmission(claims.submissionId);
      } catch (e) {
        if (!(e instanceof KybStoreError)) throw e;
      }
      return NextResponse.json({
        status: "verified",
        submission_status: submission?.status ?? "approved",
      });
    }
    case "wrong":
      return NextResponse.json(
        { status: "wrong", remaining: outcome.remaining },
        { status: 400 },
      );
    case "locked":
      return NextResponse.json(
        {
          status: "locked",
          error: "too many incorrect codes",
        },
        { status: 429 },
      );
    case "unavailable":
      // Fails closed on purpose: this counter is the only thing between a
      // guesser and someone else's UEN, so an outage must not become an
      // unlimited-attempts window. See lib/server/verification/attempts.ts.
      return NextResponse.json(
        {
          status: "unavailable",
          error: "verification is temporarily unavailable, please try again shortly",
        },
        { status: 503 },
      );
    case "no_pending_code":
      return NextResponse.json(
        {
          status: "no_pending_code",
          error: "that code has expired or was already used — request a new one",
        },
        { status: 409 },
      );
  }
}
