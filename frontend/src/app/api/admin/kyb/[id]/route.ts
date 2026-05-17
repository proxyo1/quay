import "server-only";

import { NextResponse } from "next/server";

import type { KybAdminListItem } from "@/lib/kyb/types";
import { ChallengeError, requireAdmin } from "@/lib/server/admin-auth";
import { getSubmission, KybStoreError } from "@/lib/server/kyb-store";

export const runtime = "nodejs";

/**
 * Admin-only: returns a single submission with the ciphertext blob id +
 * wrapped DEK so the reviewer's browser can fetch and decrypt.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
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

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing submission id" }, { status: 400 });
  }

  let submission;
  try {
    submission = await getSubmission(id);
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

  const item: KybAdminListItem = {
    id: submission.id,
    wallet_address: submission.wallet_address,
    uen: submission.uen,
    business_name: submission.business_name,
    ciphertext_blob_id: submission.ciphertext_blob_id,
    ciphertext_nonce_b64: submission.ciphertext_nonce_b64,
    wrapped_dek_b64: submission.wrapped_dek_b64,
    original_mime_type: submission.original_mime_type,
    kyb_doc_hash_hex: submission.kyb_doc_hash_hex,
    status: submission.status,
    rejection_reason: submission.rejection_reason,
    submitted_at: submission.submitted_at,
    decided_at: submission.decided_at,
    decided_by: submission.decided_by,
  };
  return NextResponse.json(item);
}
