/**
 * Pyth price feed IDs (cross-chain consistent — same ID on every chain
 * where Pyth is deployed). Verified against Hermes on 2026-05-12 during
 * Day 0 testnet validation.
 *
 * IMPORTANT — quote direction:
 *
 *   FX.USD/SGD = "SGD per 1 USD"  (e.g., 1.350 → 1 USD = 1.350 SGD)
 *
 *   Pyth does NOT publish FX.SGD/USD directly. To convert SGD → USD,
 *   we invert at compute time:
 *      USD_per_SGD = 1 / SGD_per_USD
 *
 *   This is exact math, not a feed approximation. The conversion is
 *   handled in quoteSgdToSui (./convert.ts).
 *
 * Day 0 result: `scripts/day0-results.md` — Pyth pricing PASS.
 */

export const PYTH_FEEDS = {
  /** FX.USD/SGD — SGD per 1 USD. Invert for SGD → USD conversion. */
  USD_SGD: "0x396a969a9c1480fa15ed50bc59149e2c0075a72fe8f458ed941ddec48bdb4918",
  /** Crypto.SUI/USD — USD per 1 SUI. */
  SUI_USD: "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
  /** Crypto.USDC/USD — USD per 1 USDC. Used when settlement target is USDC. */
  USDC_USD: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
} as const;

export type PythFeedId = (typeof PYTH_FEEDS)[keyof typeof PYTH_FEEDS];

export const PYTH_FEED_LABELS: Record<string, string> = {
  [PYTH_FEEDS.USD_SGD]: "FX.USD/SGD",
  [PYTH_FEEDS.SUI_USD]: "Crypto.SUI/USD",
  [PYTH_FEEDS.USDC_USD]: "Crypto.USDC/USD",
};
