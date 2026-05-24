import { describe, expect, test } from "bun:test";

import {
  computeCashoutQuote,
  formatSgdMinor,
  FX_RATE_MAX_AGE_SECONDS,
  QUAY_FEE_BPS,
} from "../cashout-fee";

describe("computeCashoutQuote", () => {
  test("100 USDsui at USD/SGD=1.345, 25bps fee", () => {
    // 100 USDsui = 100_000_000 microunits. gross = 100 * 1.345 = 134.50 SGD
    // = 13450 cents. fee = round(13450 * 0.0025) = 34 cents. net = 13416.
    const q = computeCashoutQuote(100_000_000n, 1.345, QUAY_FEE_BPS);
    expect(q.grossSgdMinor).toBe(13450n);
    expect(q.feeSgdMinor).toBe(34n);
    expect(q.netSgdMinor).toBe(13416n);
    expect(q.feeBps).toBe(25);
  });

  test("default fee bps is 25", () => {
    const q = computeCashoutQuote(1_000_000n, 1.35);
    expect(q.feeBps).toBe(25);
  });

  test("fee is exactly 0.25% of gross", () => {
    const q = computeCashoutQuote(1_000_000_000n, 1.35); // 1000 USDsui
    // gross = 1350.00 = 135000 cents; fee = round(135000*0.0025) = 338
    expect(q.grossSgdMinor).toBe(135000n);
    expect(q.feeSgdMinor).toBe(338n);
    expect(q.netSgdMinor).toBe(135000n - 338n);
  });

  test("net = gross - fee always", () => {
    const q = computeCashoutQuote(777_123_456n, 1.401);
    expect(q.netSgdMinor).toBe(q.grossSgdMinor - q.feeSgdMinor);
  });

  test("rejects non-positive amount", () => {
    expect(() => computeCashoutQuote(0n, 1.35)).toThrow();
    expect(() => computeCashoutQuote(-5n, 1.35)).toThrow();
  });

  test("rejects invalid rate", () => {
    expect(() => computeCashoutQuote(1_000_000n, 0)).toThrow();
    expect(() => computeCashoutQuote(1_000_000n, -1)).toThrow();
    expect(() => computeCashoutQuote(1_000_000n, NaN)).toThrow();
    expect(() => computeCashoutQuote(1_000_000n, Infinity)).toThrow();
  });

  test("rejects dust that rounds to zero net", () => {
    // 1 microunit at rate 1.35 → 0.00000135 SGD → 0 cents → throws
    expect(() => computeCashoutQuote(1n, 1.35)).toThrow();
  });

  test("rejects out-of-range fee bps", () => {
    expect(() => computeCashoutQuote(1_000_000n, 1.35, -1)).toThrow();
    expect(() => computeCashoutQuote(1_000_000n, 1.35, 10000)).toThrow();
  });
});

describe("formatSgdMinor", () => {
  test("formats cents to dollars.cents", () => {
    expect(formatSgdMinor(13416n)).toBe("134.16");
    expect(formatSgdMinor(5n)).toBe("0.05");
    expect(formatSgdMinor(100n)).toBe("1.00");
    expect(formatSgdMinor(0n)).toBe("0.00");
    expect(formatSgdMinor(135000n)).toBe("1350.00");
  });
});

describe("FX_RATE_MAX_AGE_SECONDS", () => {
  // FX feeds don't tick on weekends; the gate must tolerate a Friday close
  // read on a Sunday (the "exchange rate unavailable" bug) plus holidays.
  test("covers a long weekend + holidays (>= 4 days)", () => {
    expect(FX_RATE_MAX_AGE_SECONDS).toBeGreaterThanOrEqual(4 * 24 * 60 * 60);
  });
  test("a 44h-stale weekend feed is within bound", () => {
    expect(44 * 60 * 60).toBeLessThan(FX_RATE_MAX_AGE_SECONDS);
  });
});
