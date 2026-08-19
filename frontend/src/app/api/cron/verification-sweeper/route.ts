import "server-only";

import { NextResponse } from "next/server";

import { releaseExpiredVerifications } from "@/lib/server/kyb-store";

export const runtime = "nodejs";

/**
 * Releases verifications whose code expired.
 *
 * This is load-bearing, not housekeeping. `awaiting_code` sits inside the
 * `kyb_submissions_one_active_per_uen` unique index, which is what stops two
 * people claiming the same UEN at once. The cost of that correctness is that
 * an abandoned verification holds a real business's UEN hostage: the merchant
 * who actually owns it cannot onboard, and there is no error anywhere — the
 * index simply refuses the second claim.
 *
 * Worse, it is trivially weaponizable. Start a signup for a shop you do not
 * own, walk away, and that shop is locked out. Repeat per shop. Expiry is what
 * makes that attack cost nothing and achieve nothing.
 *
 * Rows go back to `pending` rather than a terminal state, so a merchant who
 * simply took too long can ask for a new code instead of starting over.
 *
 * Idempotent: releasing an already-released row matches nothing.
 */

function authorize(req: Request): { ok: true } | { ok: false; status: number } {
  const expected = process.env.CRON_SECRET;
  // Locally and in preview there is no secret, so the route runs open. Set
  // CRON_SECRET in production to enforce.
  if (!expected) return { ok: true };
  const got = req.headers.get("authorization");
  if (got === `Bearer ${expected}`) return { ok: true };
  return { ok: false, status: 401 };
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: auth.status });
  }

  const checkedAt = new Date().toISOString();
  try {
    const released = await releaseExpiredVerifications();
    if (released.length > 0) {
      // Worth a log line: a spike here means either the cent is not arriving
      // or merchants cannot find it, both of which are product problems
      // rather than infrastructure ones.
      console.warn(
        `[verification-sweeper] released ${released.length} expired verification(s): ${released.join(", ")}`,
      );
    }
    return NextResponse.json({
      ok: true,
      checked_at: checkedAt,
      released: released.length,
      submission_ids: released,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[verification-sweeper] failed: ${message}`);
    return NextResponse.json(
      { ok: false, checked_at: checkedAt, error: message },
      { status: 500 },
    );
  }
}
