/**
 * Money formatting and payout caps, shared by client and server.
 *
 * These lived in `lib/server/cashout-fee.ts`, which is `server-only` in
 * spirit and slated for deletion with the Wise cash-out demo (TODOS). A
 * client component was already importing `formatSgdMinor` from there, and
 * the Coinbase cash-out rail — whose whole point is outliving that demo —
 * must not inherit the dependency. So the generic pieces move here and
 * `cashout-fee.ts` keeps only its Wise-specific quote math.
 *
 * Deliberately free of `server-only` so client components can import it.
 */

/**
 * Format SGD cents as a display string: `13416n` → `"134.16"`.
 * Always two decimal places, which is what a currency amount should show
 * even when the cents are zero.
 */
export function formatSgdMinor(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const dollars = abs / 100n;
  const cents = abs % 100n;
  return `${negative ? "-" : ""}${dollars}.${cents.toString().padStart(2, "0")}`;
}

/** USDsui is a 6-decimal token; its minor unit is a microunit. */
export const USDSUI_DECIMALS = 6;

/**
 * Format USDsui microunits for display, trimming trailing zeros.
 * `1_500_000n` → `"1.5"`.
 */
export function formatUsdsuiMinor(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const divisor = 10n ** BigInt(USDSUI_DECIMALS);
  const whole = abs / divisor;
  const fraction = abs % divisor;
  const fracStr = fraction
    .toString()
    .padStart(USDSUI_DECIMALS, "0")
    .replace(/0+$/, "");
  const body = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/**
 * Parse a user-typed USDsui amount into microunits, or `null` if invalid.
 *
 * Strict on purpose: a leading-dot (`.5`), a trailing-dot (`5.`), or more
 * than 6 decimal places are all rejected rather than coerced. For a money
 * input, telling the merchant the amount is malformed beats silently
 * truncating precision they deliberately typed.
 */
export function parseUsdsuiToMinor(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const padded = frac.padEnd(USDSUI_DECIMALS, "0");
  try {
    return BigInt(whole) * 10n ** BigInt(USDSUI_DECIMALS) + BigInt(padded);
  } catch {
    return null;
  }
}

/** Full-precision (6dp) USDsui string — round-trips through `parseUsdsuiToMinor`. */
export function formatUsdsuiExact(minor: bigint): string {
  const divisor = 10n ** BigInt(USDSUI_DECIMALS);
  return `${minor / divisor}.${(minor % divisor).toString().padStart(USDSUI_DECIMALS, "0")}`;
}

// ─── Per-transaction payout caps ────────────────────────────────────────
//
// Safety rails for the real-money paths: a fat-fingered amount or a bug can
// never move more than this in one transaction. Server-side only in effect —
// clients never enforce a cap.

/** Default per-cash-out SGD cap (cents). S$50.00. */
export const DEFAULT_CASHOUT_MAX_SGD_MINOR = 5000n;

function capFromEnv(raw: string | undefined, fallback: bigint): bigint {
  if (!raw) return fallback;
  try {
    const v = BigInt(raw);
    return v > 0n ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Per-cash-out SGD cap for the Wise rail, from `CASHOUT_MAX_SGD_MINOR`. */
export function cashoutCapMinor(): bigint {
  return capFromEnv(process.env.CASHOUT_MAX_SGD_MINOR, DEFAULT_CASHOUT_MAX_SGD_MINOR);
}

/**
 * Per-cash-out SGD cap for the Coinbase offramp rail, from
 * `COINBASE_OFFRAMP_MAX_SGD_MINOR`. Separate knob from the Wise cap because
 * the two rails are independently flagged and have different risk profiles —
 * there is no offramp sandbox, so every end-to-end test is real money.
 */
export function coinbaseOfframpCapMinor(): bigint {
  return capFromEnv(
    process.env.COINBASE_OFFRAMP_MAX_SGD_MINOR,
    DEFAULT_CASHOUT_MAX_SGD_MINOR,
  );
}
