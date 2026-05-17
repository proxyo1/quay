import "server-only";

import { NextResponse } from "next/server";

import type { KybStatus } from "@/lib/kyb/types";
import { ChallengeError, requireAdmin } from "@/lib/server/admin-auth";
import { KybStoreError, listByStatus } from "@/lib/server/kyb-store";

export const runtime = "nodejs";

const VALID_STATUSES: KybStatus[] = [
  "pending",
  "approved",
  "rejected",
  "finalized",
  "collision",
];

/**
 * Admin-only: lists submissions for a given status (default 'pending').
 * Each row includes ciphertext_blob_id + wrapped_dek so the admin's
 * browser can fetch + decrypt without further server round-trips.
 */
export async function GET(req: Request): Promise<NextResponse> {
  try {
    await requireAdmin(req);
  } catch (e) {
    if (e instanceof ChallengeError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: `auth failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  const url = new URL(req.url);
  const statusParam = (url.searchParams.get("status") ?? "pending") as KybStatus;
  if (!VALID_STATUSES.includes(statusParam)) {
    return NextResponse.json(
      { error: `status must be one of ${VALID_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const items = await listByStatus(statusParam);
    return NextResponse.json({ items });
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
