import { afterEach, describe, expect, test } from "bun:test";

import {
  buildOfframpUrl,
  cashoutCurrency,
  decimalToMinor,
  isAwaitingCommit,
  mapTransactionStatus,
  minUsdsuiForCashout,
  offrampDailyCap,
  parseDeadlineMs,
  selectDepositTransaction,
  type OfframpTransaction,
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

describe("cashoutCurrency", () => {
  const saved = process.env.COINBASE_CASHOUT_CURRENCY;
  afterEach(() => {
    if (saved === undefined) delete process.env.COINBASE_CASHOUT_CURRENCY;
    else process.env.COINBASE_CASHOUT_CURRENCY = saved;
  });

  test("defaults to SGD", () => {
    delete process.env.COINBASE_CASHOUT_CURRENCY;
    expect(cashoutCurrency()).toBe("SGD");
  });

  test("USD is selectable — the point of the knob", () => {
    // SGD's floor (S$7) exceeds a pending-review app's US$5 test cap, leaving
    // no valid amount. USD's floor is $2, so the rail becomes testable at all.
    process.env.COINBASE_CASHOUT_CURRENCY = "usd";
    expect(cashoutCurrency()).toBe("USD");
  });

  test("junk falls back to SGD rather than reaching Coinbase", () => {
    for (const raw of ["", "  ", "dollars", "US", "USDD", "U$D"]) {
      process.env.COINBASE_CASHOUT_CURRENCY = raw;
      expect(cashoutCurrency()).toBe("SGD");
    }
  });
});

describe("offrampDailyCap", () => {
  const saved = process.env.COINBASE_OFFRAMP_DAILY_CAP;
  afterEach(() => {
    if (saved === undefined) delete process.env.COINBASE_OFFRAMP_DAILY_CAP;
    else process.env.COINBASE_OFFRAMP_DAILY_CAP = saved;
  });

  test("disabled by default", () => {
    delete process.env.COINBASE_OFFRAMP_DAILY_CAP;
    expect(offrampDailyCap()).toBe(0);
  });

  test("a positive value restores a ceiling", () => {
    process.env.COINBASE_OFFRAMP_DAILY_CAP = "5";
    expect(offrampDailyCap()).toBe(5);
  });

  test("junk or a non-positive value disables rather than guessing a cap", () => {
    // Failing closed here would lock every merchant out on a typo.
    for (const raw of ["", " ", "lots", "-3", "0", "NaN"]) {
      process.env.COINBASE_OFFRAMP_DAILY_CAP = raw;
      expect(offrampDailyCap()).toBe(0);
    }
  });
});

describe("minUsdsuiForCashout", () => {
  test("converts a fiat floor into a USDsui one", () => {
    // S$7.00 at the conservative 1.40 ceiling → 5.00 USDsui.
    expect(minUsdsuiForCashout(700n, "SGD")).toBe(5_000_000n);
  });

  test("errs low so the quote, not this, is the gate", () => {
    // $2.00 must not compute to more than 2 USDsui, or a valid amount is
    // refused before Coinbase ever sees it.
    const min = minUsdsuiForCashout(200n, "USD");
    expect(min).not.toBeNull();
    expect(min!).toBeLessThan(2_000_000n);
  });

  test("an unknown currency skips the pre-check instead of guessing", () => {
    expect(minUsdsuiForCashout(700n, "AED")).toBeNull();
  });
});

describe("selectDepositTransaction", () => {
  const ROW_CREATED = Date.parse("2026-08-11T14:32:28.000Z");

  const tx = (over: Partial<OfframpTransaction>): OfframpTransaction => ({
    status: "created",
    toAddress: "0xdeposit",
    sellAmountUsdcMinor: 2_900_000n,
    asset: "USDC",
    network: "sui",
    transactionId: "t-new",
    deadlineMs: null,
    createdAtMs: ROW_CREATED + 4_000,
    ...over,
  });

  /** The live incident: a dead morning order still carrying its address. */
  const STALE_FAILED = tx({
    transactionId: "1f1958cb",
    status: "failed",
    createdAtMs: Date.parse("2026-08-11T13:58:12.828Z"),
  });

  test("a previous failed order is never reused as a deposit target", () => {
    // This exact list bound a 14:32 cash-out to the 13:58 order and declared it
    // fundable 1.4s after creation.
    expect(
      selectDepositTransaction([STALE_FAILED], {
        rowCreatedAtMs: ROW_CREATED,
        boundTransactionId: null,
      }),
    ).toBeNull();
  });

  test("age alone does not disqualify — liveness and recency are both required", () => {
    // A live order that predates this row is still someone else's order.
    const olderButLive = tx({ createdAtMs: ROW_CREATED - 10 * 60_000 });
    expect(
      selectDepositTransaction([olderButLive], {
        rowCreatedAtMs: ROW_CREATED,
        boundTransactionId: null,
      }),
    ).toBeNull();
  });

  test("picks the live record created for this order", () => {
    const picked = selectDepositTransaction([STALE_FAILED, tx({})], {
      rowCreatedAtMs: ROW_CREATED,
      boundTransactionId: null,
    });
    expect(picked?.transactionId).toBe("t-new");
  });

  test("prefers the newest when a flow re-quotes", () => {
    const older = tx({ transactionId: "t-older", createdAtMs: ROW_CREATED + 1_000 });
    const newer = tx({ transactionId: "t-newer", createdAtMs: ROW_CREATED + 9_000 });
    expect(
      selectDepositTransaction([older, newer], {
        rowCreatedAtMs: ROW_CREATED,
        boundTransactionId: null,
      })?.transactionId,
    ).toBe("t-newer");
  });

  test("tolerates small clock skew against Coinbase", () => {
    const slightlyEarly = tx({ createdAtMs: ROW_CREATED - 5_000 });
    expect(
      selectDepositTransaction([slightlyEarly], {
        rowCreatedAtMs: ROW_CREATED,
        boundTransactionId: null,
      }),
    ).not.toBeNull();
  });

  test("a record with no timestamp cannot be bound to an order", () => {
    expect(
      selectDepositTransaction([tx({ createdAtMs: null })], {
        rowCreatedAtMs: ROW_CREATED,
        boundTransactionId: null,
      }),
    ).toBeNull();
  });

  test("an already-bound row stays on its own transaction", () => {
    // Even when a newer record exists — re-binding mid-flight would move the
    // deposit target out from under an order the merchant already confirmed.
    const bound = tx({ transactionId: "t-bound", createdAtMs: ROW_CREATED + 1_000 });
    const newer = tx({ transactionId: "t-newer", createdAtMs: ROW_CREATED + 9_000 });
    expect(
      selectDepositTransaction([bound, newer], {
        rowCreatedAtMs: ROW_CREATED,
        boundTransactionId: "t-bound",
      })?.transactionId,
    ).toBe("t-bound");
  });

  test("a bound order that has since died is unusable, not replaced", () => {
    const deadBound = tx({ transactionId: "t-bound", status: "failed" });
    const newer = tx({ transactionId: "t-newer", createdAtMs: ROW_CREATED + 9_000 });
    expect(
      selectDepositTransaction([deadBound, newer], {
        rowCreatedAtMs: ROW_CREATED,
        boundTransactionId: "t-bound",
      }),
    ).toBeNull();
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
