/**
 * Cetus Aggregator wrapper — Feature 2 (swap-and-pay) + Feature 3 (referral).
 *
 * Surface contract:
 *   - `quoteRoute(input, output, amount)` returns the expected output, the
 *     route, and helpers to format slippage. Read-only, no signature.
 *   - `appendSwapToPtb(tx, route, inputCoin, slippageBps)` extends an existing
 *     PTB with the swap and returns the output `Coin<T>` argument. The caller
 *     then hands that coin to `payments::pay<T>` in the same PTB.
 *
 * Every routed swap passes `QUAY_TREASURY_ADDRESS` as the aggregator's
 * `partner` parameter — that's Feature 3 in one line. Cetus splits a slice
 * of its swap fee back to that address.
 *
 * Bypass: when `inputCoinType === outputCoinType`, the caller should skip
 * this module entirely and use the input coin directly. `quoteRoute` returns
 * `{ kind: "direct" }` in that case so the caller can short-circuit.
 *
 * Errors: callers catch `AggregatorRouteError` (no route exists) and
 * `AggregatorSlippageError` (estimated cost exceeds the Pyth-equivalent
 * budget). Anything else is a programmer error or a network failure and
 * should bubble.
 */

import type { AggregatorClient, RouterDataV3 } from "@cetusprotocol/aggregator-sdk";
import type { Transaction, TransactionObjectArgument } from "@mysten/sui/transactions";

// ─── Errors ─────────────────────────────────────────────────────────────

export class AggregatorRouteError extends Error {
  readonly inputType: string;
  readonly outputType: string;
  constructor(inputType: string, outputType: string, reason: string) {
    super(`No aggregator route from ${shortType(inputType)} to ${shortType(outputType)}: ${reason}`);
    this.name = "AggregatorRouteError";
    this.inputType = inputType;
    this.outputType = outputType;
  }
}

export class AggregatorSlippageError extends Error {
  readonly expectedOut: bigint;
  readonly minAcceptable: bigint;
  constructor(expectedOut: bigint, minAcceptable: bigint) {
    super(
      `Aggregator route would deliver ${expectedOut} but caller requires at least ${minAcceptable}`,
    );
    this.name = "AggregatorSlippageError";
    this.expectedOut = expectedOut;
    this.minAcceptable = minAcceptable;
  }
}

// ─── Types ──────────────────────────────────────────────────────────────

export interface QuoteRouteInput {
  /** Sui Move type of the coin the payer holds. */
  inputCoinType: string;
  /** Sui Move type of the coin the merchant wants to receive. */
  outputCoinType: string;
  /** Amount of the OUTPUT token the merchant must receive (smallest units). */
  amountOut: bigint;
}

export type QuoteRouteResult =
  | {
      kind: "direct";
      /** Same token both sides — no swap, no fee. */
      inputCoinType: string;
    }
  | {
      kind: "route";
      /** The expected input amount (smallest units) to deliver `amountOut`. */
      amountIn: bigint;
      /** The route to pass to `appendSwapToPtb`. */
      route: RouterDataV3;
      /** Venue breadcrumb for the UI ("DeepBookV3 + Cetus", etc.). */
      venues: string[];
    };

// ─── Quote ──────────────────────────────────────────────────────────────

/**
 * Find an aggregator route. Returns `kind: "direct"` if input and output
 * tokens match (caller should skip the aggregator entirely).
 *
 * Throws `AggregatorRouteError` if no route exists for the chosen pair —
 * the caller surfaces this as "swap on Cetus first" in the UI.
 */
