import { describe, expect, test } from "bun:test";

import type { BalanceSheet } from "../scallop";
import {
  HAIRCUT_BPS,
  MAX_COINS_PER_PTB,
  checkCoinCount,
  planRedeemFromBalanceSheet,
  sharePriceFloat,
  sharesToUnderlying,
  totalUnderlying,
  underlyingToShares,
  usableCash,
} from "../scallop-redeem";

/** Mainnet-shaped sheet: share price ≈ 1.0319, as observed 2026-08-11. */
const MAINNET: BalanceSheet = {
  cash: 45_385_914_304n,
  debt: 107_681_729_502n,
  revenue: 980_779_286n,
  marketCoinSupply: 147_387_341_012n,
};

/** 1:1 reserve with plenty of cash, for arithmetic that should be exact. */
const FLAT: BalanceSheet = {
  cash: 1_000_000n,
  debt: 0n,
  revenue: 0n,
  marketCoinSupply: 1_000_000n,
};

const GENESIS: BalanceSheet = {
  cash: 0n,
  debt: 0n,
  revenue: 0n,
  marketCoinSupply: 0n,
};

describe("share price", () => {
  test("matches the mainnet observation", () => {
    expect(sharePriceFloat(MAINNET)).toBeCloseTo(1.031887, 5);
  });

  test("genesis reserve reports 1.0 rather than dividing by zero", () => {
    expect(sharePriceFloat(GENESIS)).toBe(1.0);
  });

  test("totalUnderlying subtracts revenue", () => {
    expect(totalUnderlying(MAINNET)).toBe(
      MAINNET.cash + MAINNET.debt - MAINNET.revenue,
    );
  });
});

describe("haircut", () => {
  test("removes exactly 1% of pool cash", () => {
    expect(HAIRCUT_BPS).toBe(100n);
    expect(usableCash(FLAT)).toBe(990_000n);
  });

  test("never goes negative on a dust-sized reserve", () => {
    expect(usableCash({ ...FLAT, cash: 0n })).toBe(0n);
    expect(usableCash({ ...FLAT, cash: 1n })).toBe(1n);
  });
});

describe("integer conversions", () => {
  test("round-trip is stable on a 1:1 reserve", () => {
    expect(sharesToUnderlying(FLAT, 1234n)).toBe(1234n);
    expect(underlyingToShares(FLAT, 1234n)).toBe(1234n);
  });

  test("shares→underlying rounds down, underlying→shares rounds up", () => {
    // Deliberately asymmetric so we never under-burn and leave the redeem short.
    const shares = 1000n;
    const underlying = sharesToUnderlying(MAINNET, shares);
    expect(underlying).toBe((shares * totalUnderlying(MAINNET)) / MAINNET.marketCoinSupply);
    expect(underlyingToShares(MAINNET, underlying)).toBeLessThanOrEqual(shares);
    expect(underlyingToShares(MAINNET, underlying + 1n)).toBeGreaterThan(
      underlyingToShares(MAINNET, underlying) - 1n,
    );
  });

  test("stays exact past 2^53, where the old float path lost precision", () => {
    const huge: BalanceSheet = {
      cash: 90_000_000_000_000_000n,
      debt: 0n,
      revenue: 0n,
      marketCoinSupply: 90_000_000_000_000_000n,
    };
    const shares = 9_007_199_254_740_993n; // 2^53 + 1
    expect(sharesToUnderlying(huge, shares)).toBe(shares);
    // Demonstrate the hazard the integer path avoids: a round-trip through
    // Number (what the old `Number(usableCash) / sharePrice` clamp did) does
    // not survive here.
    expect(BigInt(Number(shares))).not.toBe(shares);
  });

  test("genesis treats shares as 1:1 instead of dividing by zero", () => {
    expect(sharesToUnderlying(GENESIS, 500n)).toBe(500n);
    expect(underlyingToShares(GENESIS, 500n)).toBe(500n);
  });
});

