import "server-only";

import { NextResponse } from "next/server";

import {
  adminCookieAttributes,
  ChallengeError,
  mintAdminCookie,
  verifyChallenge,
} from "@/lib/server/admin-auth";

export const runtime = "nodejs";

interface AuthRequestBody {
  address?: string;
  signatureB64?: string;
  nonce?: string;
  ts?: number;
}

/**
 * Verifies the admin's wallet signature over the challenge and sets the
 * HttpOnly admin cookie on success. The cookie is a server-signed JWT
 * with the admin's address as the subject, 1h TTL.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: AuthRequestBody;
  try {
    body = (await req.json()) as AuthRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!body.address || !body.signatureB64 || !body.nonce || typeof body.ts !== "number") {
    return NextResponse.json(
      { error: "address, signatureB64, nonce, ts all required" },
      { status: 400 },
    );
  }

  try {
    await verifyChallenge({
      address: body.address,
      signatureB64: body.signatureB64,
      nonce: body.nonce,
      ts: body.ts,
    });
  } catch (e) {
    if (e instanceof ChallengeError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: `verification failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  let cookieValue: string;
  try {
    cookieValue = await mintAdminCookie(body.address);
  } catch (e) {
    return NextResponse.json(
      { error: `cookie mint failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  const attrs = adminCookieAttributes(cookieValue);
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: attrs.name,
    value: attrs.value,
    httpOnly: attrs.httpOnly,
    secure: attrs.secure,
    sameSite: attrs.sameSite,
    path: attrs.path,
    maxAge: attrs.maxAge,
  });
  return res;
}
