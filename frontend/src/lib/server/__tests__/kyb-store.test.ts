import { describe, expect, it } from "bun:test";

import {
  b64ToHexLiteral,
  byteaToBase64,
  byteaToHex,
  hexToHexLiteral,
} from "../kyb-store";

// We unit-test the bytea ↔ JS plumbing here. The Supabase-touching
// methods (insertSubmission/updateDecision/markFinalized/listByStatus)
// are exercised end-to-end via the manual testnet verification flow
// per the project's "lib-only unit tests, manual API verification"
// convention.

describe("b64ToHexLiteral", () => {
  it("converts base64 to a Postgres bytea hex literal", () => {
    const b64 = Buffer.from(new Uint8Array([0x00, 0x7f, 0xff, 0xab, 0xcd])).toString(
      "base64",
    );
    expect(b64ToHexLiteral(b64)).toBe("\\x007fffabcd");
  });

  it("roundtrips through byteaToBase64", () => {
    const b64 = Buffer.from(new Uint8Array([1, 2, 3, 250, 255])).toString("base64");
    const literal = b64ToHexLiteral(b64);
    expect(byteaToBase64(literal)).toBe(b64);
  });
});

describe("hexToHexLiteral", () => {
  it("prepends \\x and lowercases", () => {
    expect(hexToHexLiteral("AABBCC")).toBe("\\xaabbcc");
    expect(hexToHexLiteral("abcd")).toBe("\\xabcd");
  });

  it("roundtrips through byteaToHex", () => {
    const hex = "deadbeef";
    expect(byteaToHex(hexToHexLiteral(hex))).toBe(hex);
  });
});

describe("byteaToBase64 / byteaToHex", () => {
  it("strips the \\x prefix and decodes", () => {
    expect(byteaToBase64("\\x0102")).toBe(Buffer.from([0x01, 0x02]).toString("base64"));
    expect(byteaToHex("\\xABCDEF")).toBe("abcdef");
  });

  it("passes through inputs that lack the \\x prefix (defensive)", () => {
    expect(byteaToBase64("alreadyBase64")).toBe("alreadyBase64");
    expect(byteaToHex("alreadyhex")).toBe("alreadyhex");
  });
});
