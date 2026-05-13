import "server-only";

import { bcs } from "@mysten/sui/bcs";
import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { blake2b } from "@noble/hashes/blake2.js";
import { NextResponse } from "next/server";

import { appendAuditRow } from "@/lib/server/issuer-audit-log";
import { loadIssuerKeypair } from "@/lib/server/issuer";
import {
  checkAndIncrementSponsorUsage,
  loadSponsorKeypair,
} from "@/lib/server/sponsor";
import { looksLikeUen } from "@/lib/sgqr";
import { deriveUenHash } from "@/lib/quay";
import { QUAY } from "@/lib/sui-config";
import {
  uploadBlob,
  WalrusRateLimitError,
  WalrusUploadError,
} from "@/lib/walrus/client";

export const runtime = "nodejs";

/**
 * Sponsored merchant registration.
 *
 * Flow:
 *   1. Validate UEN shape + claimer address
 *   2. Rate-limit per claimer (V0: 5/day in-memory)
 *   3. Check sponsor balance (warn / refuse below 20% of target)
 *   4. Issue ed25519 attestation server-side
 *   5. Build register_merchant tx with sender=claimer, gas_owner=sponsor
 *   6. Sign as sponsor + (separately) the client signs as sender
 *
 * We return the unsigned-by-sender tx bytes + the sponsor signature.
 * The client signs the same bytes as the sender, then submits via
 * executeTransactionBlock with both signatures.
 *
 * This makes the new-merchant onboarding flow work from a wallet with
 * 0 SUI — the quay-the-company sponsor pays gas.
 */

const DAILY_CAP = 5;
const LOW_BALANCE_FLOOR_MIST = 40_000_000n; // 20% of 200M target
const CLOCK = "0x6";

const ClaimMessage = bcs.struct("ClaimMessage", {
  domain_tag: bcs.vector(bcs.u8()),
  chain_id: bcs.u8(),
  uen: bcs.vector(bcs.u8()),
  claimer: bcs.bytes(32),
  nonce: bcs.vector(bcs.u8()),
  expires_at_ms: bcs.u64(),
  evidence_hash: bcs.vector(bcs.u8()),
});

const sui = new SuiClient({ network: "testnet", url: getFullnodeUrl("testnet") });

interface SponsorRegisterRequest {
  uen: string;
  claimer: string;
  /** Bare Walrus blob ID for merchant logo (D5). Optional. */
  metadata_blob_id?: string;
  /** Hex-encoded 32-byte blake2b256 of the evidence content (D8). */
  evidence_hash_hex: string;
  /**
   * Raw bytes of the evidence content as a UTF-8 string (typically the
   * canonical JSON snapshot the merchant submitted). The server computes
   * blake2b256 over these bytes and verifies it matches evidence_hash_hex
   * before signing — guarantees the issuer signs over exactly what gets
   * uploaded to Walrus.
   */
  evidence_content?: string;
  ttlSeconds?: number;
}

interface SponsorRegisterResponse {
  tx_bytes_b64: string;
  sponsor_signature: string;
  sponsor_address: string;
  expires_at_ms: number;
  daily_cap: number;
}

