import { describe, expect, test } from "bun:test";

import type { AggregatorClient } from "@cetusprotocol/aggregator-sdk";

import { AggregatorRouteError } from "../../dex/aggregator";
import { USDSUI } from "../scallop";
import {
  SwapBudgetExceededError,
  USDC_MAINNET,
  appendUsdcSwapToPtb,
  quoteUsdcSwap,
} from "../swap-to-usdc";

/** Route stub matching the shape `quoteRoute` reads. */
function stubRoute(amountIn: bigint, overrides: Record<string, unknown> = {}) {
  return {
    amountIn: { toString: () => amountIn.toString() },
    insufficientLiquidity: false,
    error: null,
    paths: [{ provider: "CETUS" }, { provider: "DEEPBOOKV3" }],
    ...overrides,
  };
}

function stubCetus(
  route: unknown,
  captured?: { call?: Record<string, unknown> },
): AggregatorClient {
  return {
    findRouters: async () => route,
    routerSwapWithMaxAmountIn: async (params: Record<string, unknown>) => {
      if (captured) captured.call = params;
      return { $kind: "NestedResult", NestedResult: [0, 0] };
    },
  } as unknown as AggregatorClient;
}

const BASE = {
  amountOutUsdc: 10_000_000n, // 10 USDC
  budgetInUsdsui: 20_000_000n, // 20 USDsui — comfortably enough
};

describe("quoteUsdcSwap", () => {
  test("quotes an exact-out swap and reports the venues", async () => {
    const q = await quoteUsdcSwap({ ...BASE, cetus: stubCetus(stubRoute(10_100_000n)) });
    expect(q.amountOut).toBe(10_000_000n);
    expect(q.expectedAmountIn).toBe(10_100_000n);
    expect(q.venues).toEqual(["CETUS", "DEEPBOOKV3"]);
  });

  test("maxAmountIn inflates the quote by the slippage tolerance", async () => {
    const q = await quoteUsdcSwap({
      ...BASE,
      slippageBps: 100,
      cetus: stubCetus(stubRoute(10_000_000n)),
    });
    // 10_000_000 * 10100 / 10000
    expect(q.maxAmountIn).toBe(10_100_000n);
    expect(q.maxAmountIn).toBeGreaterThan(q.expectedAmountIn);
  });

  test("defaults to 1% slippage", async () => {
    const q = await quoteUsdcSwap({ ...BASE, cetus: stubCetus(stubRoute(10_000_000n)) });
    expect(q.maxAmountIn).toBe(10_100_000n);
  });

  test("a zero-slippage quote bounds at exactly the quoted input", async () => {
    const q = await quoteUsdcSwap({
      ...BASE,
      slippageBps: 0,
      cetus: stubCetus(stubRoute(10_000_000n)),
    });
    expect(q.maxAmountIn).toBe(10_000_000n);
  });
});

describe("budget enforcement", () => {
  test("rejects when the worst case exceeds the budget", async () => {
    // Quote fits (19.9 <= 20) but the 1% slippage ceiling does not.
    await expect(
      quoteUsdcSwap({
        ...BASE,
        budgetInUsdsui: 20_000_000n,
        cetus: stubCetus(stubRoute(19_900_000n)),
      }),
    ).rejects.toThrow(SwapBudgetExceededError);
  });

  test("accepts when the worst case exactly equals the budget", async () => {
    const q = await quoteUsdcSwap({
      ...BASE,
      budgetInUsdsui: 10_100_000n,
      cetus: stubCetus(stubRoute(10_000_000n)),
    });
    expect(q.maxAmountIn).toBe(10_100_000n);
  });

  test("the error carries both numbers for the UI", async () => {
    try {
      await quoteUsdcSwap({
        ...BASE,
        budgetInUsdsui: 1_000_000n,
        cetus: stubCetus(stubRoute(10_000_000n)),
      });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SwapBudgetExceededError);
      if (e instanceof SwapBudgetExceededError) {
        expect(e.requiredIn).toBe(10_100_000n);
        expect(e.budgetIn).toBe(1_000_000n);
      }
    }
  });

  test("rejecting happens before any order is committed", async () => {
    // The whole point: an unaffordable route must surface as a thrown quote,
    // never as a half-built PTB.
    const cetus = stubCetus(stubRoute(99_000_000n));
    await expect(quoteUsdcSwap({ ...BASE, cetus })).rejects.toBeInstanceOf(
      SwapBudgetExceededError,
    );
  });
});

describe("route failures", () => {
  test("no route at all", async () => {
    await expect(
      quoteUsdcSwap({ ...BASE, cetus: stubCetus(null) }),
    ).rejects.toThrow(AggregatorRouteError);
  });

  test("insufficient liquidity is distinguished from no route", async () => {
    const route = stubRoute(10_000_000n, { insufficientLiquidity: true });
    await expect(
      quoteUsdcSwap({ ...BASE, cetus: stubCetus(route) }),
    ).rejects.toThrow(/insufficient liquidity/);
  });

  test("aggregator error message passes through", async () => {
    const route = stubRoute(10_000_000n, { error: { code: 7, msg: "router exploded" } });
    await expect(
      quoteUsdcSwap({ ...BASE, cetus: stubCetus(route) }),
    ).rejects.toThrow(/router exploded/);
  });

  test("input validation rejects non-positive amounts", async () => {
    const cetus = stubCetus(stubRoute(1n));
    await expect(
      quoteUsdcSwap({ ...BASE, amountOutUsdc: 0n, cetus }),
    ).rejects.toThrow("amountOutUsdc must be > 0");
    await expect(
      quoteUsdcSwap({ ...BASE, budgetInUsdsui: 0n, cetus }),
    ).rejects.toThrow("budgetInUsdsui must be > 0");
  });
});

describe("appendUsdcSwapToPtb", () => {
  test("passes maxAmountIn through to the on-chain call", async () => {
    const captured: { call?: Record<string, unknown> } = {};
    const cetus = stubCetus(stubRoute(10_000_000n), captured);
    const quote = await quoteUsdcSwap({ ...BASE, cetus });

    await appendUsdcSwapToPtb({
      cetus,
      tx: {} as never,
      quote,
      inputCoin: { $kind: "Input", Input: 0 } as never,
      slippageBps: 100,
    });

    // The ceiling must reach the Move call — a TypeScript-side check cannot
    // bind a transaction that executes later against different liquidity.
    expect(captured.call?.maxAmountIn).toBe("10100000");
    expect(captured.call?.slippage).toBe(0.01);
    expect(captured.call?.partner).toBeUndefined();
  });

  test("rejects an out-of-range slippage rather than sending it on", async () => {
    const cetus = stubCetus(stubRoute(10_000_000n));
    const quote = await quoteUsdcSwap({ ...BASE, cetus });
    for (const bad of [-1, 10_001, NaN]) {
      await expect(
        appendUsdcSwapToPtb({
          cetus,
          tx: {} as never,
          quote,
          inputCoin: {} as never,
          slippageBps: bad,
        }),
      ).rejects.toThrow(/slippageBps out of range/);
    }
  });
});

describe("token constants", () => {
  test("USDC is Circle's mainnet type, not the testnet stand-in", () => {
    expect(USDC_MAINNET).toBe(
      "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    );
    expect(USDC_MAINNET).not.toBe(USDSUI.coinType);
  });
});
