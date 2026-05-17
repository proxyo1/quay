import "server-only";

import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Returns the X25519 public key the admin's wallet derives. Used by:
 *   - merchant client: to wrap the per-doc DEK at submit time
 *   - admin client: to detect pubkey-mismatch (wrong wallet connected)
 *     before attempting decrypt
 *
 * Intentionally unauthenticated — it IS a public key. Anyone with the
 * pubkey alone cannot decrypt any wrapped DEK.
 */
export async function GET(): Promise<NextResponse> {
  const pubkeyHex = process.env.ADMIN_KYB_PUBKEY?.trim() ?? "";
  if (!pubkeyHex) {
    return NextResponse.json(
      { error: "ADMIN_KYB_PUBKEY not configured on the server" },
      { status: 500 },
    );
  }
  return NextResponse.json({ pubkey_hex: pubkeyHex });
}
