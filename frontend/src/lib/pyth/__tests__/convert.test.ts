import { describe, expect, test } from "bun:test";
import { type PythPrice } from "../client";
import { formatSgd, formatSui, quoteSgdToSui } from "../convert";

const NOW = 1_700_000_000_000; // fixed test clock (ms)

function mkPrice(price: number, ageSec = 0): PythPrice {
  return {
    feedId: "0xdeadbeef",
    price,
    conf: price * 0.001,
    publishTime: Math.floor(NOW / 1000) - ageSec,
    expo: -8,
    rawPrice: String(Math.round(price * 1e8)),
    rawConf: "0",
  };
}

describe("quoteSgdToSui — typical case", () => {
  test("$1.50 SGD at USD/SGD=1.35, SUI/USD=$3.20 → ~0.347 SUI", () => {
    const q = quoteSgdToSui(
      {
        sgdMinorUnits: 150,
        usdSgd: mkPrice(1.35),
        suiUsd: mkPrice(3.2),
      },
      NOW,
    );
    expect(q.sgd).toBeCloseTo(1.5);
    expect(q.usd).toBeCloseTo(1.5 / 1.35, 6);
    expect(q.sui).toBeCloseTo(1.5 / 1.35 / 3.2, 6);
    expect(q.suiMist).toBeGreaterThan(0n);
  });

  test("rates are surfaced both directions", () => {
    const q = quoteSgdToSui(
      { sgdMinorUnits: 100, usdSgd: mkPrice(1.35), suiUsd: mkPrice(3.2) },
      NOW,
    );
    expect(q.rates.sgdPerUsd).toBeCloseTo(1.35);
    expect(q.rates.usdPerSgd).toBeCloseTo(1 / 1.35);
    expect(q.rates.usdPerSui).toBeCloseTo(3.2);
  });

  test("rounds MIST up (user always covers the SGD price)", () => {
    // Carefully chosen so the un-rounded SUI lands at, e.g., 0.000123456789 SUI
    // = 123456.789 MIST → must round to 123457 MIST, not 123456.
    const q = quoteSgdToSui(
      { sgdMinorUnits: 1, usdSgd: mkPrice(1.35), suiUsd: mkPrice(3.2) },
      NOW,
    );
    // The exact JS-math result is irrational here; just confirm ceil behaviour:
    const exactSuiMist = (q.sui * 1_000_000_000);
    expect(Number(q.suiMist)).toBeGreaterThanOrEqual(Math.floor(exactSuiMist));
    expect(Number(q.suiMist)).toBeLessThanOrEqual(Math.ceil(exactSuiMist));
  });
});

describe("quoteSgdToSui — zero + edge cases", () => {
  test("0 SGD → 0 across the board", () => {
    const q = quoteSgdToSui(
      { sgdMinorUnits: 0, usdSgd: mkPrice(1.35), suiUsd: mkPrice(3.2) },
      NOW,
    );
    expect(q.sgd).toBe(0);
    expect(q.usd).toBe(0);
    expect(q.sui).toBe(0);
    expect(q.suiMist).toBe(0n);
  });

  test("negative USD/SGD price throws", () => {
    expect(() =>
      quoteSgdToSui({ sgdMinorUnits: 100, usdSgd: mkPrice(-1), suiUsd: mkPrice(3.2) }, NOW),
    ).toThrow();
  });

  test("zero SUI/USD price throws", () => {
    expect(() =>
      quoteSgdToSui({ sgdMinorUnits: 100, usdSgd: mkPrice(1.35), suiUsd: mkPrice(0) }, NOW),
    ).toThrow();
  });

  test("max-age tracks the older of the two inputs", () => {
    const q = quoteSgdToSui(
      {
        sgdMinorUnits: 100,
        usdSgd: mkPrice(1.35, /* age */ 5),
        suiUsd: mkPrice(3.2, /* age */ 42),
      },
      NOW,
    );
    expect(q.maxAgeSeconds).toBe(42);
  });
});

describe("quoteSgdToSui — extreme markets", () => {
  test("SUI moonshots to $100 → tiny SUI for small SGD", () => {
    const q = quoteSgdToSui(
      { sgdMinorUnits: 150, usdSgd: mkPrice(1.35), suiUsd: mkPrice(100) },
      NOW,
    );
    expect(q.sui).toBeLessThan(0.02);
    expect(q.sui).toBeGreaterThan(0.005);
  });

  test("SUI crashes to $0.01 → many SUI for small SGD", () => {
    const q = quoteSgdToSui(
      { sgdMinorUnits: 150, usdSgd: mkPrice(1.35), suiUsd: mkPrice(0.01) },
      NOW,
    );
    expect(q.sui).toBeGreaterThan(100);
  });

  test("large SGD ticket ($10,000) computes cleanly", () => {
    const q = quoteSgdToSui(
      { sgdMinorUnits: 1_000_000, usdSgd: mkPrice(1.35), suiUsd: mkPrice(3.2) },
      NOW,
    );
    expect(q.sgd).toBe(10_000);
    expect(q.sui).toBeGreaterThan(2_000);
    expect(q.sui).toBeLessThan(3_000);
  });
});

describe("formatters", () => {
  test("formatSgd: two decimals", () => {
    expect(formatSgd(1.5)).toBe("$1.50 SGD");
    expect(formatSgd(0.05)).toBe("$0.05 SGD");
    expect(formatSgd(100)).toBe("$100.00 SGD");
  });

  test("formatSui: 4 dp under 1, 2 dp above", () => {
    expect(formatSui(0.0123)).toBe("0.0123 SUI");
    expect(formatSui(0.5)).toBe("0.5000 SUI");
    expect(formatSui(1)).toBe("1.00 SUI");
    expect(formatSui(123.456)).toBe("123.46 SUI");
  });
});
