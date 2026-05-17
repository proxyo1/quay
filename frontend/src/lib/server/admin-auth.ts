import "server-only";

import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { jwtVerify, SignJWT } from "jose";

/**
 * Admin auth for /api/admin/* routes.
 *
 * Flow:
 *   1. GET /api/admin/challenge  → { nonce, ts }
 *   2. Client builds the canonical challenge message and asks the wallet
 *      to sign via signPersonalMessage.
 *   3. POST /api/admin/auth { address, signatureB64, nonce, ts }
 *      Server verifies sig, checks ts within window, checks address in
 *      ADMIN_WALLETS, sets an HttpOnly Secure SameSite=Strict cookie
 *      carrying a server-signed JWT (1h TTL).
 *   4. Subsequent /api/admin/* calls run requireAdmin(req) which reads
 *      the cookie and returns { address } or throws.
 *
 * Required env:
 *   ADMIN_WALLETS      — comma-separated Sui addresses (the admin wallet
 *                        must be mnemonic-backed ed25519, NOT zkLogin).
 *   ADMIN_JWT_SECRET   — HS256 signing key (shared with polling-token).
 */

const ALG = "HS256";
const ISSUER = "quay-admin";
const AUDIENCE = "quay-admin-session";
const COOKIE_TTL_SECONDS = 60 * 60; // 1h
const CHALLENGE_WINDOW_MS = 5 * 60 * 1000; // 5 min
const DERIVE_DOMAIN = "QUAY_ADMIN_LOGIN_V1";

export const ADMIN_COOKIE_NAME = "quay_admin";

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

function loadAdminWallets(): Set<string> {
  const raw = process.env.ADMIN_WALLETS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminWallet(address: string): boolean {
  return loadAdminWallets().has(address.trim().toLowerCase());
}

// ────────────────────────── Challenge mint/verify ─────────────────────

export interface AdminChallenge {
  nonce: string; // 32 hex chars (16 random bytes)
  ts: number;    // Date.now()
}

export function createChallenge(): AdminChallenge {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let nonce = "";
  for (let i = 0; i < bytes.length; i++) nonce += bytes[i].toString(16).padStart(2, "0");
  return { nonce, ts: Date.now() };
}

/**
 * Canonical bytes the client signs. Both sides MUST construct this the
 * same way. Don't reformat without bumping DERIVE_DOMAIN.
 */
export function challengeMessage(nonce: string, ts: number): Uint8Array {
  return new TextEncoder().encode(`${DERIVE_DOMAIN}\nnonce=${nonce}\nts=${ts}`);
}

export interface VerifyChallengeArgs {
  address: string;
  signatureB64: string;
  nonce: string;
  ts: number;
}

/**
 * Verify the admin signed the challenge with their wallet. Throws with a
 * specific reason on any failure (caller maps to HTTP status).
 */
export async function verifyChallenge(args: VerifyChallengeArgs): Promise<void> {
  if (!isAdminWallet(args.address)) {
    throw new ChallengeError("address not in ADMIN_WALLETS", 403);
  }
  const drift = Math.abs(Date.now() - args.ts);
  if (!Number.isFinite(args.ts) || drift > CHALLENGE_WINDOW_MS) {
    throw new ChallengeError(`challenge expired or out of window (drift=${drift}ms)`, 401);
  }
  if (!/^[0-9a-f]{32}$/i.test(args.nonce)) {
    throw new ChallengeError("nonce malformed", 400);
  }

  const message = challengeMessage(args.nonce, args.ts);
  try {
    // `verifyPersonalMessageSignature` validates the signature, the
    // address it claims to be from, AND throws on scheme/format issues.
    await verifyPersonalMessageSignature(message, args.signatureB64, {
      address: args.address,
    });
  } catch (e) {
    throw new ChallengeError(
      `signature verification failed: ${e instanceof Error ? e.message : String(e)}`,
      401,
    );
  }
}

export class ChallengeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "ChallengeError";
  }
}

// ───────────────────────── Cookie mint/require ────────────────────────

export interface AdminCookieClaims {
  address: string;
}

export async function mintAdminCookie(address: string): Promise<string> {
  if (!isAdminWallet(address)) {
    throw new Error("refusing to mint cookie for non-admin address");
  }
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(address.toLowerCase())
    .setIssuedAt()
    .setExpirationTime(`${COOKIE_TTL_SECONDS}s`)
    .sign(loadSecret());
}

export interface CookieAttributes {
  name: string;
  value: string;
  httpOnly: true;
  secure: boolean; // false in dev, true in prod
  sameSite: "strict";
  path: "/";
  maxAge: number;
}

export function adminCookieAttributes(value: string): CookieAttributes {
  return {
    name: ADMIN_COOKIE_NAME,
    value,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: COOKIE_TTL_SECONDS,
  };
}

/**
 * Validate the admin cookie from a Next.js Request. Returns the admin
 * address or throws ChallengeError(401/403). Re-checks ADMIN_WALLETS on
 * every request so env updates take effect on the next call.
 */
export async function requireAdmin(req: Request): Promise<AdminCookieClaims> {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookie = parseCookie(cookieHeader, ADMIN_COOKIE_NAME);
  if (!cookie) {
    throw new ChallengeError("no admin cookie", 401);
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(cookie, loadSecret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    }));
  } catch (e) {
    throw new ChallengeError(
      `cookie invalid: ${e instanceof Error ? e.message : String(e)}`,
      401,
    );
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new ChallengeError("cookie missing address (sub claim)", 401);
  }
  if (!isAdminWallet(payload.sub)) {
    // Env may have changed since cookie was issued; treat as revoked.
    throw new ChallengeError("address no longer in ADMIN_WALLETS", 403);
  }
  return { address: payload.sub };
}

function parseCookie(header: string, name: string): string | null {
  for (const pair of header.split(/;\s*/)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() === name) {
      return decodeURIComponent(pair.slice(eq + 1).trim());
    }
  }
  return null;
}
