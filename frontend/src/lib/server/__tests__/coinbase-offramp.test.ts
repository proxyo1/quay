import { describe, expect, test } from "bun:test";

import {
  buildOfframpUrl,
  decimalToMinor,
  isAwaitingCommit,
  mapTransactionStatus,
  parseDeadlineMs,
} from "../coinbase-offramp";

describe("mapTransactionStatus", () => {
  test("STARTED is a live value the published enum omits", () => {
    // Observed on a real mainnet order that held this status while the USDC was
    // already delivered. It used to fall through to `unknown`, which both
    // reconcilers ignore, stranding the row in `sent` forever.
    expect(mapTransactionStatus("TRANSACTION_STATUS_STARTED")).toBe("created");
  });

  test("maps every documented TRANSACTION_STATUS_* value", () => {
    expect(mapTransactionStatus("TRANSACTION_STATUS_CREATED")).toBe("created");
    expect(mapTransactionStatus("TRANSACTION_STATUS_IN_PROGRESS")).toBe("pending");
    expect(mapTransactionStatus("TRANSACTION_STATUS_PENDING")).toBe("pending");
    expect(mapTransactionStatus("TRANSACTION_STATUS_SUCCESS")).toBe("success");
    expect(mapTransactionStatus("TRANSACTION_STATUS_COMPLETED")).toBe("success");
    expect(mapTransactionStatus("TRANSACTION_STATUS_FAILED")).toBe("failed");
  });

  test("an unrecognised or missing status is 'unknown', never a success", () => {
    // Defaulting to success would settle a row on a status we cannot read.
    for (const raw of [undefined, "", "TRANSACTION_STATUS_WHO_KNOWS", "success"]) {
      expect(mapTransactionStatus(raw)).toBe("unknown");
    }
  });
});

describe("isAwaitingCommit", () => {
  test("the live quote-time record is not ready to send against", () => {
    // The exact shape returned four seconds after /sell/quote, for a merchant
    // whose popup was blocked and who never opened the widget. Reading this as
    // committed is what sent USDC against an order Coinbase never had.
    expect(
      isAwaitingCommit({ status: mapTransactionStatus("TRANSACTION_STATUS_STARTED"), deadlineMs: null }),
    ).toBe(true);
    expect(isAwaitingCommit({ status: "created", deadlineMs: null })).toBe(true);
  });

  test("a deadline means Coinbase committed the order", () => {
    // Coinbase only issues a deadline once the merchant confirms, so its
    // presence clears the gate even while the status still reads created.
    expect(isAwaitingCommit({ status: "created", deadlineMs: 1_800_000_000_000 })).toBe(
      false,
    );
  });

  test("any status past created clears the gate", () => {
    // Deliberately permissive: a committed order has never been observed, and
    // refusing to send on one that is genuinely ready strands the merchant too.
    for (const status of ["pending", "success", "failed", "unknown"] as const) {
      expect(isAwaitingCommit({ status, deadlineMs: null })).toBe(false);
    }
  });
});

describe("decimalToMinor", () => {
  test("parses the money shape Coinbase returns", () => {
    // Values from the live Phase 0 probe: 10 USDC -> S$12.67, fee S$0.13.
    expect(decimalToMinor("12.67", 2)).toBe(1267n);
    expect(decimalToMinor("0.13", 2)).toBe(13n);
    expect(decimalToMinor("10", 6)).toBe(10_000_000n);
  });

  test("pads short fractions and truncates long ones", () => {
    expect(decimalToMinor("1.5", 2)).toBe(150n);
    expect(decimalToMinor("1.239", 2)).toBe(123n);
    expect(decimalToMinor("1.9999999", 6)).toBe(1_999_999n);
  });

  test("missing or empty value is zero, not NaN", () => {
    expect(decimalToMinor(undefined, 2)).toBe(0n);
    expect(decimalToMinor("", 2)).toBe(0n);
  });

  test("handles negatives and bare fractions", () => {
    expect(decimalToMinor("-1.25", 2)).toBe(-125n);
    expect(decimalToMinor("0.01", 2)).toBe(1n);
  });

  test("is exact on amounts a float would round", () => {
    expect(decimalToMinor("90071992547409.93", 2)).toBe(9_007_199_254_740_993n);
  });
});

describe("parseDeadlineMs", () => {
  test("parses an ISO timestamp", () => {
    expect(parseDeadlineMs("2026-08-11T09:30:00.000Z")).toBe(
      Date.parse("2026-08-11T09:30:00.000Z"),
    );
  });

  test("distinguishes seconds from milliseconds", () => {
    expect(parseDeadlineMs(1_786_000_000)).toBe(1_786_000_000_000);
    expect(parseDeadlineMs(1_786_000_000_000)).toBe(1_786_000_000_000);
  });

  test("returns null rather than inventing a deadline", () => {
    // The UI shows Coinbase's clock; a guessed one could disagree with the
    // order that is actually expiring.
    for (const bad of [undefined, null, "", "not a date", {}, NaN]) {
      expect(parseDeadlineMs(bad)).toBeNull();
    }
  });
});

describe("buildOfframpUrl", () => {
  const INPUT = {
    sessionToken: "tok_abc",
    quoteId: "q-123",
    presetCryptoAmount: "47.3",
    partnerUserId: "quay-merchant-1",
    redirectUrl: "https://app.quay.cash/app/merchant/wallet",
  };

  test("targets the live v3 widget path", () => {
    const u = new URL(buildOfframpUrl(INPUT));
    expect(u.origin).toBe("https://pay.coinbase.com");
    expect(u.pathname).toBe("/v3/sell/input");
  });

  test("locks the amount with disableEdit", () => {
    // Without this the merchant can edit the amount on Coinbase's screen and
    // commit to more USDC than was actually freed up.
    const u = new URL(buildOfframpUrl(INPUT));
    expect(u.searchParams.get("disableEdit")).toBe("true");
    expect(u.searchParams.get("presetCryptoAmount")).toBe("47.3");
  });

  test("carries the session token, quote and corridor", () => {
    const u = new URL(buildOfframpUrl(INPUT));
    expect(u.searchParams.get("sessionToken")).toBe("tok_abc");
    expect(u.searchParams.get("quoteId")).toBe("q-123");
    expect(u.searchParams.get("defaultAsset")).toBe("USDC");
    expect(u.searchParams.get("defaultNetwork")).toBe("sui");
    expect(u.searchParams.get("defaultCashoutCurrency")).toBe("SGD");
    expect(u.searchParams.get("partnerUserId")).toBe("quay-merchant-1");
    expect(u.searchParams.get("redirectUrl")).toBe(INPUT.redirectUrl);
  });

  test("prefers a URL Coinbase supplies, if it ever starts supplying one", () => {
    const url = buildOfframpUrl({
      ...INPUT,
      returnedOfframpUrl: "https://pay.coinbase.com/from-the-api",
    });
    expect(url).toBe("https://pay.coinbase.com/from-the-api");
  });

  test("an empty returned URL falls back to construction", () => {
    // This is the live behaviour today: the API returns "" for every request
    // shape, so treating it as absent is the whole reason we build our own.
    const url = buildOfframpUrl({ ...INPUT, returnedOfframpUrl: "" });
    expect(url).toContain("/v3/sell/input");
  });
});
