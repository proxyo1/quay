/**
 * Cash-out quote math. Pure + unit-tested — no I/O here.
 *
 * USDsui is a 1:1 USD stablecoin, so the only conversion is USD->SGD via
 * the Pyth FX.USD/SGD rate (SGD per 1 USD). Quay takes a 25 bps FX fee:
 * the merchant receives 99.75% of the SGD value and Quay keeps the spread
 * (no separate transfer — Quay holds 100% of the USDsui, disburses 99.75%
 * of its SGD worth).
 *
 * All money returned as integer minor units (USDsui microunits in, SGD
 * cents out) to avoid float drift in anything that touches the payout.
 */

export const QUAY_FEE_BPS = 25; // 0.25%
export const USDSUI_DECIMALS = 6;

/**
 * Max age we accept for the Pyth USD/SGD rate, in seconds.
 *
 * FX feeds do NOT update on weekends/holidays (markets are closed), so the
 * crypto-grade 60s staleness gate wrongly rejects a perfectly good Friday
 * close every weekend ("exchange rate unavailable"). 8 days comfortably
 * covers a long weekend + public holidays while still rejecting a truly
 * dead feed. The rate barely moves, and Quay carries the tiny drift (it
 * also keeps the 25 bps), so a slightly-old FX print is fine to quote on.
 */
export const FX_RATE_MAX_AGE_SECONDS = 8 * 24 * 60 * 60;

export interface CashoutQuote {
  amountUsdsuiMinor: bigint;
  /** Pyth FX.USD/SGD: SGD per 1 USD. */
  rateSgdPerUsd: number;
  feeBps: number;
  /** SGD value before fee, in cents. */
  grossSgdMinor: bigint;
  /** Quay's fee, in SGD cents. */
  feeSgdMinor: bigint;
  /** What the merchant receives, in SGD cents. */
  netSgdMinor: bigint;
}

/**
 * Compute the locked cash-out quote. Throws on non-positive amount/rate or
 * a net that rounds to zero (dust) so we never present a S$0.00 payout.
 */
export function computeCashoutQuote(
  amountUsdsuiMinor: bigint,
  rateSgdPerUsd: number,
  feeBps: number = QUAY_FEE_BPS,
): CashoutQuote {
  if (amountUsdsuiMinor <= 0n) throw new Error("amount must be > 0");
  if (!(rateSgdPerUsd > 0) || !Number.isFinite(rateSgdPerUsd)) {
    throw new Error("invalid USD/SGD rate");
  }
  if (feeBps < 0 || feeBps >= 10000) throw new Error("feeBps out of range");

  const usd = Number(amountUsdsuiMinor) / 10 ** USDSUI_DECIMALS;
  const grossSgdMinor = BigInt(Math.round(usd * rateSgdPerUsd * 100));
  const feeSgdMinor = BigInt(Math.round(Number(grossSgdMinor) * (feeBps / 10000)));
  const netSgdMinor = grossSgdMinor - feeSgdMinor;

  if (netSgdMinor <= 0n) throw new Error("amount too small to cash out");

  return { amountUsdsuiMinor, rateSgdPerUsd, feeBps, grossSgdMinor, feeSgdMinor, netSgdMinor };
}

/** Format SGD cents as a display string, e.g. 13416n -> "134.16". */
export function formatSgdMinor(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const dollars = abs / 100n;
  const cents = abs % 100n;
  return `${neg ? "-" : ""}${dollars}.${cents.toString().padStart(2, "0")}`;
}
