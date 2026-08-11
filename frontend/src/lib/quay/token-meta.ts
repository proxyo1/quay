/**
 * Canonical token display metadata — one label and decimal count per coin
 * type, for every surface that renders an amount.
 *
 * This replaces four separate tables that had drifted apart: a verbatim
 * duplicate `TOKEN_DISPLAY` in both history pages, `RECEIVE_DECIMALS` /
 * `RECEIVE_LABEL` in PayPanel, and `TERMINAL_DECIMALS` in the terminal — the
 * last keyed by *symbol* rather than coin type, which is why it needed a
 * separate normalisation step to turn `USDSUI` into `USDsui` before a lookup
 * could succeed.
 *
 * Matching is on the type **suffix** (`::usdsui::USDSUI`), not the full type,
 * because the package address differs between testnet and mainnet while the
 * module and struct names do not.
 *
 * Bridge publishes USDsui's on-chain symbol as all-caps `USDSUI`; the brand
 * reads `USDsui`. The curated labels here are the reason merchants see the
 * latter.
 */

export interface TokenMeta {
  label: string;
  decimals: number;
}

/** Suffix → display metadata. Order matters only for readability. */
const BY_SUFFIX: ReadonlyArray<readonly [string, TokenMeta]> = [
  ["::sui::SUI", { label: "SUI", decimals: 9 }],
  ["::usdc::USDC", { label: "USDC", decimals: 6 }],
  ["::usdsui::USDSUI", { label: "USDsui", decimals: 6 }],
  // Scallop's sCoin wrapper is 1:1 unit-for-unit with its underlying, so it
  // shares the underlying's decimals. The amount shown is the SHARE balance;
  // recovering the underlying needs the same-tx MintEvent (see indexer.ts).
  ["::scallop_usdsui::SCALLOP_USDSUI", { label: "sUSDsui", decimals: 6 }],
  ["::usdt::USDT", { label: "USDT", decimals: 6 }],
];

/**
 * Display metadata for a coin type.
 *
 * Unknown tokens fall back to the struct name with `decimals: 0`, so an
 * unrecognised coin renders as a raw integer rather than a silently
 * mis-scaled decimal — wrong-looking beats wrong.
 */
export function tokenMeta(coinType: string): TokenMeta {
  for (const [suffix, meta] of BY_SUFFIX) {
    if (coinType.endsWith(suffix)) return meta;
  }
  const tail = coinType.split("::").at(-1) ?? coinType;
  return { label: tail, decimals: 0 };
}

/** Just the label, for callers that don't need the decimals. */
export function tokenLabel(coinType: string): string {
  return tokenMeta(coinType).label;
}

/**
 * Curated label, or `null` when the token isn't one we know about.
 *
 * The distinction matters where a better fallback exists: the payer's balance
 * picker renders arbitrary tokens and would rather show the on-chain
 * `CoinMetadata.symbol` than a struct name we happened to parse out.
 */
export function tokenLabelIfKnown(coinType: string): string | null {
  for (const [suffix, meta] of BY_SUFFIX) {
    if (coinType.endsWith(suffix)) return meta.label;
  }
  return null;
}

/** Just the decimals. */
export function tokenDecimals(coinType: string): number {
  return tokenMeta(coinType).decimals;
}

/**
 * True when a receipt's `token_type` is Scallop's sCoin wrapper — the
 * canonical signal that a payment was yield-routed.
 */
export function isYieldRoutedToken(coinType: string): boolean {
  return coinType.includes("::scallop_usdsui::SCALLOP_USDSUI");
}

/**
 * Format a minor-unit amount with its token label, e.g. `1.5 USDsui`.
 * Trailing zeros in the fraction are trimmed; a zero fraction is dropped.
 */
export function formatTokenAmount(amountMinor: bigint, coinType: string): string {
  const { label, decimals } = tokenMeta(coinType);
  return `${formatMinor(amountMinor, decimals)} ${label}`;
}

/** Format a minor-unit amount at a given precision, without a label. */
export function formatMinor(amountMinor: bigint, decimals: number): string {
  if (decimals <= 0) return amountMinor.toString();
  const divisor = 10n ** BigInt(decimals);
  const negative = amountMinor < 0n;
  const abs = negative ? -amountMinor : amountMinor;
  const whole = abs / divisor;
  const fraction = abs % divisor;
  const fracStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return negative ? `-${body}` : body;
}