describe("planRedeemFromBalanceSheet", () => {
  test("zero balance plans nothing", () => {
    const p = planRedeemFromBalanceSheet({ shareBalance: 0n, balanceSheet: MAINNET });
    expect(p).toMatchObject({
      partial: false,
      redeemableShare: 0n,
      leftoverShare: 0n,
      realizableUnderlying: 0n,
    });
  });

  test("full redeem when cash comfortably covers the balance", () => {
    const p = planRedeemFromBalanceSheet({ shareBalance: 1_000n, balanceSheet: MAINNET });
    expect(p.partial).toBe(false);
    expect(p.redeemableShare).toBe(1_000n);
    expect(p.leftoverShare).toBe(0n);
    // 1000 shares at ~1.0319 → 1031 underlying, rounded down.
    expect(p.realizableUnderlying).toBe(1031n);
  });

  test("clamps to pool cash and reports the remainder as leftover", () => {
    // Merchant holds more than the whole reserve's cash can satisfy.
    const p = planRedeemFromBalanceSheet({
      shareBalance: 1_000_000_000_000n,
      balanceSheet: MAINNET,
    });
    expect(p.partial).toBe(true);
    expect(p.leftoverShare).toBeGreaterThan(0n);
    expect(p.redeemableShare + p.leftoverShare).toBe(1_000_000_000_000n);
    // The realizable amount must not exceed the haircut cash — that is the
    // whole point of the clamp, since exceeding `cash` aborts on chain.
    expect(p.realizableUnderlying).toBeLessThanOrEqual(p.usableCashMinor);
  });

  test("clamp result never exceeds usable cash for a spread of balances", () => {
    for (const bal of [1n, 10n ** 6n, 10n ** 9n, 10n ** 12n, 10n ** 15n]) {
      const p = planRedeemFromBalanceSheet({ shareBalance: bal, balanceSheet: MAINNET });
      expect(p.realizableUnderlying).toBeLessThanOrEqual(p.usableCashMinor);
      expect(p.redeemableShare).toBeLessThanOrEqual(bal);
      expect(p.redeemableShare + p.leftoverShare).toBe(bal);
    }
  });

  test("honours a requested underlying cap below the balance", () => {
    const p = planRedeemFromBalanceSheet({
      shareBalance: 1_000_000n,
      balanceSheet: FLAT,
      requestedUnderlying: 250_000n,
    });
    expect(p.partial).toBe(true);
    expect(p.redeemableShare).toBe(250_000n);
    expect(p.leftoverShare).toBe(750_000n);
  });

  test("a request larger than the balance does not inflate the plan", () => {
    const p = planRedeemFromBalanceSheet({
      shareBalance: 100n,
      balanceSheet: FLAT,
      requestedUnderlying: 10_000_000n,
    });
    expect(p.redeemableShare).toBe(100n);
    expect(p.partial).toBe(false);
  });

  test("a genesis reserve redeems 1:1 rather than stalling", () => {
    const p = planRedeemFromBalanceSheet({ shareBalance: 42n, balanceSheet: GENESIS });
    expect(p.redeemableShare).toBe(42n);
    expect(p.realizableUnderlying).toBe(42n);
    expect(p.partial).toBe(false);
  });

  test("a drained pool yields a zero plan, not a negative one", () => {
    const drained: BalanceSheet = { ...MAINNET, cash: 0n };
    const p = planRedeemFromBalanceSheet({ shareBalance: 1_000n, balanceSheet: drained });
    expect(p.redeemableShare).toBe(0n);
    expect(p.leftoverShare).toBe(1_000n);
    expect(p.partial).toBe(true);
    expect(p.realizableUnderlying).toBe(0n);
  });
});

describe("checkCoinCount", () => {
  test("passes at the limit and fails past it", () => {
    expect(checkCoinCount(MAX_COINS_PER_PTB).ok).toBe(true);
    expect(checkCoinCount(MAX_COINS_PER_PTB + 1).ok).toBe(false);
    expect(checkCoinCount(0).ok).toBe(true);
  });

  test("reports the numbers a 413 response needs", () => {
    expect(checkCoinCount(51)).toEqual({ ok: false, count: 51, max: 50 });
  });
});
