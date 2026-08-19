import "server-only";

import canonicalize from "canonicalize";
import { blake2b } from "@noble/hashes/blake2.js";

import type { KybSubmission } from "@/lib/kyb/types";

/**
 * `evidence_content`: the facts an approval rested on, canonicalized and
 * hashed into the 32 bytes committed on chain as `MerchantEntry.evidence_hash`.
 *
 * JCS (RFC 8785) gives byte-identical output across producers, so anyone with
 * the Walrus blob can recompute the hash and check it against the chain.
 *
 * ## Versioning
 *
 * v1 committed to the KYB document (its hash and blob id). Onboarding stopped
 * collecting a document once proof of PayNow account control replaced review,
 * so v2 commits to that instead, plus the ACRA snapshot taken at claim time.
 *
 * **v1 must keep verifying forever.** Those hashes are on chain and cannot be
 * backfilled or recomputed; breaking the v1 path would make every merchant
 * registered before this change unverifiable. Readers switch on `v`.
 *
 * ## The null convention
 *
 * Every key is always present, null when unknown. JCS treats an absent key and
 * a null value as different bytes, so leaving fields out conditionally would
 * make the hash depend on which optional data happened to exist — reproducible
 * only by accident.
 */

/** Shape committed before the document was dropped. Read-only now. */
export interface EvidenceContentV1 {
  v: 1;
  uen: string;
  business_name: string;
  kyb_doc_hash_hex: string | null;
  kyb_doc_blob_id: string | null;
  submitted_at_ms: number;
  approved_at_ms: number;
  claimer_address: string;
}

export interface EvidenceContentV2 {
  v: 2;
  uen: string;
  /** ACRA-registered entity name. The identity bound on chain. */
  business_name: string;
  /** Signboard name shown to payers. Null when the merchant gave none. */
  trading_name: string | null;
  verification_method: string | null;
  verified_at_ms: number | null;
  acra: unknown;
  submitted_at_ms: number;
  approved_at_ms: number;
  claimer_address: string;
}

export type EvidenceContent = EvidenceContentV1 | EvidenceContentV2;

export function buildEvidenceContentV2(
  submission: KybSubmission,
  opts: { submittedAtMs: number; approvedAtMs: number },
): EvidenceContentV2 {
  return {
    v: 2,
    uen: submission.uen,
    business_name: submission.business_name ?? "",
    trading_name: submission.trading_name,
    verification_method: submission.verification_method,
    verified_at_ms: submission.verified_at ? Date.parse(submission.verified_at) : null,
    acra: submission.acra_snapshot,
    submitted_at_ms: opts.submittedAtMs,
    approved_at_ms: opts.approvedAtMs,
    claimer_address: submission.wallet_address,
  };
}

export class EvidenceCanonicalizationError extends Error {}

/** JCS bytes for an evidence object of any version. */
export function canonicalizeEvidence(evidence: EvidenceContent): string {
  const canonical = canonicalize(evidence);
  if (!canonical) {
    throw new EvidenceCanonicalizationError(
      "canonicalize() returned null — evidence_content contains a non-serializable value",
    );
  }
  return canonical;
}

/** The 32 bytes committed on chain, hex-encoded. */
export function evidenceHashHex(evidence: EvidenceContent): string {
  const bytes = new TextEncoder().encode(canonicalizeEvidence(evidence));
  return Buffer.from(blake2b(bytes, { dkLen: 32 })).toString("hex");
}

/**
 * Verify a stored blob against its on-chain hash, at ANY version.
 *
 * Deliberately takes the raw string rather than a parsed object: the hash
 * commits to bytes, and re-serializing a parsed object could differ from what
 * was actually hashed if the producer's canonicalization ever drifted.
 */
export function verifyEvidenceBytes(
  canonicalJson: string,
  expectedHashHex: string,
): boolean {
  const bytes = new TextEncoder().encode(canonicalJson);
  const actual = Buffer.from(blake2b(bytes, { dkLen: 32 })).toString("hex");
  return actual.toLowerCase() === expectedHashHex.toLowerCase();
}
