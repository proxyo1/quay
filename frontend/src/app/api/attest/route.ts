import "server-only";

import { bcs } from "@mysten/sui/bcs";
import { blake2b } from "@noble/hashes/blake2.js";
import { NextResponse } from "next/server";

import { loadIssuerKeypair } from "@/lib/server/issuer";
import { SUIQR } from "@/lib/sui-config";
import { looksLikeUen } from "@/lib/sgqr";

export const runtime = "nodejs";

/**
 * Attestation issuance.
 *
 * V0 demo: auto-issues an attestation for any well-shaped UEN + Sui
 * address. The hackathon README is honest about this — production
 * gates issuance behind an SGQR-photo + BizFile+ review by suiqr
 * staff (or replaces this entirely with a NETS-controlled key once
 * MAS / NETS sign off).
 *
 * The signed message is BCS(ClaimMessage) → blake2b256 → ed25519 sign,
 * exactly the shape Move reconstructs in register_merchant.
 *
 * Rate limiting / abuse prevention is out of scope for V0 — only the
 * suiqr-the-company instance can run this route because it requires
 * access to the issuer secret key.
 */

const ClaimMessage = bcs.struct("ClaimMessage", {
  domain_tag: bcs.vector(bcs.u8()),
  chain_id: bcs.u8(),
  uen: bcs.vector(bcs.u8()),
  claimer: bcs.bytes(32),
  nonce: bcs.vector(bcs.u8()),
  expires_at_ms: bcs.u64(),
});

interface AttestRequest {
  uen: string;
  claimer: string;
  ttlSeconds?: number;
}

interface AttestResponse {
  attestation_hex: string;
  nonce_hex: string;
  expires_at_ms: number;
  issuer_pubkey_hex: string;
  chain_id: number;
  msg_hash_hex: string;
}

const DEFAULT_TTL_SECONDS = 30 * 60; // 30 minutes
const MAX_TTL_SECONDS = 24 * 60 * 60; // 24 hours

function parseAddress(addr: string): Uint8Array | null {
  if (!/^0x[0-9a-fA-F]+$/.test(addr)) return null;
  const hex = addr.slice(2).padStart(64, "0");
  if (hex.length !== 64) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function POST(req: Request) {
  let body: AttestRequest;
  try {
    body = (await req.json()) as AttestRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body.uen !== "string" || typeof body.claimer !== "string") {
    return NextResponse.json({ error: "uen and claimer required" }, { status: 400 });
  }
  if (!looksLikeUen(body.uen)) {
    return NextResponse.json(
      { error: `UEN '${body.uen}' does not look like a Singapore UEN (8-10 alphanumeric)` },
      { status: 400 },
    );
  }
  const claimerBytes = parseAddress(body.claimer);
  if (!claimerBytes) {
    return NextResponse.json({ error: `invalid claimer address '${body.claimer}'` }, { status: 400 });
  }
  const ttl = Math.max(60, Math.min(MAX_TTL_SECONDS, body.ttlSeconds ?? DEFAULT_TTL_SECONDS));

  let issuer;
  try {
    issuer = loadIssuerKeypair();
  } catch (e) {
    return NextResponse.json(
      { error: `issuer key unavailable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  const expiresAtMs = Date.now() + ttl * 1000;

  const msgBytes = ClaimMessage.serialize({
    domain_tag: Array.from(new TextEncoder().encode("SUIQR_CLAIM_V1")),
    chain_id: SUIQR.chainId,
    uen: Array.from(new TextEncoder().encode(body.uen)),
    claimer: claimerBytes,
    nonce: Array.from(nonce),
    expires_at_ms: BigInt(expiresAtMs),
  }).toBytes();
  const msgHash = blake2b(msgBytes, { dkLen: 32 });
  const sig = await issuer.sign(msgHash);

  const response: AttestResponse = {
    attestation_hex: Buffer.from(sig).toString("hex"),
    nonce_hex: Buffer.from(nonce).toString("hex"),
    expires_at_ms: expiresAtMs,
    issuer_pubkey_hex: Buffer.from(issuer.getPublicKey().toRawBytes()).toString("hex"),
    chain_id: SUIQR.chainId,
    msg_hash_hex: Buffer.from(msgHash).toString("hex"),
  };
  return NextResponse.json(response);
}
