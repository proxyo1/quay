/**
 * USDsui → USDC swap leg for the Coinbase cash-out rail.
 *
 * Coinbase cannot receive USDsui, so a merchant's balance has to become USDC
 * on Sui before it can be sold. This is exact-out: Coinbase commits the
 * merchant to delivering a specific `sell_amount` of USDC, and the swap must
 * produce exactly that.
 *
 * Exact-out is what makes the max-in bound necessary. The route decides how
 * much USDsui it needs, and if liquidity thins between quoting and signing it
 * needs *more* — potentially more than the merchant actually freed up. On the
 * payment path that is tolerable (the payer just pays more of their own coin);
 * here the input is a fixed budget, and overshooting it means the transaction
 * fails late or eats funds earmarked elsewhere. `routerSwapWithMaxAmountIn`
 * (added in aggregator-sdk 1.6.x) enforces the ceiling on chain.
 *
 * This is the only place a max-in bound belongs. The payment path deliberately
 * has none — see the note in `pay.ts` where the unreachable pre-sign assertion
 * was removed.
 */

import type { AggregatorClient } from "@cetusprotocol/aggregator-sdk";
import type { Transaction, TransactionObjectArgument } from "@mysten/sui/transactions";

import { AggregatorRouteError, quoteRoute } from "@/lib/dex/aggregator";
import { USDSUI } from "@/lib/quay/scallop";

/**
 * Circle's native USDC on Sui mainnet.
 *
 * Verified against mainnet, and independently corroborated by the CDP
 * `/onramp/v1/sell/options` probe, which reports this exact type as the
 * `contract_address` for USDC on the `sui` network. Note this is NOT
 * `COIN_TYPES.USDC_TESTNET`, which is Mysten's testnet stablecoin and
 * explicitly not Circle USDC.
 */
export const USDC_MAINNET =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

/** USDC is 6-decimal, same as USDsui. */
export const USDC_DECIMALS = 6;

export class SwapBudgetExceededError extends Error {
  readonly requiredIn: bigint;
  readonly budgetIn: bigint;
  constructor(requiredIn: bigint, budgetIn: bigint) {
    super(
      `swap needs ${requiredIn} USDsui microunits but only ${budgetIn} is available`,
    );
    this.name = "SwapBudgetExceededError";
    this.requiredIn = requiredIn;
    this.budgetIn = budgetIn;
  }
}

export interface UsdcSwapQuote {
  /** USDC the swap will deliver (exact-out target). */
  amountOut: bigint;
  /** USDsui the route expects to consume. */
  expectedAmountIn: bigint;
  /**
   * Hard ceiling passed to the on-chain swap: `expectedAmountIn` inflated by
   * the slippage tolerance, then capped at the caller's budget.
   */
  maxAmountIn: bigint;
  /** Venue breadcrumb for the pre-sign disclosure. */
  venues: string[];
  /** Opaque route, handed straight back to `appendUsdcSwapToPtb`. */
  route: unknown;
}

/**
 * Quote a USDsui → USDC swap for an exact USDC output, bounded by a budget.
 *
 * Throws `SwapBudgetExceededError` when even the optimistic quote exceeds the
 * budget, so the caller can refuse *before* committing the merchant to a
 * Coinbase order. Throws `AggregatorRouteError` when no route exists.
 */
export async function quoteUsdcSwap(input: {
  cetus: AggregatorClient;
  /** Exact USDC (6dp minor units) the merchant must deliver. */
  amountOutUsdc: bigint;
  /** USDsui microunits available to spend. */
  budgetInUsdsui: bigint;
  /** Slippage tolerance in bps; defaults to 1%. */
  slippageBps?: number;
}): Promise<UsdcSwapQuote> {
  if (input.amountOutUsdc <= 0n) throw new Error("amountOutUsdc must be > 0");
  if (input.budgetInUsdsui <= 0n) throw new Error("budgetInUsdsui must be > 0");

  const slippageBps = input.slippageBps ?? 100;
  const quote = await quoteRoute(input.cetus, {
    inputCoinType: USDSUI.coinType,
    outputCoinType: USDC_MAINNET,
    amountOut: input.amountOutUsdc,
  });

  if (quote.kind === "direct") {
    // Only reachable if USDsui and USDC were ever configured to the same type.
    throw new AggregatorRouteError(
      USDSUI.coinType,
      USDC_MAINNET,
      "input and output token are the same",
    );
  }

  // Inflate the quoted input by the slippage tolerance — that is the worst
  // case the route may actually consume — then refuse if it will not fit.
  const worstCaseIn =
    (quote.amountIn * BigInt(10_000 + slippageBps)) / 10_000n;
  if (worstCaseIn > input.budgetInUsdsui) {
    throw new SwapBudgetExceededError(worstCaseIn, input.budgetInUsdsui);
  }

  return {
    amountOut: input.amountOutUsdc,
    expectedAmountIn: quote.amountIn,
    maxAmountIn: worstCaseIn,
    venues: quote.venues,
    route: quote.route,
  };
}

/**
 * Append the bounded swap to a PTB and return the resulting `Coin<USDC>`.
 *
 * Uses `routerSwapWithMaxAmountIn` so the ceiling is enforced by the Move
 * call, not merely checked in TypeScript before signing — a client-side check
 * cannot bind a transaction that executes later against different liquidity.
 */
export async function appendUsdcSwapToPtb(input: {
  cetus: AggregatorClient;
  tx: Transaction;
  quote: UsdcSwapQuote;
  /** `Coin<USDsui>` already split off in the same PTB. */
  inputCoin: TransactionObjectArgument;
  slippageBps?: number;
}): Promise<TransactionObjectArgument> {
  const slippageBps = input.slippageBps ?? 100;
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps out of range [0, 10000]: ${slippageBps}`);
  }

  // The SDK takes slippage as a decimal fraction and maxAmountIn as a BN; a
  // bigint's decimal string is accepted where a BN is expected.
  return input.cetus.routerSwapWithMaxAmountIn({
    router: input.quote.route,
    inputCoin: input.inputCoin,
    slippage: slippageBps / 10_000,
    txb: input.tx,
    maxAmountIn: input.quote.maxAmountIn.toString(),
    // `partner` intentionally unset — QUAY_TREASURY_ADDRESS is a wallet
    // address, not a Cetus Partner object id, and passing it makes the SDK
    // throw "Invalid Sui address".
  } as Parameters<AggregatorClient["routerSwapWithMaxAmountIn"]>[0]);
}
