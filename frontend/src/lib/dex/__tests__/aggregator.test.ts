import { describe, test, expect } from "bun:test";

import {
  AggregatorRouteError,
  AggregatorSlippageError,
  assertOutputWithinSlippage,
  minAcceptableOut,
  quoteRoute,
} from "../aggregator";

import type { AggregatorClient, RouterDataV3 } from "@cetusprotocol/aggregator-sdk";

// ─── slippage math ──────────────────────────────────────────────────────

describe("minAcceptableOut", () => {
  test("1% slippage shaves 1% off the expected output", () => {
    expect(minAcceptableOut(1_000_000n, 100)).toBe(990_000n);
  });

  test("0% slippage is identity", () => {
    expect(minAcceptableOut(1_000_000n, 0)).toBe(1_000_000n);
  });

  test("100% slippage floors to zero", () => {
    expect(minAcceptableOut(1_000_000n, 10_000)).toBe(0n);
  });

  test("rejects out-of-range slippage", () => {
    expect(() => minAcceptableOut(1n, -1)).toThrow();
    expect(() => minAcceptableOut(1n, 10_001)).toThrow();
  });

  test("integer math — no Number rounding even for u64-ish values", () => {
    const huge = 9_999_999_999_999_999_999n;
    const result = minAcceptableOut(huge, 50);
    // 99.5% of 9.999... × 10^18
    expect(result).toBe((huge * 9950n) / 10_000n);
  });
});

describe("assertOutputWithinSlippage", () => {
  test("passes when routed output meets the floor", () => {
    expect(() => assertOutputWithinSlippage(1_000_000n, 990_000n)).not.toThrow();
  });

  test("throws when routed output is below the floor", () => {
    expect(() => assertOutputWithinSlippage(900_000n, 990_000n)).toThrow(
      AggregatorSlippageError,
    );
  });

  test("error carries expectedOut + minAcceptable for the UI", () => {
    try {
      assertOutputWithinSlippage(900_000n, 990_000n);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AggregatorSlippageError);
      if (e instanceof AggregatorSlippageError) {
        expect(e.expectedOut).toBe(900_000n);
        expect(e.minAcceptable).toBe(990_000n);
      }
    }
  });
});

// ─── quoteRoute bypass when tokens match ────────────────────────────────

describe("quoteRoute", () => {
  test("returns kind: 'direct' when input and output tokens match", async () => {
    // The aggregator should never be called when tokens match — pass a
    // stub that throws if invoked.
    const cetus = {
      findRouters: () => {
        throw new Error("aggregator should not be called for direct transfers");
      },
    } as unknown as AggregatorClient;

    const result = await quoteRoute(cetus, {
      inputCoinType: "0x2::sui::SUI",
      outputCoinType: "0x2::sui::SUI",
      amountOut: 1_000_000_000n,
    });
    expect(result.kind).toBe("direct");
  });

  test("throws AggregatorRouteError when the aggregator returns null", async () => {
    const cetus = {
      findRouters: async () => null,
    } as unknown as AggregatorClient;

    await expect(
      quoteRoute(cetus, {
        inputCoinType: "0xa::a::A",
        outputCoinType: "0xb::b::B",
        amountOut: 1n,
      }),
    ).rejects.toBeInstanceOf(AggregatorRouteError);
  });

  test("throws AggregatorRouteError when route has insufficient liquidity", async () => {
    const cetus = {
      findRouters: async () =>
        ({
          amountIn: { toString: () => "0" } as never,
          amountOut: { toString: () => "0" } as never,
          byAmountIn: false,
          paths: [],
          insufficientLiquidity: true,
          deviationRatio: 0,
        }) as unknown as RouterDataV3,
    } as unknown as AggregatorClient;

    await expect(
      quoteRoute(cetus, {
        inputCoinType: "0xa::a::A",
        outputCoinType: "0xb::b::B",
        amountOut: 1n,
      }),
    ).rejects.toBeInstanceOf(AggregatorRouteError);
  });

  test("returns kind: 'route' with venues + amountIn on success", async () => {
    const cetus = {
      findRouters: async () =>
        ({
          amountIn: { toString: () => "123456" } as never,
          amountOut: { toString: () => "1000000" } as never,
          byAmountIn: false,
          paths: [{ provider: "DEEPBOOKV3" }, { provider: "CETUS" }],
          insufficientLiquidity: false,
          deviationRatio: 0,
        }) as unknown as RouterDataV3,
    } as unknown as AggregatorClient;

    const result = await quoteRoute(cetus, {
      inputCoinType: "0xa::a::A",
      outputCoinType: "0xb::b::B",
      amountOut: 1_000_000n,
    });
    expect(result.kind).toBe("route");
    if (result.kind !== "route") throw new Error("unreachable");
    expect(result.amountIn).toBe(123_456n);
    expect(result.venues).toContain("DEEPBOOKV3");
    expect(result.venues).toContain("CETUS");
  });
});
