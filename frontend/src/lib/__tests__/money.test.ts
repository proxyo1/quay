import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CASHOUT_MAX_SGD_MINOR,
  cashoutCapMinor,
  coinbaseOfframpCapMinor,
  formatFiatMinor,
  formatSgdMinor,
  formatUsdsuiExact,
  formatUsdsuiMinor,
  parseUsdsuiToMinor,
} from "../money";

describe("formatSgdMinor", () => {
  test("always shows two decimal places", () => {
    expect(formatSgdMinor(13416n)).toBe("134.16");
    expect(formatSgdMinor(100n)).toBe("1.00");
    expect(formatSgdMinor(5n)).toBe("0.05");
    expect(formatSgdMinor(0n)).toBe("0.00");
  });

  test("handles negatives without losing the pad", () => {
    expect(formatSgdMinor(-5n)).toBe("-0.05");
    expect(formatSgdMinor(-13416n)).toBe("-134.16");
  });

  test("survives amounts past Number.MAX_SAFE_INTEGER", () => {
    expect(formatSgdMinor(9_007_199_254_740_993_00n)).toBe("9007199254740993.00");
  });
});

describe("formatUsdsuiMinor", () => {
  test("trims trailing zeros but keeps significant digits", () => {
    expect(formatUsdsuiMinor(1_500_000n)).toBe("1.5");
    expect(formatUsdsuiMinor(1_000_000n)).toBe("1");
    expect(formatUsdsuiMinor(1_234_567n)).toBe("1.234567");
    expect(formatUsdsuiMinor(1n)).toBe("0.000001");
    expect(formatUsdsuiMinor(0n)).toBe("0");
  });

  test("handles negatives", () => {
    expect(formatUsdsuiMinor(-1_500_000n)).toBe("-1.5");
  });
});

describe("formatUsdsuiExact", () => {
  test("keeps all six decimals", () => {
    expect(formatUsdsuiExact(1_500_000n)).toBe("1.500000");
    expect(formatUsdsuiExact(1n)).toBe("0.000001");
  });

  test("round-trips through parseUsdsuiToMinor", () => {
    for (const v of [0n, 1n, 999_999n, 1_000_000n, 47_300_000n]) {
      expect(parseUsdsuiToMinor(formatUsdsuiExact(v))).toBe(v);
    }
  });
});

describe("parseUsdsuiToMinor", () => {
  test("parses plain and fractional amounts", () => {
    expect(parseUsdsuiToMinor("1")).toBe(1_000_000n);
    expect(parseUsdsuiToMinor("1.5")).toBe(1_500_000n);
    expect(parseUsdsuiToMinor("0.000001")).toBe(1n);
    expect(parseUsdsuiToMinor("  2.25  ")).toBe(2_250_000n);
  });

  test("rejects malformed input rather than coercing it", () => {
    // Silently coercing a money amount is worse than telling the merchant.
    for (const bad of ["", ".", ".5", "5.", "abc", "-1", "1.2.3", "1e6", "1,5"]) {
      expect(parseUsdsuiToMinor(bad)).toBeNull();
    }
  });

  test("rejects more precision than USDsui has, instead of truncating", () => {
    expect(parseUsdsuiToMinor("1.1234567")).toBeNull();
  });
});

describe("payout caps", () => {
  type CapEnvKey = "CASHOUT_MAX_SGD_MINOR" | "COINBASE_OFFRAMP_MAX_SGD_MINOR";
  function withEnv(key: CapEnvKey, value: string | undefined, fn: () => void) {
    const prev = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }

  test("default to S$50 when unset", () => {
    withEnv("CASHOUT_MAX_SGD_MINOR", undefined, () => {
      expect(cashoutCapMinor()).toBe(DEFAULT_CASHOUT_MAX_SGD_MINOR);
    });
    withEnv("COINBASE_OFFRAMP_MAX_SGD_MINOR", undefined, () => {
      expect(coinbaseOfframpCapMinor()).toBe(DEFAULT_CASHOUT_MAX_SGD_MINOR);
    });
  });

  test("read their own env var", () => {
    withEnv("CASHOUT_MAX_SGD_MINOR", "12345", () => {
      expect(cashoutCapMinor()).toBe(12345n);
    });
    withEnv("COINBASE_OFFRAMP_MAX_SGD_MINOR", "777", () => {
      expect(coinbaseOfframpCapMinor()).toBe(777n);
    });
  });

  test("the two rails are independently configurable", () => {
    withEnv("CASHOUT_MAX_SGD_MINOR", "111", () => {
      withEnv("COINBASE_OFFRAMP_MAX_SGD_MINOR", "222", () => {
        expect(cashoutCapMinor()).toBe(111n);
        expect(coinbaseOfframpCapMinor()).toBe(222n);
      });
    });
  });

  test("fall back to the default on garbage or non-positive values", () => {
    for (const bad of ["", "abc", "0", "-5", "1.5"]) {
      withEnv("CASHOUT_MAX_SGD_MINOR", bad, () => {
        expect(cashoutCapMinor()).toBe(DEFAULT_CASHOUT_MAX_SGD_MINOR);
      });
    }
  });
});

describe("formatFiatMinor", () => {
  test("renders the payout currency's own symbol", () => {
    // The payout currency is configurable, so an amount must never be labelled
    // S$ just because SGD is the default.
    expect(formatFiatMinor(367n, "SGD")).toBe("S$3.67");
    expect(formatFiatMinor(367n, "USD")).toBe("$3.67");
    expect(formatFiatMinor(367n, "EUR")).toBe("€3.67");
    expect(formatFiatMinor(367n, "GBP")).toBe("£3.67");
  });

  test("accepts a lowercase code", () => {
    expect(formatFiatMinor(700n, "usd")).toBe("$7.00");
  });

  test("an unknown currency shows its code, never a guessed symbol", () => {
    expect(formatFiatMinor(1234n, "AED")).toBe("AED 12.34");
  });
});
