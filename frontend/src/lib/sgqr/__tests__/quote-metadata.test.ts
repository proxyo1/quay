import { describe, test, expect } from "bun:test";

import {
  encodeV2,
  decode,
  detectVersion,
  parseV1QuoteJson,
  V2_DISCRIMINATOR,
} from "../quote-metadata";
import { encodeQuoteMetadata } from "@/lib/quay/pay";

// ─── discriminator collision safety ────────────────────────────────────

describe("discriminator collision check", () => {
  test("v1 payload first byte is 'S' (0x53), not 0x02", () => {
    const v1 = encodeQuoteMetadata({ foo: "bar", price: 1.23 });
    expect(v1[0]).toBe(0x53); // 'S' from "SQR1"
    expect(v1[0]).not.toBe(V2_DISCRIMINATOR);
  });

  test("v2 discriminator is 0x02 — unambiguous vs v1's 'S'", () => {
    expect(V2_DISCRIMINATOR).toBe(0x02);
  });
});

// ─── version detection ────────────────────────────────────────────────

describe("detectVersion", () => {
  test("detects v1 payload by 'S' prefix", () => {
    const v1 = encodeQuoteMetadata({ foo: "bar" });
    expect(detectVersion(v1)).toBe(1);
  });

  test("detects v2 payload by 0x02 prefix", () => {
    const v1 = encodeQuoteMetadata({ foo: "bar" });
    const v2 = encodeV2(v1, "abc-blob");
    expect(detectVersion(v2)).toBe(2);
  });

  test("throws on unknown discriminator", () => {
    expect(() => detectVersion(new Uint8Array([0xff, 0xaa]))).toThrow();
  });

  test("throws on empty payload", () => {
    expect(() => detectVersion(new Uint8Array(0))).toThrow();
  });
});

// ─── v1 regression (CRITICAL per D9) ──────────────────────────────────

describe("v1 regression — existing payments still decode", () => {
  test("decode passes through v1 payload unchanged", () => {
    const v1 = encodeQuoteMetadata({ pyth_feed: "0xabc", price_usd: 1.99 });
    const decoded = decode(v1);
    expect(decoded.version).toBe(1);
    expect(decoded.quoteInputs).toEqual(v1);
    expect(decoded.receiptBlobId).toBeNull();
  });

  test("v1 inner JSON parses correctly", () => {
    const inputs = { pyth_feed: "0xfeed", price_usd: 0.42 };
    const v1 = encodeQuoteMetadata(inputs);
    const decoded = decode(v1);
    const json = parseV1QuoteJson(decoded.quoteInputs);
    expect(json).toEqual(inputs);
  });
});

// ─── v2 round-trip ────────────────────────────────────────────────────

describe("v2 encode/decode round-trip", () => {
  test("with receipt_blob_id", () => {
    const v1 = encodeQuoteMetadata({ foo: 1 });
    const blobId = "walrus-blob-xyz-123";
    const v2 = encodeV2(v1, blobId);

    const decoded = decode(v2);
    expect(decoded.version).toBe(2);
    expect(decoded.quoteInputs).toEqual(v1);
    expect(decoded.receiptBlobId).toBe(blobId);
  });

  test("with null receipt_blob_id", () => {
    const v1 = encodeQuoteMetadata({ foo: 1 });
    const v2 = encodeV2(v1, null);

    const decoded = decode(v2);
    expect(decoded.version).toBe(2);
    expect(decoded.quoteInputs).toEqual(v1);
    expect(decoded.receiptBlobId).toBeNull();
  });

  test("inner v1 still parseable inside v2", () => {
    const inputs = { pyth_feed: "0xdead", price: 99 };
    const v1 = encodeQuoteMetadata(inputs);
    const v2 = encodeV2(v1, "blob-abc");

    const decoded = decode(v2);
    const innerJson = parseV1QuoteJson(decoded.quoteInputs);
    expect(innerJson).toEqual(inputs);
  });

  test("preserves long blob IDs", () => {
    const v1 = encodeQuoteMetadata({});
    const longBlobId = "x".repeat(48);
    const v2 = encodeV2(v1, longBlobId);
    const decoded = decode(v2);
    expect(decoded.receiptBlobId).toBe(longBlobId);
  });
});

// ─── parseV1QuoteJson edge cases ──────────────────────────────────────

describe("parseV1QuoteJson", () => {
  test("returns null for non-v1 prefix", () => {
    expect(parseV1QuoteJson(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
  });

  test("returns null for malformed JSON body", () => {
    const bad = new Uint8Array([0x53, 0x51, 0x52, 0x31, 0x7b, 0x21]); // "SQR1{!"
    expect(parseV1QuoteJson(bad)).toBeNull();
  });

  test("returns null for short input", () => {
    expect(parseV1QuoteJson(new Uint8Array([0x53, 0x51]))).toBeNull();
  });
});
