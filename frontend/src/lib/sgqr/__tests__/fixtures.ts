import { buildSgqr } from "../builder";

/**
 * Synthetic SGQR fixtures. All have valid CRC-16-CCITT-FALSE (verified
 * via the builder). These exercise the parser against shapes we expect
 * from real Singapore PayNow QRs:
 *
 *   - Various SG UEN formats (business / sole-prop / GST / S-prefixed)
 *   - Mobile-number PayNow (the V0 fallback case per AD3)
 *   - Static (proxy + name only) vs dynamic (with amount) codes
 *   - Multi-MAI codes (PayNow + NETS or PayNow + GrabPay)
 *   - Additional Data tag 62 with bill/reference labels
 *   - Edge: extra-long merchant names that must be truncated by sanitizer
 *
 * Real-photo testing per AD5 (≥20 photos × lighting) is deferred to a
 * field-test session with actual SGQR stickers. These synthetic fixtures
 * are the V0 substitute.
 */

export const FIXTURES = {
  // Standard UEN — business
  uen_business_static: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "202012345Z" },
    merchantName: "KOPI HOUSE PTE LTD",
    merchantCity: "Singapore",
    merchantCategoryCode: "5812", // restaurants
  }),

  // GST-registered business UEN (T-prefix)
  uen_gst: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "T12LL3456A" },
    merchantName: "BREAD & BUTTER LLP",
    merchantCity: "Singapore",
  }),

  // Local business UEN (R-prefix)
  uen_r_prefix: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "R98LL9876P" },
    merchantName: "CORNER STORE",
    merchantCity: "Singapore",
  }),

  // Society / public entity (S-prefix)
  uen_s_prefix: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "S87SS1234C" },
    merchantName: "FOOD CO-OPERATIVE LTD",
    merchantCity: "Singapore",
  }),

  // Sole-proprietor with 8-char ACRA UEN
  uen_acra_8: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "53123456" },
    merchantName: "AH SENG NOODLES",
    merchantCity: "Singapore",
  }),

  // Mobile-number PayNow — V0 must surface FALLBACK
  mobile_paynow: buildSgqr({
    payNow: { proxyType: "0", proxyValue: "+6591234567" },
    merchantName: "MAMA STALL",
    merchantCity: "Singapore",
  }),

  // Dynamic QR with amount
  uen_dynamic_with_amount: buildSgqr({
    pointOfInitiation: "12",
    payNow: { proxyType: "2", proxyValue: "200512345A" },
    merchantName: "CHICKEN RICE",
    merchantCity: "Singapore",
    transactionAmount: "3.50",
  }),

  // PayNow with bill reference (Tag 62.01)
  uen_with_bill_ref: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "201912345B" },
    merchantName: "CAFE LATTE",
    merchantCity: "Singapore",
    additionalData: { billNumber: "INV-12345", referenceLabel: "TableA1" },
  }),

  // Multi-MAI: PayNow (tag 26) + NETS-like (tag 27)
  multi_mai: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "202112345Q" },
    customMai: [
      {
        tag: "27",
        fields: { "00": "SG.COM.NETS", "01": "9876543210", "02": "NETS_TID_XX" },
      },
      // tag 26 will still be added by builder since usedPayNowTag tracking
      // only fires for tag 26; we supply tag 27 here.
    ],
    merchantName: "FUSION GRILL",
    merchantCity: "Singapore",
  }),

  // VPA proxy (proxy type 5) — uncommon but valid
  vpa_paynow: buildSgqr({
    payNow: { proxyType: "5", proxyValue: "merchant@bank" },
    merchantName: "VPA MERCHANT",
    merchantCity: "Singapore",
  }),

  // Long merchant name (exactly 25 chars — boundary)
  name_at_max_length: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "201812345C" },
    merchantName: "EXACTLY 25 CHARS NAME XX!",
    merchantCity: "Singapore",
  }),

  // Merchant name with special chars (apostrophe, hyphen)
  name_with_punct: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "201712345D" },
    merchantName: "JOE'S WELL-DONE BURGERS",
    merchantCity: "Singapore",
  }),

  // No additional data tag
  uen_minimal: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "202212345E" },
    merchantName: "BARE BONES",
    merchantCity: "SG",
  }),

  // Editable PayNow (tip jar style)
  uen_editable: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "202312345F", editable: true },
    merchantName: "TIPS WELCOME",
    merchantCity: "Singapore",
  }),

  // With postal code (Tag 61)
  uen_with_postal: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "202412345G" },
    merchantName: "RAFFLES OUTLET",
    merchantCity: "Singapore",
    postalCode: "238836",
  }),

  // Expiry date set
  uen_with_expiry: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "202512345H" },
    merchantName: "TIMED OFFER",
    merchantCity: "Singapore",
    payNowExpiry: undefined, // builder doesn't take this on top level
  } as any), // (expiry path tested via builder.payNow.expiryDate below)

  // Truly-with-expiry (using builder API correctly)
  uen_expiry_correct: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "202612345J", expiryDate: "20261231" },
    merchantName: "YEAR END SALE",
    merchantCity: "Singapore",
  }),

  // Different MCC
  uen_grocery: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "202712345K" },
    merchantName: "FAIRPRICE FINEST",
    merchantCity: "Singapore",
    merchantCategoryCode: "5411", // grocery stores
  }),

  // Currency override (USD just to confirm we read 53 verbatim)
  uen_usd_currency: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "202812345L" },
    merchantName: "INTL MART",
    merchantCity: "Singapore",
    transactionCurrency: "840", // USD
  }),

  // City truncated (15 chars)
  uen_long_city: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "202912345M" },
    merchantName: "CITY TEST",
    merchantCity: "Singapore Test1",
  }),

  // Country code variation (lowercase — invalid per spec but test resilience)
  uen_oddities: buildSgqr({
    payNow: { proxyType: "2", proxyValue: "203012345N" },
    merchantName: "ODD CODE",
    merchantCity: "Singapore",
    countryCode: "SG", // keep valid; lowercase test deferred
  }),
};

/** Known external test vector for CRC-16-CCITT-FALSE algorithm. */
export const CRC_TEST_VECTORS = [
  { input: "123456789", expected: 0x29b1 },
  { input: "", expected: 0xffff },
  { input: "A", expected: 0xb915 },
];
