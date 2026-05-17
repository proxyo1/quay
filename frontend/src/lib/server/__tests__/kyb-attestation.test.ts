import { describe, expect, it } from "bun:test";

import { blake2b } from "@noble/hashes/blake2.js";

import {
  ClaimMessage,
  constantTimeEqual,
  parseAddress,
  parseEvidenceHash,
} from "../kyb-attestation";

// ────────────────────────────── parseAddress ──────────────────────────

describe("parseAddress", () => {
  it("parses a full-length 0x-prefixed Sui address", () => {
    const addr = "0x" + "ab".repeat(32);
    const bytes = parseAddress(addr);
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(32);
    expect(bytes![0]).toBe(0xab);
  });

  it("left-pads short addresses to 32 bytes", () => {
    const bytes = parseAddress("0x42");
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(32);
    // Left-padded zeros, value in the last byte.
    for (let i = 0; i < 31; i++) expect(bytes![i]).toBe(0);
    expect(bytes![31]).toBe(0x42);
  });

  it("rejects missing 0x prefix", () => {
    expect(parseAddress("abc")).toBeNull();
  });

  it("rejects non-hex characters", () => {
    expect(parseAddress("0xZZ")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(parseAddress("")).toBeNull();
  });
});

// ──────────────────────────── parseEvidenceHash ───────────────────────

describe("parseEvidenceHash", () => {
  it("parses a 64-char lowercase hex string to 32 bytes", () => {
    const hex = "0123456789abcdef".repeat(4);
    const bytes = parseEvidenceHash(hex);
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(32);
    expect(bytes![0]).toBe(0x01);
    expect(bytes![31]).toBe(0xef);
  });

  it("accepts uppercase hex", () => {
    const hex = "ABCDEF".padEnd(64, "0");
    expect(parseEvidenceHash(hex)).not.toBeNull();
  });

  it("rejects short / long / missing input", () => {
    expect(parseEvidenceHash(undefined)).toBeNull();
    expect(parseEvidenceHash("")).toBeNull();
    expect(parseEvidenceHash("ab".repeat(31))).toBeNull(); // 62 chars
    expect(parseEvidenceHash("ab".repeat(33))).toBeNull(); // 66 chars
  });

  it("rejects non-hex characters", () => {
    expect(parseEvidenceHash("zz".repeat(32))).toBeNull();
  });
});

// ──────────────────────────── constantTimeEqual ───────────────────────

describe("constantTimeEqual", () => {
  it("returns true for identical byte arrays", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    expect(constantTimeEqual(a, b)).toBe(true);
  });

  it("returns false for different arrays of same length", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 4]);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it("returns false for different-length arrays", () => {
    expect(
      constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2])),
    ).toBe(false);
  });

  it("handles empty arrays", () => {
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});

// ─────────────────────────── ClaimMessage BCS ─────────────────────────

describe("ClaimMessage BCS serialization", () => {
  it("is deterministic for identical inputs", () => {
    const fields = {
      domain_tag: Array.from(new TextEncoder().encode("QUAY_CLAIM_V1")),
      chain_id: 0,
      uen: Array.from(new TextEncoder().encode("12345678X")),
      claimer: new Uint8Array(32).fill(0x42),
      nonce: Array.from(new Uint8Array(32).fill(0x77)),
      expires_at_ms: BigInt(1_700_000_000_000),
      evidence_hash: Array.from(new Uint8Array(32).fill(0xab)),
    };
    const a = ClaimMessage.serialize(fields).toBytes();
    const b = ClaimMessage.serialize(fields).toBytes();
    expect(a).toEqual(b);
  });

  it("differs when any field changes", () => {
    const base = {
      domain_tag: Array.from(new TextEncoder().encode("QUAY_CLAIM_V1")),
      chain_id: 0,
      uen: Array.from(new TextEncoder().encode("12345678X")),
      claimer: new Uint8Array(32).fill(0x42),
      nonce: Array.from(new Uint8Array(32).fill(0x77)),
      expires_at_ms: BigInt(1_700_000_000_000),
      evidence_hash: Array.from(new Uint8Array(32).fill(0xab)),
    };
    const baseBytes = ClaimMessage.serialize(base).toBytes();

    const differentEvidence = {
      ...base,
      evidence_hash: Array.from(new Uint8Array(32).fill(0xac)),
    };
    expect(
      ClaimMessage.serialize(differentEvidence).toBytes(),
    ).not.toEqual(baseBytes);

    const differentNonce = {
      ...base,
      nonce: Array.from(new Uint8Array(32).fill(0x78)),
    };
    expect(ClaimMessage.serialize(differentNonce).toBytes()).not.toEqual(
      baseBytes,
    );

    const differentUen = {
      ...base,
      uen: Array.from(new TextEncoder().encode("87654321Y")),
    };
    expect(ClaimMessage.serialize(differentUen).toBytes()).not.toEqual(
      baseBytes,
    );
  });

  it("hash of serialized bytes is deterministic and 32 bytes", () => {
    const fields = {
      domain_tag: Array.from(new TextEncoder().encode("QUAY_CLAIM_V1")),
      chain_id: 0,
      uen: Array.from(new TextEncoder().encode("12345678X")),
      claimer: new Uint8Array(32).fill(0x42),
      nonce: Array.from(new Uint8Array(32).fill(0x77)),
      expires_at_ms: BigInt(1_700_000_000_000),
      evidence_hash: Array.from(new Uint8Array(32).fill(0xab)),
    };
    const bytes = ClaimMessage.serialize(fields).toBytes();
    const h1 = blake2b(bytes, { dkLen: 32 });
    const h2 = blake2b(bytes, { dkLen: 32 });
    expect(h1.length).toBe(32);
    expect(h1).toEqual(h2);
  });
});
