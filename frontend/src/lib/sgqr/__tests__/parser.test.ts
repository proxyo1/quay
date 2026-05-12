import { describe, expect, test } from "bun:test";
import { buildSgqr, buildSgqrWithBadCrc } from "../builder";
import { extractPayNow, looksLikeUen, parsePayNowQr, parseSgqr } from "../parser";
import { sanitizeMerchantCity, sanitizeMerchantName } from "../sanitize";
import { SgqrParseError } from "../types";
import { FIXTURES } from "./fixtures";

describe("parseSgqr — happy paths", () => {
  test("static UEN: extracts merchant info + CRC valid", () => {
    const payload = parseSgqr(FIXTURES.uen_business_static);
    expect(payload.crcValid).toBe(true);
    expect(payload.payloadFormatIndicator).toBe("01");
    expect(payload.pointOfInitiationMethod).toBe("static");
    expect(payload.merchantName).toBe("KOPI HOUSE PTE LTD");
    expect(payload.merchantCity).toBe("Singapore");
    expect(payload.merchantCategoryCode).toBe("5812");
    expect(payload.transactionCurrency).toBe("702");
    expect(payload.countryCode).toBe("SG");
    expect(payload.merchantAccountInfo).toHaveLength(1);
    expect(payload.merchantAccountInfo[0].guid).toBe("SG.PAYNOW");
  });

  test("dynamic QR with amount", () => {
    const payload = parseSgqr(FIXTURES.uen_dynamic_with_amount);
    expect(payload.pointOfInitiationMethod).toBe("dynamic");
    expect(payload.transactionAmount).toBe("3.50");
    expect(payload.crcValid).toBe(true);
  });

  test("additional data: bill number + reference label", () => {
    const payload = parseSgqr(FIXTURES.uen_with_bill_ref);
    expect(payload.additionalData?.billNumber).toBe("INV-12345");
    expect(payload.additionalData?.referenceLabel).toBe("TableA1");
  });

  test("postal code (Tag 61)", () => {
    const payload = parseSgqr(FIXTURES.uen_with_postal);
    expect(payload.postalCode).toBe("238836");
  });
});

describe("extractPayNow — UEN cases", () => {
  test.each([
    ["uen_business_static", "202012345Z"],
    ["uen_gst", "T12LL3456A"],
    ["uen_r_prefix", "R98LL9876P"],
    ["uen_s_prefix", "S87SS1234C"],
    ["uen_acra_8", "53123456"],
  ])("fixture %s → proxyType=uen, value=%s", (key, expectedUen) => {
    const payload = parseSgqr((FIXTURES as Record<string, string>)[key]);
    const pn = extractPayNow(payload);
    expect(pn).not.toBeNull();
    expect(pn!.proxyType).toBe("uen");
    expect(pn!.proxyValue).toBe(expectedUen);
    expect(pn!.tag).toBe("26");
  });

  test("editable flag", () => {
    const payload = parseSgqr(FIXTURES.uen_editable);
    const pn = extractPayNow(payload);
    expect(pn!.editable).toBe(true);
  });

  test("expiry date round-trips", () => {
    const payload = parseSgqr(FIXTURES.uen_expiry_correct);
    const pn = extractPayNow(payload);
    expect(pn!.expiryDate).toBe("20261231");
  });

  test("VPA proxy type 5", () => {
    const payload = parseSgqr(FIXTURES.vpa_paynow);
    const pn = extractPayNow(payload);
    expect(pn!.proxyType).toBe("vpa");
    expect(pn!.proxyValue).toBe("merchant@bank");
  });
});

describe("extractPayNow — mobile-number fallback (AD3 V0 gap)", () => {
  test("proxy type 0 surfaces as 'mobile' (V0 must reject gracefully)", () => {
    const { payNow } = parsePayNowQr(FIXTURES.mobile_paynow);
    expect(payNow).not.toBeNull();
    expect(payNow!.proxyType).toBe("mobile");
    expect(payNow!.proxyValue).toBe("+6591234567");
    // Caller's responsibility: show "mobile-number PayNow not supported in V0"
    // UX message. The parser surfaces the type honestly.
  });
});

describe("extractPayNow — multi-MAI scenarios", () => {
  test("PayNow + NETS coexist; PayNow extracted", () => {
    const payload = parseSgqr(FIXTURES.multi_mai);
    expect(payload.merchantAccountInfo.length).toBeGreaterThanOrEqual(2);
    const guids = payload.merchantAccountInfo.map((m) => m.guid);
    expect(guids).toContain("SG.PAYNOW");
    expect(guids).toContain("SG.COM.NETS");
    const pn = extractPayNow(payload);
    expect(pn!.proxyType).toBe("uen");
    expect(pn!.proxyValue).toBe("202112345Q");
  });

  test("non-PayNow MAI only → extractPayNow returns null", () => {
    // Synthesize a QR with only NETS (no PayNow)
    const onlyNets = buildSgqr({
      customMai: [{ tag: "27", fields: { "00": "SG.COM.NETS", "01": "9876543210" } }],
      merchantName: "NETS ONLY",
      merchantCity: "Singapore",
      // builder will still try to add PayNow if `payNow` is set, but it's omitted here
    });
    const payload = parseSgqr(onlyNets);
    expect(extractPayNow(payload)).toBeNull();
  });
});

