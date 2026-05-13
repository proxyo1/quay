import { describe, test, expect } from "bun:test";

import {
  buildReceipt,
  stringifyReceipt,
  receiptToBytes,
  RECEIPT_SCHEMA_VERSION,
  type BuildReceiptInputs,
} from "../builder";

const validInput: BuildReceiptInputs = {
  receiptIdHex: "a".repeat(64),
  payer: "0xa1a2",
  merchant: "0x1a2b",
  uenRaw: "53123456A",
  amount: 1_000_000n,
  tokenType: "0x2::sui::SUI",
  sgdMinorUnits: 150,
  timestampMs: 1_700_000_000_000,
};

// ─── construction ─────────────────────────────────────────────────────

describe("buildReceipt", () => {
  test("happy path produces v1 receipt", () => {
    const r = buildReceipt(validInput);
    expect(r.schema_version).toBe(RECEIPT_SCHEMA_VERSION);
    expect(r.amount).toBe("1000000");
    expect(r.token_type).toBe("0x2::sui::SUI");
    expect(r.sgd_minor_units).toBe(150);
    expect(r.uen_raw).toBe("53123456A");
  });

  test("lowercases hex receipt_id", () => {
    const r = buildReceipt({ ...validInput, receiptIdHex: "F".repeat(64) });
    expect(r.receipt_id).toBe("f".repeat(64));
  });

  test("omits quote and memo when not provided", () => {
    const r = buildReceipt(validInput);
    expect(r.quote).toBeUndefined();
    expect(r.memo).toBeUndefined();
  });

  test("includes quote and memo when provided", () => {
    const r = buildReceipt({
      ...validInput,
      quote: { feed: "0xfeed", price_usd: "1.99" },
      memo: "thanks",
    });
    expect(r.quote?.feed).toBe("0xfeed");
    expect(r.memo).toBe("thanks");
  });

  test("rejects bad hex receipt_id", () => {
    expect(() => buildReceipt({ ...validInput, receiptIdHex: "notenough" })).toThrow();
  });

  test("rejects non-0x-prefixed payer", () => {
    expect(() => buildReceipt({ ...validInput, payer: "abc" })).toThrow();
  });

  test("rejects zero amount", () => {
    expect(() => buildReceipt({ ...validInput, amount: 0n })).toThrow();
  });

  test("rejects empty uen_raw", () => {
    expect(() => buildReceipt({ ...validInput, uenRaw: "" })).toThrow();
  });

  test("rejects zero/negative timestamp", () => {
    expect(() => buildReceipt({ ...validInput, timestampMs: 0 })).toThrow();
  });
});

// ─── determinism (D20 schema integrity) ────────────────────────────────

describe("stringifyReceipt — determinism", () => {
  test("same input → same bytes", () => {
    const a = receiptToBytes(buildReceipt(validInput));
    const b = receiptToBytes(buildReceipt({ ...validInput })); // fresh object
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
  });

  test("field-insertion order doesn't change output", () => {
    // Both build the same Receipt but via objects constructed in different orders.
    const r1 = buildReceipt(validInput);
    const r2 = buildReceipt({
      timestampMs: validInput.timestampMs,
      sgdMinorUnits: validInput.sgdMinorUnits,
      tokenType: validInput.tokenType,
      amount: validInput.amount,
      uenRaw: validInput.uenRaw,
      merchant: validInput.merchant,
      payer: validInput.payer,
      receiptIdHex: validInput.receiptIdHex,
    });
    expect(stringifyReceipt(r1)).toBe(stringifyReceipt(r2));
  });

  test("keys are sorted alphabetically at top level", () => {
    const s = stringifyReceipt(buildReceipt(validInput));
    // Check that 'amount' appears before 'merchant' (alphabetical, not insertion).
    expect(s.indexOf('"amount"')).toBeLessThan(s.indexOf('"merchant"'));
    // Check that 'schema_version' appears before 'sgd_minor_units' (lex order).
    expect(s.indexOf('"schema_version"')).toBeLessThan(s.indexOf('"sgd_minor_units"'));
  });

  test("nested quote object also has sorted keys", () => {
    const r = buildReceipt({
      ...validInput,
      quote: { sgd_per_usd: "1.38", feed: "0xfeed", price_usd: "1.99" },
    });
    const s = stringifyReceipt(r);
    expect(s.indexOf('"feed"')).toBeLessThan(s.indexOf('"price_usd"'));
    expect(s.indexOf('"price_usd"')).toBeLessThan(s.indexOf('"sgd_per_usd"'));
  });
});

// ─── memo handling ────────────────────────────────────────────────────

describe("memo edge cases", () => {
  test("empty memo string is omitted", () => {
    const r = buildReceipt({ ...validInput, memo: "" });
    expect(r.memo).toBeUndefined();
  });

  test("unicode memo round-trips through bytes", () => {
    const r = buildReceipt({ ...validInput, memo: "ก๋วยเตี๋ยว 🍜" });
    const bytes = receiptToBytes(r);
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    expect(decoded.memo).toBe("ก๋วยเตี๋ยว 🍜");
  });
});
