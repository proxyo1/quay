import { describe, expect, test } from "bun:test";

import {
  MAX_REFERENCE_LENGTH,
  codeMatches,
  formatReference,
  generateCode,
  hashCode,
  normalizeCodeInput,
} from "../codes";

describe("generateCode", () => {
  test("is six characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toHaveLength(6);
      // No I, L, O, U, 0 or 1: the merchant reads this off a phone screen and
      // retypes it, so no character pair may be confusable.
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/);
    }
  });

  test("does not repeat itself in a small sample", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateCode()));
    // 30^6 is ~729M, so 200 draws colliding would mean the generator is broken
    // rather than unlucky.
    expect(seen.size).toBeGreaterThan(190);
  });
});

describe("formatReference", () => {
  test("fits the narrowest PayNow reference limit we know of", () => {
    // wise.ts slices at 35, but the inbound customer reference the merchant
    // actually reads is documented at 25 and banks may truncate further.
    // 11 clears both. See docs/wise-paynow-probe.md.
    expect(MAX_REFERENCE_LENGTH).toBeLessThanOrEqual(25);
    expect(formatReference(generateCode())).toHaveLength(MAX_REFERENCE_LENGTH);
  });
});

describe("normalizeCodeInput", () => {
  const cases: Array<[input: string, expected: string, why: string]> = [
    ["QUAY-7F3K9M", "7F3K9M", "the full reference as pasted from a bank app"],
    ["quay-7f3k9m", "7F3K9M", "lowercased"],
    ["7F3K9M", "7F3K9M", "just the code"],
    ["  7F3K9M  ", "7F3K9M", "surrounding whitespace"],
    ["7F3 K9M", "7F3K9M", "space in the middle"],
    ["QUAY 7F3K9M", "7F3K9M", "prefix separated by a space"],
    ["PayNow QUAY-7F3K9M ref", "7F3K9M", "a whole statement line pasted in"],
    ["INWARD PAYNOW quay 7F3K9M 0.01SGD", "7F3K9M", "bank narrative around the code"],
  ];

  for (const [input, expected, why] of cases) {
    test(`${why}: "${input}"`, () => {
      expect(normalizeCodeInput(input)).toBe(expected);
    });
  }
});

describe("codeMatches", () => {
  test("accepts the right code", () => {
    const code = generateCode();
    expect(codeMatches(code, hashCode(code))).toBe(true);
  });

  test("accepts the code with the prefix and wrong case", () => {
    const code = generateCode();
    expect(codeMatches(formatReference(code).toLowerCase(), hashCode(code))).toBe(true);
  });

  test("rejects a wrong code", () => {
    expect(codeMatches("ABCDEF", hashCode("GHJKMN"))).toBe(false);
  });

  test("rejects a code that differs only in the last character", () => {
    // Guards the constant-time comparison: comparing hashes rather than the
    // codes themselves means a near-miss is no closer than a wild guess.
    expect(codeMatches("ABCDE2", hashCode("ABCDE3"))).toBe(false);
  });

  test("rejects a malformed expected hash rather than throwing", () => {
    // timingSafeEqual throws on length mismatch, which would turn a corrupt
    // row into a 500 instead of a failed verification.
    expect(codeMatches("ABCDEF", new Uint8Array(16))).toBe(false);
    expect(codeMatches("ABCDEF", new Uint8Array(0))).toBe(false);
  });

  test("rejects empty input", () => {
    expect(codeMatches("", hashCode("ABCDEF"))).toBe(false);
  });
});

describe("hashCode", () => {
  test("is 32 bytes and deterministic", () => {
    const a = hashCode("ABCDEF");
    const b = hashCode("ABCDEF");
    expect(a).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test("differs for different codes", () => {
    expect(Buffer.from(hashCode("ABCDEF")).equals(Buffer.from(hashCode("ABCDEG")))).toBe(
      false,
    );
  });
});
