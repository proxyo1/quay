"use client";

import {
  ConnectButton,
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { useMemo, useState } from "react";

import {
  PYTH_FEEDS,
  PYTH_FEED_LABELS,
  formatSgd,
  formatSui,
  priceAgeSeconds,
  quoteSgdToSui,
  STALE_THRESHOLD_SECONDS,
  usePythPrices,
} from "@/lib/pyth";
import { sanitizeMerchantName } from "@/lib/sgqr";
import { buildPaySuiTx, encodeQuoteMetadata } from "@/lib/suiqr";
import { txUrl } from "@/lib/sui-config";

type PayState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; digest: string }
  | { kind: "error"; message: string };

/**
 * Pay panel — shown once a registered merchant is resolved on /scan.
 *
 * Day 4 added the live Pyth quote. Day 5 wires the Pay button: it now
 * splits MIST off the connected wallet's gas coin, calls
 * `payments::pay<SUI>`, waits for finality, and surfaces the resulting
 * PaymentReceipt digest with a Sui explorer link.
 *
 * Day 5.5+ adds Cetus-routed swap-and-pay for non-SUI source tokens.
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
  const [memo, setMemo] = useState("");
  const [pay, setPay] = useState<PayState>({ kind: "idle" });

  const account = useCurrentAccount();
  const sui = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

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
  const stale = quote != null && quote.maxAgeSeconds > STALE_THRESHOLD_SECONDS;
  const canPay =
    !!account &&
    quote != null &&
    quote.suiMist > 0n &&
    pay.kind !== "submitting" &&
    !stale;

  async function handlePay() {
    if (!quote || !pricesQ.data) return;
    setPay({ kind: "submitting" });
    try {
      const usdSgd = pricesQ.data.get(PYTH_FEEDS.USD_SGD)!;
      const suiUsd = pricesQ.data.get(PYTH_FEEDS.SUI_USD)!;
      const meta = encodeQuoteMetadata({
        v: 1,
        src: "pyth-hermes",
        sgd_minor: quote.sgdMinorUnits,
        usd_sgd_id: PYTH_FEEDS.USD_SGD,
        usd_sgd_price: usdSgd.rawPrice,
        usd_sgd_expo: usdSgd.expo,
        usd_sgd_publish_time: usdSgd.publishTime,
        sui_usd_id: PYTH_FEEDS.SUI_USD,
        sui_usd_price: suiUsd.rawPrice,
        sui_usd_expo: suiUsd.expo,
        sui_usd_publish_time: suiUsd.publishTime,
        mist: quote.suiMist.toString(),
      });
      const tx = buildPaySuiTx({
        uen,
        mistAmount: quote.suiMist,
        sgdMinorUnits: quote.sgdMinorUnits,
        memo: memo.trim() || undefined,
        quoteMetadata: meta,
      });
      const result = await signAndExecute({
        transaction: tx,
      });
      // Wait for tx to be visible across the network before claiming success
      await sui.waitForTransaction({ digest: result.digest });
      setPay({ kind: "success", digest: result.digest });
    } catch (e) {
      setPay({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

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
            onChange={(e) => {
              setSgdInput(sanitizeAmountInput(e.target.value));
              if (pay.kind !== "idle" && pay.kind !== "submitting") setPay({ kind: "idle" });
            }}
            className="flex-1 rounded-md border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-2xl tabular-nums"
            placeholder="0.00"
            disabled={pay.kind === "submitting"}
          />
          <span className="text-sm text-gray-500">SGD</span>
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor="memo" className="block text-sm font-medium">
          Memo <span className="text-xs text-gray-500">(optional, on-chain)</span>
        </label>
        <input
          id="memo"
          type="text"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          maxLength={64}
          placeholder="chicken rice"
          className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-sm"
          disabled={pay.kind === "submitting"}
        />
      </div>

      <QuoteDisplay
        loading={pricesQ.isLoading}
        error={pricesQ.error}
        quote={quote}
        stale={stale}
      />

      {!account ? (
        <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2">
          <p className="text-sm">Connect a Sui wallet to pay.</p>
          <ConnectButton />
        </div>
      ) : (
        <PayButton state={pay} quote={quote} canPay={canPay} onClick={handlePay} />
      )}

      <PayResult state={pay} />
    </section>
  );
}

function PayButton({
  state,
  quote,
  canPay,
  onClick,
}: {
  state: PayState;
  quote: ReturnType<typeof quoteSgdToSui> | null;
  canPay: boolean;
  onClick: () => void;
}) {
  const submitting = state.kind === "submitting";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!canPay}
      className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium py-3 transition"
    >
      {submitting ? (
        "Submitting on testnet…"
      ) : quote ? (
        <>
          Pay {formatSui(quote.sui)} for {formatSgd(quote.sgd)}
          <span className="block text-xs font-normal opacity-80 mt-0.5">
            payments::pay&lt;SUI&gt; · split from gas coin · testnet
          </span>
        </>
      ) : (
        "Enter an SGD amount"
      )}
    </button>
  );
}

function PayResult({ state }: { state: PayState }) {
  if (state.kind === "idle" || state.kind === "submitting") return null;
  if (state.kind === "success") {
    return (
      <div className="rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-100 dark:bg-emerald-900/30 p-3 text-sm">
        <p className="font-medium">✓ Paid on testnet.</p>
        <p className="mt-1 text-xs">
          <a
            href={txUrl(state.digest)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-emerald-700 dark:text-emerald-300 hover:underline"
          >
            {state.digest.slice(0, 10)}…{state.digest.slice(-6)} ↗
          </a>{" "}
          — `payments::pay&lt;SUI&gt;` emitted a PaymentReceipt event.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm">
      <p className="font-medium text-red-700 dark:text-red-300">Pay failed.</p>
      <p className="mt-1 text-xs text-red-700 dark:text-red-300 break-words">
        {state.message}
      </p>
    </div>
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
            ? `⚠ stale (${quote.maxAgeSeconds}s) — refresh blocks pay`
            : `live (${quote.maxAgeSeconds}s ago)`}
        </span>
      </div>
      <p className="text-[11px] text-gray-500 pt-1 border-t border-gray-200 dark:border-gray-800">
        SUI direct path on testnet. Day 5.5+ wires Cetus swap for USDC settlement.
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
