import "server-only";

import { NextResponse } from "next/server";

import { createChallenge } from "@/lib/server/admin-auth";

export const runtime = "nodejs";

/**
 * Returns a fresh challenge for the admin to sign with their wallet.
 * Result is `{ nonce, ts }`; the client constructs the canonical
 * challenge message via `challengeMessage(nonce, ts)` (in admin-auth.ts)
 * and signs via `signPersonalMessage`. POSTed back to /api/admin/auth.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(createChallenge());
}
