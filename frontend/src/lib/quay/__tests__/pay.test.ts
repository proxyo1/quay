import { describe, test, expect } from "bun:test";

import type { AggregatorClient } from "@cetusprotocol/aggregator-sdk";

import {
  COIN_TYPES,
  buildPayAnyTokenPtb,
  encodeQuoteMetadata,
  QUOTE_METADATA_MAX_BYTES,
  QuoteMetadataTooLargeError,
} from "../pay";

describe("encodeQuoteMetadata", () => {
  test("produces an SQR1 magic header followed by JSON body", () => {
    const out = encodeQuoteMetadata({ hello: "world" });
    const text = new TextDecoder().decode(out);
    expect(text.startsWith("SQR1")).toBe(true);
    expect(text.slice(4)).toBe(JSON.stringify({ hello: "world" }));
  });

  test("typical Pyth + DEX envelope fits under the cap", () => {
    const envelope = {
      v: 1,
      src: "pyth-hermes",
      sgd_minor: 350,
      usd_sgd_id: "0xeb98b8cd9c0db987e93eb98b8cd9c0db987",
      usd_sgd_price: "74000",
      usd_sgd_expo: -5,
      usd_sgd_publish_time: 1_730_000_000,
      sui_usd_id: "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69",
      sui_usd_price: "523000",
      sui_usd_expo: -6,
      sui_usd_publish_time: 1_730_000_000,
      out_token: "0x2::sui::SUI",
      out_amount: "5340000000",
      dex: {
        venue: "cetus-aggregator",
        payer_token: "0xa1ec::usdc::USDC",
        slippage_bps: 100,
      },
    };
    const out = encodeQuoteMetadata(envelope);
    expect(out.length).toBeLessThan(QUOTE_METADATA_MAX_BYTES);
  });

  test("rejects payloads that would exceed the 2 KB cap (eng safety net)", () => {
    // Build a payload comfortably over the cap.
    const padding = "x".repeat(QUOTE_METADATA_MAX_BYTES + 100);
    expect(() => encodeQuoteMetadata({ padding })).toThrow(QuoteMetadataTooLargeError);
  });

  test("the thrown error carries the actual byte count for diagnostics", () => {
    const padding = "y".repeat(QUOTE_METADATA_MAX_BYTES);
    try {
      encodeQuoteMetadata({ padding });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(QuoteMetadataTooLargeError);
      if (e instanceof QuoteMetadataTooLargeError) {
        expect(e.actualBytes).toBeGreaterThan(QUOTE_METADATA_MAX_BYTES);
      }
    }
  });
});

/**
 * Regression cover for removing the unreachable slippage assertion at the top
 * of the aggregator branch.
 *
 * `minOutAcceptable` was derived from `outputAmount` as
 * `outputAmount * (10000 - bps) / 10000`, so it is always <= `outputAmount`
 * and `assertOutputWithinSlippage(outputAmount, minOutAcceptable)` could never
 * throw. These tests pin the surrounding behaviour so the deletion is provably
 * inert: a swap-and-pay still builds, and `minOutAcceptable` still comes back
 * with the value callers display pre-sign.
 *
 * The on-chain bound is unaffected — `appendSwapToPtb` passes `slippage` into
 * `cetus.routerSwap`, which enforces it where it cannot be bypassed.
 */
function stubAggregator(amountIn: bigint): AggregatorClient {
  return {
    findRouters: async () => ({
      amountIn: { toString: () => amountIn.toString() },
      amountOut: { toString: () => "0" },
      insufficientLiquidity: false,
      error: null,
      paths: [{ provider: "CETUS" }],
    }),
    routerSwap: async () => ({ $kind: "NestedResult", NestedResult: [0, 0] }),
  } as unknown as AggregatorClient;
}

const PAY_INPUT = {
  uen: "53014014D",
  payerCoinType: COIN_TYPES.SUI,
  merchantReceiveType: COIN_TYPES.USDSUI,
  payerCoinSource: { objectId: "0x" + "1".repeat(64) } as const,
  outputAmount: 1_000_000n,
  sgdMinorUnits: 350,
};

describe("buildPayAnyTokenPtb (post-deletion regression)", () => {
  test("a routed swap-and-pay still builds", async () => {
    const res = await buildPayAnyTokenPtb({
      ...PAY_INPUT,
      cetus: stubAggregator(5_000_000_000n),
    });
    expect(res.routedVia).toBe("aggregator");
    expect(res.expectedInputAmount).toBe(5_000_000_000n);
    expect(res.tx).toBeDefined();
  });

  test("minOutAcceptable is the slippage-adjusted output, and never above it", async () => {
    const res = await buildPayAnyTokenPtb({
      ...PAY_INPUT,
      slippageBps: 100,
      cetus: stubAggregator(5_000_000_000n),
    });
    // 1_000_000 * (10000 - 100) / 10000
    expect(res.minOutAcceptable).toBe(990_000n);
    expect(res.minOutAcceptable).toBeLessThanOrEqual(PAY_INPUT.outputAmount);
  });

  test("the deleted assertion was unreachable across the whole bps range", async () => {
    // For every valid slippage, minOutAcceptable <= outputAmount, which is the
    // condition that made the removed guard dead code.
    for (const bps of [0, 1, 50, 100, 500, 9_999, 10_000]) {
      const res = await buildPayAnyTokenPtb({
        ...PAY_INPUT,
        slippageBps: bps,
        cetus: stubAggregator(5_000_000_000n),
      });
      expect(res.minOutAcceptable).toBeLessThanOrEqual(PAY_INPUT.outputAmount);
    }
  });

  test("same-token payments still bypass the aggregator entirely", async () => {
    const res = await buildPayAnyTokenPtb({
      ...PAY_INPUT,
      merchantReceiveType: COIN_TYPES.SUI,
      cetus: stubAggregator(0n),
    });
    expect(res.routedVia).toBe("direct");
    expect(res.expectedInputAmount).toBe(PAY_INPUT.outputAmount);
    expect(res.venues).toEqual([]);
  });

  test("input validation still rejects nonsense before touching the aggregator", async () => {
    await expect(
      buildPayAnyTokenPtb({ ...PAY_INPUT, outputAmount: 0n, cetus: stubAggregator(1n) }),
    ).rejects.toThrow("outputAmount must be > 0");
    await expect(
      buildPayAnyTokenPtb({ ...PAY_INPUT, sgdMinorUnits: 0, cetus: stubAggregator(1n) }),
    ).rejects.toThrow("sgdMinorUnits must be > 0");
  });
});
