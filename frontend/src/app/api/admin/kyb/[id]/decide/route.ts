import "server-only";

import { NextResponse } from "next/server";

import type { KybDecision } from "@/lib/kyb/types";
import { ChallengeError, requireAdmin } from "@/lib/server/admin-auth";
import { KybStoreError, updateDecision } from "@/lib/server/kyb-store";

export const runtime = "nodejs";

interface DecideRequestBody {
  decision?: KybDecision;
  reason?: string;
}

/**
 * Admin-only: approves or rejects a pending submission. Optimistic-locked
 * on status='pending' inside `updateDecision`, so a double-click or
 * concurrent tab returns 409 rather than corrupting state.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  let admin;
  try {
    admin = await requireAdmin(req);
  } catch (e) {
    if (e instanceof ChallengeError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: `auth failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing submission id" }, { status: 400 });
  }

  let body: DecideRequestBody;
  try {
    body = (await req.json()) as DecideRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (body.decision !== "approved" && body.decision !== "rejected") {
    return NextResponse.json(
      { error: "decision must be 'approved' or 'rejected'" },
      { status: 400 },
    );
  }
  if (body.decision === "rejected" && !body.reason?.trim()) {
    return NextResponse.json(
      { error: "rejection requires a non-empty 'reason' field" },
      { status: 400 },
    );
  }

  try {
    const row = await updateDecision({
      id,
      decision: body.decision,
      rejectionReason: body.reason,
      adminAddress: admin.address,
    });
    return NextResponse.json({
      id: row.id,
      status: row.status,
      decided_at: row.decided_at,
      decided_by: row.decided_by,
      rejection_reason: row.rejection_reason,
    });
  } catch (e) {
    if (e instanceof KybStoreError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: `db error: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
}
