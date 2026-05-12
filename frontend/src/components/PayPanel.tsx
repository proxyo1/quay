"use client";

import { useMemo, useState } from "react";

import {
  PYTH_FEEDS,
  PYTH_FEED_LABELS,
  formatSgd,
  formatSui,
  isStale,
  priceAgeSeconds,
  quoteSgdToSui,
  STALE_THRESHOLD_SECONDS,
  usePythPrices,
} from "@/lib/pyth";
import { sanitizeMerchantName } from "@/lib/sgqr";

/**
 * Pay panel — shown once a registered merchant is resolved on /scan.
 *
 * Day 4 deliverable: live SGD-to-SUI quote via Pyth feeds (USD/SGD inverted +
 * SUI/USD direct). The "Pay" button is intentionally inert in this commit;
 * Day 5 wires it to a Cetus-routed swap-and-pay PTB.
 */
export function PayPanel({
  merchantAddress,
  merchantName,
  uen,
}: {
  merchantAddress: string;
  merchantName?: string;
  uen: string;
}) {
  const [sgdInput, setSgdInput] = useState("3.50");

  const feeds = useMemo(() => [PYTH_FEEDS.USD_SGD, PYTH_FEEDS.SUI_USD], []);
  const pricesQ = usePythPrices(feeds);

  const sgdMinorUnits = useMemo(() => parseSgdInput(sgdInput), [sgdInput]);

  const quote = useMemo(() => {
    if (!pricesQ.data || sgdMinorUnits <= 0) return null;
    const usdSgd = pricesQ.data.get(PYTH_FEEDS.USD_SGD);
    const suiUsd = pricesQ.data.get(PYTH_FEEDS.SUI_USD);
    if (!usdSgd || !suiUsd) return null;
    return quoteSgdToSui({ sgdMinorUnits, usdSgd, suiUsd });
  }, [pricesQ.data, sgdMinorUnits]);

  const safeName = sanitizeMerchantName(merchantName) || "merchant";
  const stale =
    quote != null && quote.maxAgeSeconds > STALE_THRESHOLD_SECONDS;

  return (
    <section className="rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10 p-5 space-y-5">
      <header>
        <p className="text-xs uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
          Registered merchant
        </p>
        <h2 className="text-2xl font-semibold mt-1">Pay {safeName}</h2>
        <p className="text-xs text-gray-500 font-mono mt-1">
          UEN {uen} → {merchantAddress.slice(0, 6)}…{merchantAddress.slice(-4)}
        </p>
      </header>

      <div className="space-y-2">
        <label htmlFor="sgd-amount" className="block text-sm font-medium">
          Amount (SGD)
        </label>
        <div className="flex items-center gap-2">
          <span className="text-2xl text-gray-500">$</span>
          <input
            id="sgd-amount"
            type="text"
            inputMode="decimal"
            value={sgdInput}
            onChange={(e) => setSgdInput(sanitizeAmountInput(e.target.value))}
            className="flex-1 rounded-md border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-2xl tabular-nums"
            placeholder="0.00"
          />
          <span className="text-sm text-gray-500">SGD</span>
        </div>
      </div>

      <QuoteDisplay
        loading={pricesQ.isLoading}
        error={pricesQ.error}
        quote={quote}
        stale={stale}
      />

      <button
        type="button"
        disabled
        title="Day 5: wires a Cetus-routed swap-and-pay PTB"
        className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium py-3 transition"
      >
        {quote ? `Pay ${formatSui(quote.sui)} for ${formatSgd(quote.sgd)}` : "Enter an SGD amount"}
        <span className="block text-xs font-normal opacity-80 mt-0.5">
          Cetus swap-and-pay PTB wires here on Day 5
        </span>
      </button>
    </section>
  );
}

function QuoteDisplay({
  loading,
  error,
  quote,
  stale,
}: {
  loading: boolean;
  error: unknown;
  quote: ReturnType<typeof quoteSgdToSui> | null;
  stale: boolean;
}) {
  if (loading && !quote) {
    return <p className="text-sm text-gray-500">Fetching live Pyth prices…</p>;
  }
  if (error) {
    return (
      <p className="text-sm text-amber-700 dark:text-amber-300">
        Pyth Hermes unreachable: {error instanceof Error ? error.message : String(error)}.
        Prices unavailable; on-chain swap (Day 5) will still work via on-chain
        Pyth update.
      </p>
    );
  }
  if (!quote) return null;

  return (
    <div className="rounded-md border border-emerald-200 dark:border-emerald-800 bg-white/60 dark:bg-black/30 p-3 text-sm space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-gray-600 dark:text-gray-400">≈ via Pyth</span>
        <span className="font-medium tabular-nums">
          {formatSui(quote.sui)}{" "}
          <span className="text-xs text-gray-500">
            ({quote.suiMist.toString()} MIST)
          </span>
        </span>
      </div>
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>= ${quote.usd.toFixed(4)} USD</span>
        <span>
          1 USD = {quote.rates.sgdPerUsd.toFixed(4)} SGD · 1 SUI = $
          {quote.rates.usdPerSui.toFixed(4)}
        </span>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-500">
          Feeds: {PYTH_FEED_LABELS[PYTH_FEEDS.USD_SGD]} ·{" "}
          {PYTH_FEED_LABELS[PYTH_FEEDS.SUI_USD]}
        </span>
        <span className={stale ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}>
          {stale
            ? `⚠ stale (${quote.maxAgeSeconds}s)`
            : `live (${quote.maxAgeSeconds}s ago)`}
        </span>
      </div>
      <p className="text-[11px] text-gray-500 pt-1 border-t border-gray-200 dark:border-gray-800">
        Indicative — Cetus swap pool slippage applies on settlement (Day 5).
      </p>
    </div>
  );
}

/** Strip non-numeric chars except '.'; keep at most one decimal point. */
function sanitizeAmountInput(s: string): string {
  let out = "";
  let sawDot = false;
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "." && !sawDot) {
      out += ".";
      sawDot = true;
    }
  }
  return out;
}

/** Convert a user-typed SGD string to minor units (cents). */
function parseSgdInput(s: string): number {
  if (!s) return 0;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}
