import "server-only";

import { jwtVerify, SignJWT } from "jose";

/**
 * Per-submission polling token. Returned by /api/kyb/submit and required
 * on every /api/kyb/status call. Server-signed JWT (HS256) so /api/kyb/status
 * is stateless — no DB lookup just to validate the caller.
 *
 * Binds (submission_id, wallet_address) so a token leaked for one submission
 * cannot poll another, and so polling cannot be used to enumerate wallets.
 *
 * Required env: ADMIN_JWT_SECRET (≥32 random bytes, shared with admin-auth).
 */

const ALG = "HS256";
const ISSUER = "quay-kyb-polling";
const AUDIENCE = "quay-kyb-status";
const TTL_30_DAYS = "30d";

function loadSecret(): Uint8Array {
  const raw = process.env.ADMIN_JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      "ADMIN_JWT_SECRET is missing or too short (need ≥32 chars). " +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return new TextEncoder().encode(raw);
}

export interface PollingTokenClaims {
  submissionId: string;
  walletAddress: string;
}

export async function mintPollingToken(claims: PollingTokenClaims): Promise<string> {
  if (!claims.submissionId) throw new Error("submissionId required");
  if (!claims.walletAddress) throw new Error("walletAddress required");
  return new SignJWT({ addr: claims.walletAddress })
    .setProtectedHeader({ alg: ALG, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.submissionId)
    .setIssuedAt()
    .setExpirationTime(TTL_30_DAYS)
    .sign(loadSecret());
}

/**
 * Verify a polling token and return its claims. Throws on tampered token,
 * expired token, wrong issuer/audience, or missing fields.
 */
export async function verifyPollingToken(token: string): Promise<PollingTokenClaims> {
  const { payload } = await jwtVerify(token, loadSecret(), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("polling token missing submissionId (sub claim)");
  }
  if (typeof payload.addr !== "string" || !payload.addr) {
    throw new Error("polling token missing walletAddress (addr claim)");
  }
  return { submissionId: payload.sub, walletAddress: payload.addr };
}
