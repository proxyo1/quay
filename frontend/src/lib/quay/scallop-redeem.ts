/**
 * Shared Scallop redeem planning.
 *
 * Three callers need the same answer to "how much of this merchant's sCoin can
 * actually come out right now, and what does Quay charge for it?" —
 * `/api/sponsor/toggle-yield`, `/api/sponsor/earn-move`, and the Coinbase
 * cash-out flow. Before this module the first two carried separate copies of
 * the haircut arithmetic (`toggle-yield`'s private `computePartialRedeemSync`
 * and an inline block in `earn-move`) plus two definitions of
 * `MAX_COINS_PER_PTB`.
 *
 * Two things here are deliberate and worth not undoing:
 *
 * **One balance-sheet read.** `getSharePrice` and `getPoolCash` each call
 * `readBalanceSheet` independently, and every caller wanted both — two
 * uncached reads, from two different chain snapshots, feeding one division.
 * `planRedeemFromBalanceSheet` takes a single `BalanceSheet` so the numerator
 * and denominator are guaranteed to come from the same instant. Callers fetch
 * it once via `readBalanceSheet`; `readBalanceSheet`'s own docstring forbids
 * caching on this path, so sharing the snapshot is the fix, not a TTL.
 *
 * **Integer clamp arithmetic.** The old code computed
 * `BigInt(Math.floor(Number(usableCash) / sharePrice))` with `sharePrice` a JS
 * float — lossy above 2^53, and its output is an amount that gets committed
 * irreversibly (to an on-chain burn, and in the cash-out flow to a Coinbase
 * order). Given the balance sheet we can avoid floats entirely:
 *
 *     sharePrice        = (cash + debt - revenue) / marketCoinSupply
 *     sharesAtCash      = usableCash / sharePrice
 *                       = usableCash * marketCoinSupply / (cash + debt - revenue)
 *
 * which is exact bigint division. `sharePriceFloat` remains available for
 * display, where a few ulps do not matter.
 */

import type { BalanceSheet } from "@/lib/quay/scallop";

/**
 * Conservative haircut on pool cash, leaving headroom for share-price drift
 * and concurrent borrows between this read and the transaction committing.
 */
export const HAIRCUT_BPS = 100n; // 1%
const BPS_DENOM = 10_000n;

/**
 * Ceiling on coin objects merged into one PTB. A merchant's balance is
 * fragmented one coin per received payment, and past this many the merge
 * blows the transaction budget.
 */
export const MAX_COINS_PER_PTB = 50;

/** Underlying value backing the whole sCoin supply: cash + debt - revenue. */
export function totalUnderlying(bs: BalanceSheet): bigint {
  return bs.cash + bs.debt - bs.revenue;
}

/**
 * Share price as a float, for display only. Returns 1.0 for a genesis reserve
 * with no supply. Never feed this into an amount that gets committed — use the
 * integer paths below.
 */
export function sharePriceFloat(bs: BalanceSheet): number {
  if (bs.marketCoinSupply === 0n) return 1.0;
  return Number(totalUnderlying(bs)) / Number(bs.marketCoinSupply);
}

/** Pool cash minus the haircut; the most we will plan against. */
export function usableCash(bs: BalanceSheet): bigint {
  const haircut = (bs.cash * HAIRCUT_BPS) / BPS_DENOM;
  return bs.cash > haircut ? bs.cash - haircut : 0n;
}

/** Underlying (USDsui) worth of `shares`, rounded DOWN. Exact integer math. */
export function sharesToUnderlying(bs: BalanceSheet, shares: bigint): bigint {
  const supply = bs.marketCoinSupply;
  if (supply === 0n) return shares; // genesis: 1:1
  const total = totalUnderlying(bs);
  if (total <= 0n) return 0n;
  return (shares * total) / supply;
}

/** Shares needed to withdraw `underlying`, rounded UP so we never under-burn. */
export function underlyingToShares(bs: BalanceSheet, underlying: bigint): bigint {
  const total = totalUnderlying(bs);
  if (total <= 0n) return underlying; // genesis / degenerate: 1:1
  const supply = bs.marketCoinSupply;
  if (supply === 0n) return underlying;
  return (underlying * supply + total - 1n) / total;
}

export interface RedeemPlan {
  /** True when pool cash forces us to redeem less than the merchant holds. */
  partial: boolean;
  /** sCoin shares that can be burnt now. */
  redeemableShare: bigint;
  /** sCoin shares left with the merchant, still earning. */
  leftoverShare: bigint;
  /** Underlying USDsui the redeemable shares are worth, rounded down. */
  realizableUnderlying: bigint;
  /** Pool cash after the haircut, i.e. the ceiling this plan respected. */
  usableCashMinor: bigint;
  /** Share price as a float — display only. */
  sharePrice: number;
}

/**
 * Largest share amount redeemable right now, clamped by pool cash.
 *
 * A redeem of more than the reserve's `cash` aborts on chain (error
 * 81921 / 81924), and that cash is shared with every other Scallop user, so
 * this is a live constraint rather than a formality.
 */
export function planRedeemFromBalanceSheet(args: {
  /** Total sCoin shares the merchant holds. */
  shareBalance: bigint;
  balanceSheet: BalanceSheet;
  /** Optional cap in underlying terms (e.g. the merchant asked for $50). */
  requestedUnderlying?: bigint;
}): RedeemPlan {
  const { shareBalance, balanceSheet: bs } = args;
  const sharePrice = sharePriceFloat(bs);
  const cash = usableCash(bs);

  if (shareBalance === 0n) {
    return {
      partial: false,
      redeemableShare: 0n,
      leftoverShare: 0n,
      realizableUnderlying: 0n,
      usableCashMinor: cash,
      sharePrice,
    };
  }

  // Start from everything the merchant holds, then apply each ceiling in turn.
  let redeemable = shareBalance;

  if (args.requestedUnderlying !== undefined && args.requestedUnderlying >= 0n) {
    const wanted = underlyingToShares(bs, args.requestedUnderlying);
    if (wanted < redeemable) redeemable = wanted;
  }

  // Pool-cash ceiling, in shares. Exact: usableCash * supply / totalUnderlying.
  const total = totalUnderlying(bs);
  if (total > 0n && bs.marketCoinSupply > 0n) {
    const sharesAtCash = (cash * bs.marketCoinSupply) / total;
    if (sharesAtCash < redeemable) redeemable = sharesAtCash;
  }

  return {
    partial: redeemable < shareBalance,
    redeemableShare: redeemable,
    leftoverShare: shareBalance - redeemable,
    realizableUnderlying: sharesToUnderlying(bs, redeemable),
    usableCashMinor: cash,
    sharePrice,
  };
}

/** Verdict on whether a merchant's coin objects fit in one PTB. */
export interface CoinCountVerdict {
  ok: boolean;
  count: number;
  max: number;
}

export function checkCoinCount(count: number): CoinCountVerdict {
  return { ok: count <= MAX_COINS_PER_PTB, count, max: MAX_COINS_PER_PTB };
}
