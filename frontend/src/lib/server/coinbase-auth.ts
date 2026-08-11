import "server-only";

import { jwtVerify, SignJWT } from "jose";

import { listOwnedMerchantEntries } from "@/lib/quay/lookup";
import { getSuiClient } from "@/lib/sui-client";
import { QUAY } from "@/lib/sui-config";

/**
 * Authorisation for the Coinbase cash-out routes.
 *
 * `/api/cashout/*` and `/api/sponsor/*` have no authentication at all —
 * `owner` is client-supplied and regex-validated only. That hole is
 * pre-existing and out of scope here, but the new routes must not reproduce
 * it, because they mint Coinbase session tokens and quotes against a merchant
 * identity.
 *
 * **What this is not.** The obvious design — have the merchant sign a nonce
 * with their zkLogin key — does not work, twice over:
 *
 *  1. `zkLoginSign` cannot sign an arbitrary nonce. It wraps
 *     `ephemeral.signTransaction(txBytes)`, which is a TransactionData-intent
 *     signature. A personal-message zkLogin signer is net-new client code, and
 *     verifying one needs a fullnode-backed zkLogin path — the existing
 *     `verifyPersonalMessageSignature` call in admin-auth.ts passes no client,
 *     which works for ed25519 admin wallets and not for a Groth16 zkLogin
 *     signature.
 *  2. Even if it worked, proving control of a zkLogin address is not an abuse
 *     control. Any Google account yields one, so an attacker can mint
 *     addresses freely and pass the check every time.
 *
 * **What it is.** The meaningful gate is on-chain registry membership: does
 * this address actually own a registered UEN in `MerchantRegistry`? That is
 * scarce (it requires passing KYB and an issuer attestation), it is exactly
 * the population allowed to cash out, and it cannot be forged. Paired with a
 * per-address rate limit, it closes the session-token endpoint.
 *
 * The registry read is not free, so a successful check mints a short-lived
 * token that the polling and prepare calls present instead of re-reading the
 * chain on every request. The token is Quay's own, and distinct from the CDP
 * session token — that one is single-use with a ~5 minute expiry and will
 * always be stale for a merchant returning after any real absence, which is
 * why the flow re-mints it rather than trying to keep one alive.
 */

const ALG = "HS256";
const ISSUER = "quay-coinbase-offramp";
const AUDIENCE = "quay-offramp-session";

/**
 * Token lifetime. Longer than a Coinbase order deadline so a merchant who
 * comes back mid-flow is not bounced, short enough that a leaked token is not
 * a standing key.
 */
const TTL_SECONDS = 60 * 60; // 1 hour

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

export class OfframpAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OfframpAuthError";
    this.status = status;
  }
}

export interface OfframpTokenClaims {
  /** Merchant's Sui address. */
  owner: string;
  /** A UEN the address owns, for display and for the row. */
  uen: string;
}

export async function mintOfframpToken(claims: OfframpTokenClaims): Promise<string> {
  if (!claims.owner) throw new Error("owner required");
  return new SignJWT({ uen: claims.uen })
    .setProtectedHeader({ alg: ALG, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.owner)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(loadSecret());
}

/** Verify a Quay offramp token. Throws on tampering, expiry, or wrong scope. */
export async function verifyOfframpToken(token: string): Promise<OfframpTokenClaims> {
  const { payload } = await jwtVerify(token, loadSecret(), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new OfframpAuthError("token missing owner (sub claim)", 401);
  }
  if (typeof payload.uen !== "string") {
    throw new OfframpAuthError("token missing uen claim", 401);
  }
  return { owner: payload.sub, uen: payload.uen };
}

/**
 * The primary gate: is this address a registered merchant?
 *
 * Reads `MerchantRegistry` directly rather than replaying
 * `MerchantRegistered` events — Sui's GraphQL retains only a recent window of
 * event history, so an event-based check would reject long-standing merchants
 * whose registration has aged out.
 *
 * Returns the merchant's UENs. An empty list means "not a merchant" and the
 * caller should 403.
 */
export async function registeredUensFor(owner: string): Promise<string[]> {
  const rows = await listOwnedMerchantEntries(
    getSuiClient(),
    QUAY.registryId,
    QUAY.packageId,
    owner,
  );
  return rows.map((r) => r.uen);
}

/** Shape of a Sui address, checked before it reaches any lookup. */
export function looksLikeSuiAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Authorise a request, from either a bearer token or a fresh registry check.
 *
 * `Authorization: Bearer <token>` is the fast path. Without one, `owner` must
 * be supplied and is verified against the registry, which is the expensive
 * path — so callers that will make several requests should mint a token once
 * and present it thereafter.
 */
export async function authorizeOfframpRequest(input: {
  authorizationHeader: string | null;
  /** Fallback when no token is presented. */
  owner?: unknown;
}): Promise<OfframpTokenClaims> {
  const header = input.authorizationHeader ?? "";
  if (header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    try {
      return await verifyOfframpToken(token);
    } catch (e) {
      if (e instanceof OfframpAuthError) throw e;
      throw new OfframpAuthError("invalid or expired offramp token", 401);
    }
  }

  if (!looksLikeSuiAddress(input.owner)) {
    throw new OfframpAuthError(
      "owner must be a full 0x + 64 hex Sui address, or present a bearer token",
      400,
    );
  }

  const uens = await registeredUensFor(input.owner);
  if (uens.length === 0) {
    // Not "unauthenticated" — the address is simply not a merchant. Cashing
    // out is a merchant action, so this is the real authorisation boundary.
    throw new OfframpAuthError("address is not a registered merchant", 403);
  }
  return { owner: input.owner, uen: uens[0] };
}

/**
 * Coinbase's per-*merchant* handle. Stable, opaque, and under the 50-character
 * limit — a Sui address is 66, so it cannot be used directly.
 *
 * Deliberately per-merchant rather than per-order: it is Coinbase's user
 * identifier, and the transaction-list endpoint is keyed by it. One open order
 * at a time is enforced by the store's in-flight lock instead.
 */
export function partnerUserRefFor(owner: string): string {
  // 0x + 40 hex = 42 chars, comfortably under the limit, and collision-free
  // for Sui addresses in practice since it keeps 160 bits.
  return `q${owner.replace(/^0x/, "").slice(0, 40)}`;
}
