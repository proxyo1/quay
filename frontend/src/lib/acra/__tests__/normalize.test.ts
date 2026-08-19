import { describe, expect, test } from "bun:test";

import { compareEntityNames, normalizeEntityName } from "../normalize";

/**
 * Table-driven, because this function decides every name match and a
 * regression here shows up as legitimate merchants being flagged rather
 * than as a thrown error.
 */
describe("normalizeEntityName", () => {
  const cases: Array<[input: string, expected: string, why: string]> = [
    ["GOOGLE ASIA PACIFIC PTE. LTD.", "GOOGLE ASIA PACIFIC", "strips PTE. LTD."],
    ["GOOGLE ASIA PACIFIC PTE LTD", "GOOGLE ASIA PACIFIC", "unpunctuated form"],
    ["Google Asia Pacific Private Limited", "GOOGLE ASIA PACIFIC", "long legal form"],
    ["AH HOCK F&B ENTERPRISE", "AH HOCK F AND B ENTERPRISE", "& becomes AND"],
    ["AH HOCK F AND B ENTERPRISE", "AH HOCK F AND B ENTERPRISE", "already spelled out"],
    ["THE COFFEE BEAN", "COFFEE BEAN", "leading article dropped"],
    ["  SPACED   OUT   LLP ", "SPACED OUT", "whitespace collapsed, LLP stripped"],
    ["TAN & TAN LLP", "TAN AND TAN", "ampersand plus suffix"],
    ["53250767C HOLDINGS", "53250767C HOLDINGS", "digits preserved"],
    ["ACME LIMITED PARTNERSHIP", "ACME", "multi-word suffix"],
  ];

  for (const [input, expected, why] of cases) {
    test(`${why}: "${input}"`, () => {
      expect(normalizeEntityName(input)).toBe(expected);
    });
  }

  test("strips only ONE trailing legal form", () => {
    // Guards the loop-vs-break choice: looping would eat real words from a
    // name that legitimately ends in something suffix-like.
    expect(normalizeEntityName("LTD SUPPLIES PTE LTD")).toBe("LTD SUPPLIES");
  });

  test("never normalizes a non-empty name to the empty string", () => {
    // The invariant that matters: an empty result would compare equal to
    // every other empty result and match unrelated businesses. Suffix
    // stripping requires a leading space, so a name that is nothing but a
    // legal form cannot be emptied out.
    for (const degenerate of ["LLP", "LTD", "PTE LTD", "PRIVATE LIMITED", "THE"]) {
      expect(normalizeEntityName(degenerate)).not.toBe("");
    }
  });
});

describe("compareEntityNames", () => {
  test("byte-identical is exact", () => {
    expect(compareEntityNames("ACME PTE. LTD.", "ACME PTE. LTD.")).toBe("exact");
  });

  test("punctuation and case differences are a pass", () => {
    expect(compareEntityNames("Acme Pte Ltd", "ACME PTE. LTD.")).toBe("normalized");
  });

  test("ampersand spelling is a pass", () => {
    expect(compareEntityNames("Tan & Tan LLP", "TAN AND TAN LLP")).toBe("normalized");
  });

  test("a genuinely different name is a mismatch", () => {
    expect(compareEntityNames("ACME PTE LTD", "BETA PTE LTD")).toBe("mismatch");
  });

  test("near-misses are mismatches, not passes", () => {
    // Deliberate: the registered name is bound on chain, so a typo must be
    // flagged rather than quietly accepted by fuzzy matching.
    expect(compareEntityNames("AH HOK CHICKEN", "AH HOCK CHICKEN")).toBe("mismatch");
  });

  test("missing input is unknown, never a mismatch", () => {
    expect(compareEntityNames("", "ACME")).toBe("unknown");
    expect(compareEntityNames("ACME", null)).toBe("unknown");
    expect(compareEntityNames(undefined, undefined)).toBe("unknown");
    expect(compareEntityNames("   ", "ACME")).toBe("unknown");
  });
});
