import "server-only";

import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import { blake2b } from "@noble/hashes/blake2.js";

import { deriveUenHash } from "@/lib/quay";
import { QUAY } from "@/lib/sui-config";
import {
  uploadBlob,
  WalrusRateLimitError,
  WalrusUploadError,
} from "@/lib/walrus/client";

import { loadIssuerKeypair } from "./issuer";
import { appendAuditRow } from "./issuer-audit-log";
import {
  checkAndIncrementSponsorUsage,
  loadSponsorKeypair,
} from "./sponsor";
import { getSuiClient } from "@/lib/sui-client";

/**
 * Extracted attestation + sponsored-tx builder. Originally lived inside
 * /api/sponsor/register; pulled out so /api/kyb/finalize can call it after
 * the admin approves a submission.
 *
 * Side effects per call (in order):
 *   1. Optionally upload `evidenceContent` bytes to Walrus.
 *   2. Bump the sponsor's daily-cap counter (skippable via flag).
 *   3. Sign a ClaimMessage with the issuer key.
 *   4. Build a sponsored Move call to `register_merchant`.
 *   5. Sign the tx bytes as the sponsor.
 *   6. Best-effort: append a row to issuer_audit_log (Walrus blob_id ↔ evidence_hash).
 *
 * Returns the tx bytes + sponsor signature; the caller is responsible for
 * having the claimer sign the same bytes and submitting both signatures
 * via executeTransactionBlock.
 */

// ────────────────────────────── Constants ─────────────────────────────

const DAILY_CAP = 5;
const LOW_BALANCE_FLOOR_MIST = 40_000_000n; // 20% of 200M target
const CLOCK = "0x6";

/** Canonical ClaimMessage shape — kept in lock-step with the Move struct. */
export const ClaimMessage = bcs.struct("ClaimMessage", {
  domain_tag: bcs.vector(bcs.u8()),
  chain_id: bcs.u8(),
  uen: bcs.vector(bcs.u8()),
  claimer: bcs.bytes(32),
  nonce: bcs.vector(bcs.u8()),
  expires_at_ms: bcs.u64(),
  evidence_hash: bcs.vector(bcs.u8()),
});

const sui = getSuiClient();

// ─────────────────────────────── Errors ───────────────────────────────

export class AttestationError extends Error {
  status: number;
  retryable: boolean;
  upstream?: "walrus";
  constructor(
    message: string,
    status: number,
    opts: { retryable?: boolean; upstream?: "walrus" } = {},
  ) {
    super(message);
    this.name = "AttestationError";
    this.status = status;
    this.retryable = opts.retryable ?? false;
    this.upstream = opts.upstream;
  }
}

// ────────────────────────────── Public API ────────────────────────────

export interface AttestationInput {
  /** Singapore UEN (validated upstream). */
  uen: string;
  /** Claimer Sui address (0x-prefixed hex). */
  claimer: string;
  /** Hex-encoded 32-byte blake2b256 of the evidence content. */
  evidenceHashHex: string;
  /** Optional metadata blob ID (merchant logo) — Walrus blob. */
  metadataBlobId?: string;
  /**
   * Optional raw bytes of evidence_content as a UTF-8 string. If present,
   * the server verifies blake2b256(bytes) == evidenceHashHex before signing
   * and uploads the bytes to Walrus.
   */
  evidenceContent?: string;
  /** Attestation TTL. Clamped to [60s, 1h]. Default 30 min. */
  ttlSeconds?: number;
  /**
   * Skip the sponsor daily-cap check. Use only for paths where the cap was
   * already accounted for at submission time. Defaults to false.
   */
  skipRateLimit?: boolean;
}

export interface AttestationResult {
  txBytesB64: string;
  sponsorSignature: string;
  sponsorAddress: string;
  expiresAtMs: number;
  dailyCap: number;
  walrusBlobId: string | null;
}