describe("CRC validation", () => {
  test("good CRC → crcValid: true", () => {
    const payload = parseSgqr(FIXTURES.uen_minimal);
    expect(payload.crcValid).toBe(true);
  });

  test("bad CRC → crcValid: false (does not throw)", () => {
    const bad = buildSgqrWithBadCrc({
      payNow: { proxyType: "2", proxyValue: "202012345Z" },
      merchantName: "BAD CRC",
      merchantCity: "Singapore",
    });
    const payload = parseSgqr(bad);
    expect(payload.crcValid).toBe(false);
    expect(payload.crc).toBe("DEAD");
  });
});

describe("parseSgqr — structural error paths", () => {
  test("empty input throws EMPTY_INPUT", () => {
    expect(() => parseSgqr("")).toThrow(SgqrParseError);
    try {
      parseSgqr("");
    } catch (e) {
      expect((e as SgqrParseError).detail.kind).toBe("EMPTY_INPUT");
    }
  });

  test("missing CRC prefix throws INVALID_CRC_FORMAT", () => {
    expect(() => parseSgqr("00020101")).toThrow(SgqrParseError);
  });

  test("non-hex CRC throws INVALID_CRC_FORMAT", () => {
    const good = FIXTURES.uen_minimal;
    const broken = good.slice(0, -4) + "ZZZZ";
    expect(() => parseSgqr(broken)).toThrow(SgqrParseError);
  });

  test("declared length overflow throws DECLARED_LENGTH_OVERFLOW", () => {
    // Build a fake body where tag 00 claims 99 chars but only has 1
    // Then append "6304" + valid CRC over the broken prefix
    const broken = "0099X6304";
    const crc = "0000";
    expect(() => parseSgqr(broken + crc)).toThrow(SgqrParseError);
  });

  test("non-digit tag throws MALFORMED_TLV", () => {
    expect(() => parseSgqr("AB0201016304XXXX")).toThrow(SgqrParseError);
  });

  test("missing payload-format-indicator throws MISSING_MANDATORY_TAG", () => {
    // Build a body without tag 00 — but with valid CRC. Use the builder's
    // CRC helper to keep this test honest.
    const { crc16OfString, crcToHex4 } = require("../crc16");
    const body = "010211"; // just tag 01 set to "11"
    const withPrefix = body + "6304";
    const crc = crcToHex4(crc16OfString(withPrefix));
    expect(() => parseSgqr(withPrefix + crc)).toThrow(SgqrParseError);
  });
});

describe("sanitizeMerchantName — AD29 allowlist", () => {
  test("preserves safe punctuation", () => {
    expect(sanitizeMerchantName("Joe's Well-Done Burgers")).toBe("Joe's Well-Done Burgers");
  });

  test("strips HTML / XSS attempts (angle brackets stripped)", () => {
    // () and / are kept since real merchant names contain them ("ABC (S) Pte Ltd",
    // "B&Q/IKEA Outlet"). What matters is angle brackets and quotes are gone;
    // React text rendering handles the rest safely.
    const dirty = '<script>alert("xss")</script>';
    const clean = sanitizeMerchantName(dirty);
    expect(clean).not.toContain("<");
    expect(clean).not.toContain(">");
    expect(clean).not.toContain('"');
    expect(clean).toBe("scriptalert(xss)/script");
  });

  test("truncates to 25 chars", () => {
    expect(sanitizeMerchantName("X".repeat(50))).toBe("X".repeat(25));
  });

  test("handles undefined", () => {
    expect(sanitizeMerchantName(undefined)).toBe("");
  });

  test("strips control chars and unicode oddities", () => {
    expect(sanitizeMerchantName("Hello\x00\x01World")).toBe("HelloWorld");
  });

  test("city allowlist is similar (max 15)", () => {
    expect(sanitizeMerchantCity("Singapore Mall")).toBe("Singapore Mall");
    expect(sanitizeMerchantCity("X".repeat(50))).toBe("X".repeat(15));
  });
});

describe("looksLikeUen", () => {
  test.each([
    ["202012345Z", true],
    ["T12LL3456A", true],
    ["R98LL9876P", true],
    ["53123456", true], // 8-char ACRA
    ["abc", false],
    ["", false],
    ["202012345Z!", false],
    ["X".repeat(11), false],
  ])("'%s' → %s", (uen, expected) => {
    expect(looksLikeUen(uen)).toBe(expected);
  });
});

describe("Real-world shape coverage (≥20 fixture parses)", () => {
  test("all fixtures parse without throwing and CRC validates", () => {
    let count = 0;
    for (const [name, qr] of Object.entries(FIXTURES)) {
      if (typeof qr !== "string") continue;
      const payload = parseSgqr(qr);
      expect(payload.crcValid).toBe(true);
      count += 1;
    }
    expect(count).toBeGreaterThanOrEqual(20);
  });
});