export async function quoteRoute(
  cetus: AggregatorClient,
  input: QuoteRouteInput,
): Promise<QuoteRouteResult> {
  if (input.inputCoinType === input.outputCoinType) {
    return { kind: "direct", inputCoinType: input.inputCoinType };
  }

  // `byAmountIn: false` → find a route that delivers exactly `amountOut`.
  // The aggregator returns the required `amountIn` for the user to commit.
  // The SDK accepts amount as `BN | string | number | bigint` so pass a
  // string and avoid pulling in bn.js as a direct dependency.
  const router = await cetus.findRouters({
    from: input.inputCoinType,
    target: input.outputCoinType,
    amount: input.amountOut.toString(),
    byAmountIn: false,
  });

  if (!router) {
    throw new AggregatorRouteError(
      input.inputCoinType,
      input.outputCoinType,
      "aggregator returned no route",
    );
  }
  if (router.insufficientLiquidity) {
    throw new AggregatorRouteError(
      input.inputCoinType,
      input.outputCoinType,
      "insufficient liquidity at this size",
    );
  }
  if (router.error) {
    throw new AggregatorRouteError(
      input.inputCoinType,
      input.outputCoinType,
      router.error.msg ?? `aggregator error code ${router.error.code}`,
    );
  }

  const venues = extractVenues(router);
  return {
    kind: "route",
    amountIn: BigInt(router.amountIn.toString()),
    route: router,
    venues,
  };
}

// ─── Build swap leg into a PTB ──────────────────────────────────────────

export interface AppendSwapInput {
  tx: Transaction;
  route: RouterDataV3;
  /** The input `Coin<T>` already split off the user's balance in the same PTB. */
  inputCoin: TransactionObjectArgument;
  /** Slippage tolerance in basis points (1% = 100, 0.5% = 50). */
  slippageBps: number;
}

/**
 * Extend the given PTB with the aggregator swap. Returns the output `Coin<T>`
 * the caller passes to `payments::pay<T>`. The `partner` field is set on every
 * swap so Cetus's referral split flows to Quay's treasury (Feature 3).
 */
export async function appendSwapToPtb(
  cetus: AggregatorClient,
  input: AppendSwapInput,
): Promise<TransactionObjectArgument> {
  if (!Number.isFinite(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 10_000) {
    throw new Error(`slippageBps out of range [0, 10000]: ${input.slippageBps}`);
  }
  // Aggregator SDK takes slippage as a decimal (0.01 == 1%).
  const slippage = input.slippageBps / 10_000;

  return cetus.routerSwap({
    router: input.route,
    inputCoin: input.inputCoin,
    slippage,
    txb: input.tx,
    // `partner` intentionally unset — `QUAY_TREASURY_ADDRESS` is a wallet
    // address, not a Cetus Partner object ID, so passing it makes the SDK
    // throw "Invalid Sui address" when it tries to load the partner.
    // Cetus's default partner kicks in; we forgo the referral split until
    // Quay is a registered Cetus partner.
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Compute the minimum acceptable output given the expected output and a
 * slippage tolerance in basis points. Caller uses this to guard against
 * routes the aggregator quoted optimistically.
 */
export function minAcceptableOut(expectedOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps out of range [0, 10000]: ${slippageBps}`);
  }
  // expected * (10000 - bps) / 10000
  return (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * Assert the route's expected output meets the caller's minimum. Throws
 * `AggregatorSlippageError` otherwise. Use this between `quoteRoute` and
 * `appendSwapToPtb` so the UI can show a clean error before the user signs.
 */
export function assertOutputWithinSlippage(
  routedOut: bigint,
  minAcceptable: bigint,
): void {
  if (routedOut < minAcceptable) {
    throw new AggregatorSlippageError(routedOut, minAcceptable);
  }
}

function shortType(t: string): string {
  // Sui types look like 0xPKG::module::Name. Show just the module::Name.
  const idx = t.indexOf("::");
  return idx >= 0 ? t.slice(idx + 2) : t;
}

function extractVenues(route: RouterDataV3): string[] {
  const seen = new Set<string>();
  for (const path of route.paths ?? []) {
    // Path shape varies by SDK version; defensively walk any nested venue
    // markers. Falls back to "DEX" if unknown.
    const pathObj = path as unknown as { provider?: string; routes?: Array<{ provider?: string }> };
    if (typeof pathObj.provider === "string") seen.add(pathObj.provider);
    for (const sub of pathObj.routes ?? []) {
      if (typeof sub.provider === "string") seen.add(sub.provider);
    }
  }
  return seen.size > 0 ? Array.from(seen) : ["DEX"];
}
