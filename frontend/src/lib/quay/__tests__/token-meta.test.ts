import { describe, expect, test } from "bun:test";

import { COIN_TYPES } from "../pay";
import { USDSUI } from "../scallop";
import {
  formatMinor,
  formatTokenAmount,
  isYieldRoutedToken,
  tokenDecimals,
  tokenLabel,
  tokenLabelIfKnown,
  tokenMeta,
} from "../token-meta";

describe("tokenMeta", () => {
  test("resolves the real mainnet coin types the app settles in", () => {
    expect(tokenMeta(COIN_TYPES.SUI)).toEqual({ label: "SUI", decimals: 9 });
    expect(tokenMeta(USDSUI.coinType)).toEqual({ label: "USDsui", decimals: 6 });
    expect(tokenMeta(USDSUI.sCoinType)).toEqual({ label: "sUSDsui", decimals: 6 });
  });

  test("matches on suffix so testnet and mainnet packages both resolve", () => {
    // Same module::struct, different package address — the reason lookups key
    // on the suffix rather than the full type.
    expect(tokenMeta(COIN_TYPES.USDC_TESTNET).label).toBe("USDC");
    expect(
      tokenMeta("0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC")
        .label,
    ).toBe("USDC");
  });

  test("renders USDsui with the brand's casing, not the on-chain all-caps", () => {
    expect(tokenMeta(USDSUI.coinType).label).toBe("USDsui");
    expect(tokenMeta(USDSUI.coinType).label).not.toBe("USDSUI");
  });

  test("unknown tokens fall back to the struct name with zero decimals", () => {
    // decimals: 0 means the amount renders as a raw integer rather than being
    // silently mis-scaled by a guessed precision.
    expect(tokenMeta("0xabc::mystery::MYSTERY")).toEqual({
      label: "MYSTERY",
      decimals: 0,
    });
  });

  test("tokenLabel and tokenDecimals agree with tokenMeta", () => {
    expect(tokenLabel(USDSUI.coinType)).toBe(tokenMeta(USDSUI.coinType).label);
    expect(tokenDecimals(USDSUI.coinType)).toBe(tokenMeta(USDSUI.coinType).decimals);
  });
});

describe("tokenLabelIfKnown", () => {
  test("returns the curated label for known tokens", () => {
    expect(tokenLabelIfKnown(USDSUI.coinType)).toBe("USDsui");
  });

  test("returns null for unknown tokens so callers can use the chain symbol", () => {
    expect(tokenLabelIfKnown("0xabc::mystery::MYSTERY")).toBeNull();
  });
});

describe("isYieldRoutedToken", () => {
  test("true only for the Scallop sCoin wrapper", () => {
    expect(isYieldRoutedToken(USDSUI.sCoinType)).toBe(true);
    expect(isYieldRoutedToken(USDSUI.coinType)).toBe(false);
    expect(isYieldRoutedToken(COIN_TYPES.SUI)).toBe(false);
  });
});

describe("formatMinor", () => {
  test("scales by decimals and trims trailing zeros", () => {
    expect(formatMinor(1_500_000n, 6)).toBe("1.5");
    expect(formatMinor(1_000_000_000n, 9)).toBe("1");
    expect(formatMinor(1n, 6)).toBe("0.000001");
  });

  test("zero decimals renders the integer unchanged", () => {
    expect(formatMinor(1234n, 0)).toBe("1234");
  });

  test("handles negatives", () => {
    expect(formatMinor(-1_500_000n, 6)).toBe("-1.5");
  });

  test("is exact past Number.MAX_SAFE_INTEGER", () => {
    expect(formatMinor(9_007_199_254_740_993_000_000n, 6)).toBe("9007199254740993");
  });
});

describe("formatTokenAmount", () => {
  test("appends the curated label", () => {
    expect(formatTokenAmount(1_500_000n, USDSUI.coinType)).toBe("1.5 USDsui");
    expect(formatTokenAmount(2_000_000_000n, COIN_TYPES.SUI)).toBe("2 SUI");
    expect(formatTokenAmount(1_000_000n, USDSUI.sCoinType)).toBe("1 sUSDsui");
  });

  test("unknown token shows the raw integer plus its struct name", () => {
    expect(formatTokenAmount(42n, "0xabc::mystery::MYSTERY")).toBe("42 MYSTERY");
  });
});
