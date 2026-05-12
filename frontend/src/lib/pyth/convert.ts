import { priceAgeSeconds, type PythPrice } from "./client";

/**
 * SGD-amount → SUI-amount conversion using Pyth feeds.
 *
 * Pyth publishes FX.USD/SGD (SGD per 1 USD), not SGD/USD. We invert
 * exactly at compute time:
 *
 *   1 SGD = (1 / SGD_per_USD) USD
 *   1 SUI = USD_per_SUI USD
 *   SUI_for_X_SGD = X / SGD_per_USD / USD_per_SUI
 *
 * Result is the BASE rate from Pyth alone — actual on-chain settlement
 * goes through Cetus (Day 5) and pays swap-pool slippage on top of this.
 * The frontend displays this as the "indicative" quote.
 *
 * Edge cases:
 *   - SGD amount <= 0 → all-zero output
 *   - Either price <= 0 → throw (invalid feed)
 *
 * All math is in JS number space. This is intentional for the indicative
 * UX quote; the on-chain `pay` PTB will use BigInt + integer rounding for
 * the actual coin transfer.
 */

export interface QuoteInputs {
  /** SGD minor units (cents). $1.50 = 150. */
  sgdMinorUnits: number;
  /** Pyth FX.USD/SGD price object. */
  usdSgd: PythPrice;
  /** Pyth Crypto.SUI/USD price object. */
  suiUsd: PythPrice;
}

export interface SgdToSuiQuote {
  sgdMinorUnits: number;
  /** Decimal SGD amount, e.g., 1.50. */
  sgd: number;
  /** Equivalent USD at the FX rate. */
  usd: number;
  /** Equivalent SUI at the spot SUI/USD rate. */
  sui: number;
  /** Same as `sui` but in MIST (1 SUI = 1e9 MIST), rounded up. */
  suiMist: bigint;
  rates: {
    /** Pyth FX.USD/SGD raw output (SGD per 1 USD). */
    sgdPerUsd: number;
    /** Inverted: USD per 1 SGD. */
    usdPerSgd: number;
    /** Pyth Crypto.SUI/USD (USD per 1 SUI). */
    usdPerSui: number;
  };
  /** Max staleness across both inputs, in seconds. */
  maxAgeSeconds: number;
}

export function quoteSgdToSui(input: QuoteInputs, nowMs = Date.now()): SgdToSuiQuote {
  const { sgdMinorUnits, usdSgd, suiUsd } = input;
  if (usdSgd.price <= 0) throw new Error(`Invalid USD/SGD price: ${usdSgd.price}`);
  if (suiUsd.price <= 0) throw new Error(`Invalid SUI/USD price: ${suiUsd.price}`);

  const sgd = sgdMinorUnits / 100;
  const sgdPerUsd = usdSgd.price; // direct: SGD per 1 USD
  const usdPerSgd = 1 / sgdPerUsd; // inverted
  const usdPerSui = suiUsd.price;

  const usd = sgd * usdPerSgd;
  const sui = usd / usdPerSui;
  // Round UP so the user always sends *enough* to cover the SGD price.
  // This is a UX choice; the on-chain `pay` accepts the actual coin sent
  // and emits sgd_minor_units verbatim.
  const suiMist = sui > 0 ? BigInt(Math.ceil(sui * 1_000_000_000)) : 0n;

  return {
    sgdMinorUnits,
    sgd,
    usd,
    sui,
    suiMist,
    rates: { sgdPerUsd, usdPerSgd, usdPerSui },
    maxAgeSeconds: Math.max(priceAgeSeconds(usdSgd, nowMs), priceAgeSeconds(suiUsd, nowMs)),
  };
}

/** Format a decimal SGD amount as "$X.XX SGD". */
export function formatSgd(amount: number): string {
  return `$${amount.toFixed(2)} SGD`;
}

/** Format a decimal SUI amount with adaptive precision (4 dp for < 1, 2 dp otherwise). */
export function formatSui(amount: number): string {
  if (amount < 1) return `${amount.toFixed(4)} SUI`;
  return `${amount.toFixed(2)} SUI`;
}
