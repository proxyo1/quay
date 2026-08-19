import { describe, expect, test } from "bun:test";

import type { KybSubmission } from "@/lib/kyb/types";
import {
  buildEvidenceContentV2,
  canonicalizeEvidence,
  evidenceHashHex,
  verifyEvidenceBytes,
  type EvidenceContentV1,
} from "../kyb-evidence";

function submission(overrides: Partial<KybSubmission> = {}): KybSubmission {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    wallet_address: "0xabc",
    uen: "200817984R",
    business_name: "GOOGLE ASIA PACIFIC PTE. LTD.",
    trading_name: null,
    ciphertext_blob_id: null,
    ciphertext_nonce_b64: null,
    wrapped_dek_b64: null,
    original_mime_type: null,
    kyb_doc_hash_hex: null,
    status: "approved",
    rejection_reason: null,
    evidence_hash: null,
    evidence_blob_id: null,
    verification_method: "paynow_microdeposit",
    acra_snapshot: {
      entity_name: "GOOGLE ASIA PACIFIC PTE. LTD.",
      entity_status: "Registered",
      entity_type: "Local Company",
      checked_at_ms: 1_700_000_000_000,
      note: null,
    },
    code_reference: "QUAY-7F3K9M",
    code_sent_at: "2026-08-20T00:00:00.000Z",
    code_expires_at: "2026-08-21T00:00:00.000Z",
    verified_at: "2026-08-20T01:00:00.000Z",
    submitted_at: "2026-08-20T00:00:00.000Z",
    decided_at: "2026-08-20T01:00:00.000Z",
    decided_by: "paynow-microdeposit",
    finalized_at: null,
    ...overrides,
  };
}

const TIMES = { submittedAtMs: 1_755_648_000_000, approvedAtMs: 1_755_651_600_000 };

/**
 * REGRESSION (eng review E7).
 *
 * v1 evidence hashes are committed on chain and cannot be backfilled or
 * recomputed. If the v1 path ever stops producing the same bytes, every
 * merchant registered before the document was dropped becomes unverifiable,
 * permanently and silently. This test pins the exact hash of a known v1
 * object: if it changes, something in the canonicalization path moved.
 */
describe("evidence v1 (frozen — must never change)", () => {
  const v1: EvidenceContentV1 = {
    v: 1,
    uen: "200817984R",
    business_name: "GOOGLE ASIA PACIFIC PTE. LTD.",
    kyb_doc_hash_hex: "a".repeat(64),
    kyb_doc_blob_id: "blob123",
    submitted_at_ms: TIMES.submittedAtMs,
    approved_at_ms: TIMES.approvedAtMs,
    claimer_address: "0xabc",
  };

  test("canonicalizes with keys sorted, exactly as before", () => {
    expect(canonicalizeEvidence(v1)).toBe(
      '{"approved_at_ms":1755651600000,"business_name":"GOOGLE ASIA PACIFIC PTE. LTD.",' +
        '"claimer_address":"0xabc","kyb_doc_blob_id":"blob123",' +
        `"kyb_doc_hash_hex":"${"a".repeat(64)}","submitted_at_ms":1755648000000,` +
        '"uen":"200817984R","v":1}',
    );
  });

  test("hash is stable", () => {
    // Pinned. A change here means already-registered merchants can no longer
    // verify their own evidence.
    expect(evidenceHashHex(v1)).toBe(
      "0321cbe7ee839042de1ca13bbf934da355eb2db26d2e023db164ba6ed0fc7ec8",
    );
  });

  test("a stored v1 blob still verifies against its committed hash", () => {
    const bytes = canonicalizeEvidence(v1);
    expect(verifyEvidenceBytes(bytes, evidenceHashHex(v1))).toBe(true);
  });
});

describe("evidence v2", () => {
  test("carries the verification method and the ACRA snapshot", () => {
    const e = buildEvidenceContentV2(submission(), TIMES);
    expect(e.v).toBe(2);
    expect(e.verification_method).toBe("paynow_microdeposit");
    expect(e.acra).toMatchObject({ entity_status: "Registered" });
  });

  test("carries no document fields", () => {
    const json = canonicalizeEvidence(buildEvidenceContentV2(submission(), TIMES));
    expect(json).not.toContain("kyb_doc_hash_hex");
    expect(json).not.toContain("kyb_doc_blob_id");
  });

  test("is reproducible: same input, same bytes", () => {
    const a = canonicalizeEvidence(buildEvidenceContentV2(submission(), TIMES));
    const b = canonicalizeEvidence(buildEvidenceContentV2(submission(), TIMES));
    expect(a).toBe(b);
  });

  /**
   * The null convention, pinned.
   *
   * JCS treats an absent key and a null value as different bytes. If an
   * optional field were omitted when empty rather than written as null, the
   * hash would depend on which optional data happened to exist — reproducible
   * only by accident.
   */
  test("absent optional fields are null, not missing", () => {
    const json = canonicalizeEvidence(
      buildEvidenceContentV2(
        submission({ trading_name: null, acra_snapshot: null, verified_at: null }),
        TIMES,
      ),
    );
    expect(json).toContain('"trading_name":null');
    expect(json).toContain('"acra":null');
    expect(json).toContain('"verified_at_ms":null');
  });

  test("a present trading name changes the hash", () => {
    const without = evidenceHashHex(buildEvidenceContentV2(submission(), TIMES));
    const withName = evidenceHashHex(
      buildEvidenceContentV2(submission({ trading_name: "Ah Hock Chicken Rice" }), TIMES),
    );
    expect(withName).not.toBe(without);
  });

  test("v1 and v2 of the same claim hash differently", () => {
    // Sanity: the version discriminator is inside the hashed content, so a
    // v2 blob can never be mistaken for the v1 it replaced.
    const v2 = evidenceHashHex(buildEvidenceContentV2(submission(), TIMES));
    expect(v2).not.toBe(
      evidenceHashHex({
        v: 1,
        uen: "200817984R",
        business_name: "GOOGLE ASIA PACIFIC PTE. LTD.",
        kyb_doc_hash_hex: null,
        kyb_doc_blob_id: null,
        submitted_at_ms: TIMES.submittedAtMs,
        approved_at_ms: TIMES.approvedAtMs,
        claimer_address: "0xabc",
      }),
    );
  });
});