function parseAddress(addr: string): Uint8Array | null {
  if (!/^0x[0-9a-fA-F]+$/.test(addr)) return null;
  const hex = addr.slice(2).padStart(64, "0");
  if (hex.length !== 64) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function parseEvidenceHash(s: string | undefined): Uint8Array | null {
  if (!s || !/^[0-9a-fA-F]{64}$/.test(s)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function POST(req: Request) {
  let body: SponsorRegisterRequest;
  try {
    body = (await req.json()) as SponsorRegisterRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.uen || !body.claimer) {
    return NextResponse.json({ error: "uen and claimer required" }, { status: 400 });
  }
  if (!looksLikeUen(body.uen)) {
    return NextResponse.json({ error: `UEN '${body.uen}' invalid` }, { status: 400 });
  }
  const claimerBytes = parseAddress(body.claimer);
  if (!claimerBytes) {
    return NextResponse.json({ error: "invalid claimer address" }, { status: 400 });
  }
  const evidenceHash = parseEvidenceHash(body.evidence_hash_hex);
  if (!evidenceHash) {
    return NextResponse.json(
      { error: "evidence_hash_hex must be a 64-char hex string (32 bytes)" },
      { status: 400 },
    );
  }

  // Phase 4 (D7, D8): if the client supplied evidence content, verify
  // the hash matches the bytes it computed it from, then upload to
  // Walrus and write the audit row. Hard-fail on Walrus error (D7).
  // If no content supplied (legacy clients), skip — the on-chain
  // evidence_hash is still signed-over and verifiable; the blob_id
  // mapping is just absent in the operator audit log.
  let walrusBlobId: string | null = null;
  if (typeof body.evidence_content === "string" && body.evidence_content.length > 0) {
    const contentBytes = new TextEncoder().encode(body.evidence_content);
    const actualHash = blake2b(contentBytes, { dkLen: 32 });
    if (!constantTimeEqual(actualHash, evidenceHash)) {
      return NextResponse.json(
        {
          error:
            "evidence_hash_hex does not match blake2b256 of evidence_content — refusing to sign",
        },
        { status: 400 },
      );
    }
    try {
      const uploaded = await uploadBlob(contentBytes);
      walrusBlobId = uploaded.blobId;
    } catch (e) {
      if (e instanceof WalrusRateLimitError) {
        return NextResponse.json(
          { error: "Walrus rate-limited; retry shortly", upstream: "walrus" },
          { status: 429 },
        );
      }
      if (e instanceof WalrusUploadError) {
        return NextResponse.json(
          {
            error: `evidence upload failed (D7 hard-fail): ${e.message}`,
            upstream: "walrus",
            retryable: e.retryable,
          },
          { status: 502 },
        );
      }
      return NextResponse.json(
        { error: `unexpected: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 },
      );
    }
  }

  // Rate limit — production-only. Dev skips the cap because the counter is
  // in-memory and increments on every request, including ones that later fail
  // signature verification, which makes iterative local testing painful.
  if (process.env.NODE_ENV !== "development") {
    const usageCheck = checkAndIncrementSponsorUsage(body.claimer, DAILY_CAP);
    if (!usageCheck.ok) {
      return NextResponse.json(
        {
          error: "daily sponsored-gas cap reached for this address",
          cap: DAILY_CAP,
          reset_at_ms: usageCheck.resetAt,
        },
        { status: 429 },
      );
    }
  }

  let issuer, sponsor;
  try {
    issuer = loadIssuerKeypair();
    sponsor = loadSponsorKeypair();
  } catch (e) {
    return NextResponse.json(
      { error: `server keys unavailable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  // Sponsor balance pre-flight
  const sponsorAddr = sponsor.toSuiAddress();
  const sponsorBal = await sui.getBalance({ owner: sponsorAddr });
  if (BigInt(sponsorBal.totalBalance) < LOW_BALANCE_FLOOR_MIST) {
    return NextResponse.json(
      {
        error: "sponsor balance below floor — refusing to sign",
        sponsor_balance_mist: sponsorBal.totalBalance,
        floor_mist: LOW_BALANCE_FLOOR_MIST.toString(),
      },
      { status: 503 },
    );
  }

  // 1. Issue attestation
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  const ttl = Math.max(60, Math.min(60 * 60, body.ttlSeconds ?? 30 * 60));
  const expiresAtMs = Date.now() + ttl * 1000;

  const msgBytes = ClaimMessage.serialize({
    domain_tag: Array.from(new TextEncoder().encode("QUAY_CLAIM_V1")),
    chain_id: QUAY.chainId,
    uen: Array.from(new TextEncoder().encode(body.uen)),
    claimer: claimerBytes,
    nonce: Array.from(nonce),
    expires_at_ms: BigInt(expiresAtMs),
    evidence_hash: Array.from(evidenceHash),
  }).toBytes();
  const msgHash = blake2b(msgBytes, { dkLen: 32 });
  const sig = await issuer.sign(msgHash);

  // 2. Build sponsored tx
  const tx = new Transaction();
  tx.setSender(body.claimer);
  tx.setGasOwner(sponsorAddr);
  tx.setGasBudget(20_000_000n);
  tx.moveCall({
    target: `${QUAY.packageId}::payments::register_merchant`,
    arguments: [
      tx.object(QUAY.registryId),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(body.uen))),
      tx.pure.vector("u8", Array.from(nonce)),
      tx.pure.vector("u8", Array.from(sig)),
      tx.pure.u64(BigInt(expiresAtMs)),
      body.metadata_blob_id
        ? tx.pure.option("string", body.metadata_blob_id)
        : tx.pure.option("string", null),
      tx.pure.vector("u8", Array.from(evidenceHash)),
      tx.object(CLOCK),
    ],
  });

  let txBytes: Uint8Array;
  try {
    txBytes = await tx.build({ client: sui });
  } catch (e) {
    return NextResponse.json(
      { error: `tx build failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  // 3. Sponsor signs
  const sponsorSig = await sponsor.signTransaction(txBytes);

  // 4. Phase 4 (D8): append the operator audit row. Non-blocking — a
  // Supabase outage or missing config logs a warning but doesn't fail
  // the attestation. The on-chain evidence_hash is the load-bearing
  // commitment; the audit row is the operator-side blob_id index.
  if (walrusBlobId) {
    const uenHashHex = toHex(deriveUenHash(body.uen));
    await appendAuditRow({
      evidenceHash: body.evidence_hash_hex.toLowerCase(),
      walrusBlobId,
      uenHashHex,
      signedAtMs: Date.now(),
      claimer: body.claimer,
    });
  }

  const response: SponsorRegisterResponse = {
    tx_bytes_b64: Buffer.from(txBytes).toString("base64"),
    sponsor_signature: sponsorSig.signature,
    sponsor_address: sponsorAddr,
    expires_at_ms: expiresAtMs,
    daily_cap: DAILY_CAP,
  };
  return NextResponse.json(response);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
