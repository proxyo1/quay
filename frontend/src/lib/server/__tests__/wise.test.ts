import { describe, expect, test } from "bun:test";

import { digestToCustomerTxId } from "../wise";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The base58 Sui digest from the live 422 — must map to a valid UUID.
const REAL_DIGEST = "2S9H2skBA4V2d1r9TXSvbeEbXiu9EcFeFHKxJQ8uEwUU";

describe("digestToCustomerTxId", () => {
  test("produces a valid v4-shaped UUID (Wise requires a UUID)", () => {
    expect(digestToCustomerTxId(REAL_DIGEST)).toMatch(UUID_RE);
  });

  test("is deterministic — same digest -> same id (idempotent re-drive)", () => {
    expect(digestToCustomerTxId(REAL_DIGEST)).toBe(digestToCustomerTxId(REAL_DIGEST));
  });

  test("different digests -> different ids", () => {
    expect(digestToCustomerTxId("AAAA")).not.toBe(digestToCustomerTxId("BBBB"));
  });

  test("the raw base58 digest is NOT itself a UUID (the bug we fixed)", () => {
    expect(REAL_DIGEST).not.toMatch(UUID_RE);
  });
});
