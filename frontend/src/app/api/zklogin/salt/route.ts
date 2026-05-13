import "server-only";

import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Server-derived zkLogin salt.
 *
 * For each (iss, sub) tuple, we deterministically derive a salt as:
 *     salt = HMAC-SHA256(SERVER_SECRET, iss || ":" || sub).slice(0, 16)
 * interpreted as an unsigned little-endian bigint → decimal string.
 *
 * Same Google identity → same salt → same Sui address. Different secret
 * (e.g., mainnet vs testnet) gives a different per-environment address
 * space. The secret is required so anyone with the JWT cannot re-derive
 * the salt (and thus the user's address) off-chain.
 *
 * V0 trust note: we do NOT verify the JWT signature against Google's JWKS
 * here. A malicious caller could forge a JWT and get a salt for any (iss,
 * sub). Salt alone is not the address — the actual address comes from
 * `jwtToAddress(jwt, salt)` and the JWT must be Google-signed for the ZK
 * prover to issue a proof against it. So forging a JWT to this endpoint
 * only leaks a salt; the attacker still can't produce a valid zkLogin
 * signature without Google signing for them.
 */

const SERVER_SALT_SECRET =
  process.env.QUAY_ZKLOGIN_SALT_SECRET ??
  "quay-zklogin-testnet-v1-replace-in-mainnet";

const SALT_BYTES = 16; // 128-bit salt — within zkLogin's accepted range

interface SaltRequest {
  jwt: string;
}

interface SaltResponse {
  salt: string;
}

function decodeJwtPayload(jwt: string): { iss?: string; sub?: string; aud?: string | string[] } {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function bytesToDecimalString(bytes: Buffer): string {
  // Little-endian interpretation, returned as decimal-string bigint
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    n = (n << 8n) | BigInt(bytes[i]);
  }
  return n.toString(10);
}

export async function POST(req: Request) {
  let body: SaltRequest;
  try {
    body = (await req.json()) as SaltRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.jwt || typeof body.jwt !== "string") {
    return NextResponse.json({ error: "jwt required" }, { status: 400 });
  }
  let claims;
  try {
    claims = decodeJwtPayload(body.jwt);
  } catch {
    return NextResponse.json({ error: "could not decode JWT payload" }, { status: 400 });
  }
  if (!claims.iss || !claims.sub) {
    return NextResponse.json({ error: "JWT missing iss/sub" }, { status: 400 });
  }
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    return NextResponse.json(
      { error: `unexpected JWT issuer '${claims.iss}'` },
      { status: 400 },
    );
  }

  const mac = createHmac("sha256", SERVER_SALT_SECRET)
    .update(`${claims.iss}:${claims.sub}`)
    .digest()
    .subarray(0, SALT_BYTES);
  const salt = bytesToDecimalString(Buffer.from(mac));

  const response: SaltResponse = { salt };
  return NextResponse.json(response);
}