export async function signAndBuildRegisterTx(
  input: AttestationInput,
): Promise<AttestationResult> {
  const claimerBytes = parseAddress(input.claimer);
  if (!claimerBytes) {
    throw new AttestationError("invalid claimer address", 400);
  }
  const evidenceHash = parseEvidenceHash(input.evidenceHashHex);
  if (!evidenceHash) {
    throw new AttestationError(
      "evidence_hash_hex must be a 64-char hex string (32 bytes)",
      400,
    );
  }

  // 1. Optional evidence upload + hash-binding check.
  let walrusBlobId: string | null = null;
  if (typeof input.evidenceContent === "string" && input.evidenceContent.length > 0) {
    const contentBytes = new TextEncoder().encode(input.evidenceContent);
    const actualHash = blake2b(contentBytes, { dkLen: 32 });
    if (!constantTimeEqual(actualHash, evidenceHash)) {
      throw new AttestationError(
        "evidence_hash_hex does not match blake2b256 of evidence_content — refusing to sign",
        400,
      );
    }
    try {
      const uploaded = await uploadBlob(contentBytes);
      walrusBlobId = uploaded.blobId;
    } catch (e) {
      if (e instanceof WalrusRateLimitError) {
        throw new AttestationError("Walrus rate-limited; retry shortly", 429, {
          upstream: "walrus",
          retryable: true,
        });
      }
      if (e instanceof WalrusUploadError) {
        throw new AttestationError(
          `evidence upload failed: ${e.message}`,
          502,
          { upstream: "walrus", retryable: e.retryable },
        );
      }
      throw e;
    }
  }

  // 2. Sponsor daily cap.
  if (!input.skipRateLimit && process.env.NODE_ENV !== "development") {
    const usage = checkAndIncrementSponsorUsage(input.claimer, DAILY_CAP);
    if (!usage.ok) {
      throw new AttestationError(
        `daily sponsored-gas cap reached for this address (cap=${DAILY_CAP}, reset_at_ms=${usage.resetAt})`,
        429,
      );
    }
  }

  // 3. Issuer + sponsor keypairs.
  let issuer, sponsor;
  try {
    issuer = loadIssuerKeypair();
    sponsor = loadSponsorKeypair();
  } catch (e) {
    throw new AttestationError(
      `server keys unavailable: ${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }

  // 4. Sponsor balance preflight.
  const sponsorAddr = sponsor.toSuiAddress();
  const sponsorBal = await sui.getBalance({ owner: sponsorAddr });
  if (BigInt(sponsorBal.balance.balance) < LOW_BALANCE_FLOOR_MIST) {
    throw new AttestationError(
      `sponsor balance below floor — refusing to sign (balance=${sponsorBal.balance.balance}, floor=${LOW_BALANCE_FLOOR_MIST})`,
      503,
    );
  }

  // 5. Mint nonce + attestation.
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  const ttl = Math.max(60, Math.min(60 * 60, input.ttlSeconds ?? 30 * 60));
  const expiresAtMs = Date.now() + ttl * 1000;

  const msgBytes = ClaimMessage.serialize({
    domain_tag: Array.from(new TextEncoder().encode("QUAY_CLAIM_V1")),
    chain_id: QUAY.chainId,
    uen: Array.from(new TextEncoder().encode(input.uen)),
    claimer: claimerBytes,
    nonce: Array.from(nonce),
    expires_at_ms: BigInt(expiresAtMs),
    evidence_hash: Array.from(evidenceHash),
  }).toBytes();
  const msgHash = blake2b(msgBytes, { dkLen: 32 });
  const sig = await issuer.sign(msgHash);

  // 6. Build sponsored tx.
  const tx = new Transaction();
  tx.setSender(input.claimer);
  tx.setGasOwner(sponsorAddr);
  tx.setGasBudget(20_000_000n);
  tx.moveCall({
    target: `${QUAY.packageId}::payments::register_merchant`,
    arguments: [
      tx.object(QUAY.registryId),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(input.uen))),
      tx.pure.vector("u8", Array.from(nonce)),
      tx.pure.vector("u8", Array.from(sig)),
      tx.pure.u64(BigInt(expiresAtMs)),
      input.metadataBlobId
        ? tx.pure.option("string", input.metadataBlobId)
        : tx.pure.option("string", null),
      tx.pure.vector("u8", Array.from(evidenceHash)),
      tx.object(CLOCK),
    ],
  });

  let txBytes: Uint8Array;
  try {
    txBytes = await tx.build({ client: sui });
  } catch (e) {
    throw new AttestationError(
      `tx build failed: ${e instanceof Error ? e.message : String(e)}`,
      500,
    );
  }

  // 7. Sponsor signs the bytes (the claimer will co-sign on the client).
  const sponsorSig = await sponsor.signTransaction(txBytes);

  // 8. Best-effort audit log row.
  if (walrusBlobId) {
    const uenHashHex = toHex(deriveUenHash(input.uen));
    await appendAuditRow({
      evidenceHash: input.evidenceHashHex.toLowerCase(),
      walrusBlobId,
      uenHashHex,
      signedAtMs: Date.now(),
      claimer: input.claimer,
    });
  }

  return {
    txBytesB64: Buffer.from(txBytes).toString("base64"),
    sponsorSignature: sponsorSig.signature,
    sponsorAddress: sponsorAddr,
    expiresAtMs,
    dailyCap: DAILY_CAP,
    walrusBlobId,
  };
}

// ─────────────────────────────── Helpers ──────────────────────────────

export function parseAddress(addr: string): Uint8Array | null {
  if (!/^0x[0-9a-fA-F]+$/.test(addr)) return null;
  const hex = addr.slice(2).padStart(64, "0");
  if (hex.length !== 64) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function parseEvidenceHash(s: string | undefined): Uint8Array | null {
  if (!s || !/^[0-9a-fA-F]{64}$/.test(s)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
