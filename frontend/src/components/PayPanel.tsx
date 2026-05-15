"use client";

import {
  ConnectButton,
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { blake2b } from "@noble/hashes/blake2.js";
import { useEffect, useMemo, useState } from "react";

import {
  PYTH_FEEDS,
  PYTH_FEED_LABELS,
  formatSgd,
  quoteSgdToSui,
  STALE_THRESHOLD_SECONDS,
  usePythPrices,
} from "@/lib/pyth";
import { sanitizeMerchantName } from "@/lib/sgqr";
import { encodeV2 } from "@/lib/sgqr/quote-metadata";
import {
  buildPayAnyTokenPtb,
  buildPaySuiTx,
  COIN_TYPES,
  deriveUenHash,
  encodeQuoteMetadata,
} from "@/lib/quay";
import { getDexClients } from "@/lib/dex/client";
import { AggregatorRouteError } from "@/lib/dex/aggregator";
import { formatBalance, useUserBalances, type UserBalance } from "@/lib/dex/balances";
import { type SupportedReceiveToken } from "@/lib/walrus/profileSchema";
import { txUrl } from "@/lib/sui-config";

type PayPhase = "uploading-receipt" | "quoting-route" | "awaiting-signature";

type PayState =
  | { kind: "idle" }
  | { kind: "submitting"; phase: PayPhase }
  | { kind: "success"; digest: string; blobId?: string; routedVia: "direct" | "aggregator" }
  | { kind: "error"; message: string };

/**
 * Display labels + decimals for the merchant's RECEIVE token. Only the curated
 * settlement set needs to live here (SUI + USDC for V0). The payer side uses
 * dynamic metadata fetched per-token via `useUserBalances`.
 */
const RECEIVE_DECIMALS: Record<SupportedReceiveToken, number> = {
  [COIN_TYPES.SUI]: 9,
  [COIN_TYPES.USDC_TESTNET]: 6,
  [COIN_TYPES.USDSUI]: 6,
};

const RECEIVE_LABEL: Record<SupportedReceiveToken, string> = {
  [COIN_TYPES.SUI]: "SUI",
  [COIN_TYPES.USDC_TESTNET]: "USDC",
  [COIN_TYPES.USDSUI]: "USDsui",
};

export function PayPanel({
  merchantAddress,
  merchantName,
  merchantReceiveType,
  uen,
}: {
  merchantAddress: string;
  merchantName?: string;
  /** Token the merchant wants to receive — read from their Walrus profile. */
  merchantReceiveType: SupportedReceiveToken;
  uen: string;
}) {
  const [sgdInput, setSgdInput] = useState("3.50");
  const [memo, setMemo] = useState("");
  /**
   * Payer-side token type. Any Sui Move type the wallet holds, not constrained
   * to the merchant-side curated list. Default lands on the merchant's
   * receive token if the user holds it; otherwise their largest balance.
   */
  const [payerCoinType, setPayerCoinType] = useState<string>(merchantReceiveType);
  const [pay, setPay] = useState<PayState>({ kind: "idle" });

  const account = useCurrentAccount();
  const sui = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const dexClients = useMemo(() => getDexClients(sui), [sui]);
  const balancesQ = useUserBalances(account?.address);
  const balances = balancesQ.data ?? [];

  /**
   * Default payer selection rule (re-applied when balances load or the wallet
   * changes): pick the merchant's preferred token when the user holds it;
   * otherwise the largest balance the user has. This keeps the happy path
   * "direct transfer, no routing fee" for users whose wallet matches.
   */
  useEffect(() => {
    if (balances.length === 0) return;
    const matching = balances.find((b) => b.coinType === merchantReceiveType);
    const target = matching ?? balances[0];
    // Only auto-switch if the user hasn't picked something that's still in
    // their balance list — avoid clobbering an intentional pick on refetch.
    if (!balances.some((b) => b.coinType === payerCoinType)) {
      setPayerCoinType(target.coinType);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balancesQ.data, merchantReceiveType]);

  const payerBalance = balances.find((b) => b.coinType === payerCoinType);
  const payerLabel = payerBalance?.symbol ?? RECEIVE_LABEL[payerCoinType as SupportedReceiveToken] ?? shortType(payerCoinType);

  const feeds = useMemo(() => [PYTH_FEEDS.USD_SGD, PYTH_FEEDS.SUI_USD], []);
  const pricesQ = usePythPrices(feeds);

  const sgdMinorUnits = useMemo(() => parseSgdInput(sgdInput), [sgdInput]);

  /** Quote in SUI terms (preserved for the existing rate display). */
  const suiQuote = useMemo(() => {
    if (!pricesQ.data || sgdMinorUnits <= 0) return null;
    const usdSgd = pricesQ.data.get(PYTH_FEEDS.USD_SGD);
    const suiUsd = pricesQ.data.get(PYTH_FEEDS.SUI_USD);
    if (!usdSgd || !suiUsd) return null;
    return quoteSgdToSui({ sgdMinorUnits, usdSgd, suiUsd });
  }, [pricesQ.data, sgdMinorUnits]);

  /**
   * The amount the merchant must receive in `merchantReceiveType`, in the
   * token's smallest units. For SUI this is MIST (1e9). For USDC this is
   * micro-USDC (1e6) computed from SGD via Pyth USD/SGD (USDC ≈ 1 USD).
   */
  const outputAmount = useMemo<bigint | null>(() => {
    if (!pricesQ.data || sgdMinorUnits <= 0) return null;
    if (merchantReceiveType === COIN_TYPES.SUI) {
      return suiQuote?.suiMist ?? null;
    }
    // USDC_TESTNET and USDSUI are both USD-pegged stables with 6 decimals,
    // so the SGD → token math is identical: convert SGD to USD via Pyth
    // USD/SGD, then express as 6-decimal micro-units. Done with raw
    // price/expo math (no Number) to keep precision on large amounts.
    if (
      merchantReceiveType === COIN_TYPES.USDC_TESTNET ||
      merchantReceiveType === COIN_TYPES.USDSUI
    ) {
      const usdSgd = pricesQ.data.get(PYTH_FEEDS.USD_SGD);
      if (!usdSgd) return null;
      // outputMicro = (sgdMinor / 100) * usdPerSgd * 1e6
      //             = sgdMinor * usdPerSgd * 10_000
      // Rearrange to integer math: multiply by 10^(4 + max(0, -expo)) then
      // divide by 10^max(0, -expo).
      const usdPerSgdScaled = BigInt(usdSgd.rawPrice);
      const expo = usdSgd.expo;
      const negExpo = expo < 0 ? -expo : 0;
      const num = BigInt(sgdMinorUnits) * usdPerSgdScaled * 10_000n;
      const denom = 10n ** BigInt(negExpo);
      const out = num / denom;
      return out > 0n ? out : null;
    }
    return null;
  }, [pricesQ.data, sgdMinorUnits, merchantReceiveType, suiQuote]);

  const isDirect = payerCoinType === merchantReceiveType;
  const safeName = sanitizeMerchantName(merchantName) || "merchant";
  const stale = suiQuote != null && suiQuote.maxAgeSeconds > STALE_THRESHOLD_SECONDS;
  const canPay =
    !!account &&
    outputAmount != null &&
    outputAmount > 0n &&
    pay.kind !== "submitting" &&
    !stale;

  async function handlePay() {
    if (!outputAmount || !pricesQ.data || !account) return;
    setPay({ kind: "submitting", phase: isDirect ? "uploading-receipt" : "quoting-route" });
    try {
      const usdSgd = pricesQ.data.get(PYTH_FEEDS.USD_SGD)!;
      const suiUsd = pricesQ.data.get(PYTH_FEEDS.SUI_USD)!;

      // Pyth quote envelope — same shape as before, with a small `dex` field
      // appended so the on-chain receipt records the routing path. The hard
      // 2 KB cap in `encodeQuoteMetadata` keeps this from bloating.
      const v1Quote = {
        v: 1,
        src: "pyth-hermes",
        sgd_minor: sgdMinorUnits,
        usd_sgd_id: PYTH_FEEDS.USD_SGD,
        usd_sgd_price: usdSgd.rawPrice,
        usd_sgd_expo: usdSgd.expo,
        usd_sgd_publish_time: usdSgd.publishTime,
        sui_usd_id: PYTH_FEEDS.SUI_USD,
        sui_usd_price: suiUsd.rawPrice,
        sui_usd_expo: suiUsd.expo,
        sui_usd_publish_time: suiUsd.publishTime,
        out_token: merchantReceiveType,
        out_amount: outputAmount.toString(),
        dex: {
          venue: isDirect ? "direct" : "cetus-aggregator",
          payer_token: payerCoinType,
          slippage_bps: 100,
        },
      };
      const v1Bytes = encodeQuoteMetadata(v1Quote);

      // ─── Direct payment path: same-token. Walrus receipt pre-upload works
      // because the on-chain `coin.value()` is exactly `outputAmount`.
      if (isDirect && merchantReceiveType === COIN_TYPES.SUI) {
        const predictedTimestampMs = Date.now();
        const receiptIdHex = predictReceiptIdHex({
          uen,
          payer: account.address,
          timestampMs: predictedTimestampMs,
          amount: outputAmount,
        });

        const receiptReq = {
          receipt_id_hex: receiptIdHex,
          payer: account.address,
          merchant: merchantAddress,
          uen_raw: uen,
          amount: outputAmount.toString(),
          token_type: merchantReceiveType,
          sgd_minor_units: sgdMinorUnits,
          timestamp_ms: predictedTimestampMs,
          quote: {
            feed: PYTH_FEEDS.SUI_USD,
            price_usd: suiQuote?.usd.toFixed(6) ?? "0",
            sgd_per_usd: suiQuote?.rates.sgdPerUsd.toFixed(6) ?? "0",
          },
          memo: memo.trim() || undefined,
        };

        const upRes = await fetch("/api/receipts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(receiptReq),
        });
        if (!upRes.ok) {
          const err = await upRes
            .json()
            .catch(() => ({ error: `HTTP ${upRes.status}` }));
          throw new Error(`receipt prep failed: ${err.error ?? `HTTP ${upRes.status}`}`);
        }
        const { blob_id: blobId } = (await upRes.json()) as { blob_id: string };

        const v2Bytes = encodeV2(v1Bytes, blobId);

        setPay({ kind: "submitting", phase: "awaiting-signature" });
        const tx = buildPaySuiTx({
          uen,
          mistAmount: outputAmount,
          sgdMinorUnits,
          memo: memo.trim() || undefined,
          quoteMetadata: v2Bytes,
        });
        const result = await signAndExecute({ transaction: tx });
        await sui.waitForTransaction({ digest: result.digest });
        setPay({ kind: "success", digest: result.digest, blobId, routedVia: "direct" });
        return;
      }

      // ─── Generic path: direct USDC, or aggregator-routed swap.
      // Walrus receipt pre-upload is skipped for aggregator paths because the
      // delivered amount can vary with positive slippage; the on-chain
      // PaymentReceipt still carries full Pyth metadata + the dex breadcrumb.
      //
      // Resolve the source-coin reference:
      //   * SUI input → "gas" sentinel (dapp-kit fills in the wallet's gas
      //     coin at sign time; buildPayAnyTokenPtb splits from tx.gas).
      //   * Non-SUI input → pick the user's largest Coin<T> object id and
      //     pass it in. If the user has zero balance of that token, bail
      //     before constructing the PTB.
      let payerCoinSource: "gas" | { objectId: string };
      if (payerCoinType === COIN_TYPES.SUI) {
        payerCoinSource = "gas";
      } else {
        const coins = await sui.getCoins({
          owner: account.address,
          coinType: payerCoinType,
        });
        if (coins.data.length === 0) {
          throw new Error(`No ${payerLabel} coins in your wallet.`);
        }
        // Pick the largest balance to maximize the chance the split succeeds.
        const largest = coins.data.reduce((a, b) =>
          BigInt(a.balance) >= BigInt(b.balance) ? a : b,
        );
        payerCoinSource = { objectId: largest.coinObjectId };
      }

      const built = await buildPayAnyTokenPtb({
        cetus: dexClients.cetusAggregator,
        uen,
        payerCoinType,
        merchantReceiveType,
        payerCoinSource,
        outputAmount,
        sgdMinorUnits,
        memo: memo.trim() || undefined,
        quoteMetadata: v1Bytes,
      });
      setPay({ kind: "submitting", phase: "awaiting-signature" });
      const result = await signAndExecute({ transaction: built.tx });
      await sui.waitForTransaction({ digest: result.digest });
      setPay({
        kind: "success",
        digest: result.digest,
        routedVia: built.routedVia,
      });
      return;
    } catch (e) {
      if (e instanceof AggregatorRouteError) {
        setPay({
          kind: "error",
          message: `${e.message}. Try a different source token or swap on Cetus first.`,
        });
        return;
      }
      setPay({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <section className="glass-card-accent rounded-3xl p-5 space-y-4 overflow-hidden">
      <header className="relative z-10 space-y-1">
        <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--accent-strong)] inline-flex items-center gap-1.5">
          <CheckBadge />
          Registered merchant
        </p>
        <h2 className="text-2xl font-semibold tracking-tight text-white">Pay {safeName}</h2>
        <p className="text-[11px] font-mono text-[var(--muted-soft)]">
          UEN {uen} → {merchantAddress.slice(0, 6)}…{merchantAddress.slice(-4)}
        </p>
        <p className="text-[11px] text-[var(--muted)] mt-1.5">
          Merchant receives in{" "}
          <span className="text-white font-medium">{RECEIVE_LABEL[merchantReceiveType]}</span>
        </p>
      </header>

      <div className="relative z-10 glass-input rounded-2xl p-4 space-y-2">
        <label htmlFor="sgd-amount" className="block text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">
          Amount
        </label>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl text-[var(--muted-soft)] font-light">$</span>
          <input
            id="sgd-amount"
            type="text"
            inputMode="decimal"
            value={sgdInput}
            onChange={(e) => {
              setSgdInput(sanitizeAmountInput(e.target.value));
              if (pay.kind !== "idle" && pay.kind !== "submitting") setPay({ kind: "idle" });
            }}
            className="flex-1 bg-transparent border-0 px-0 text-3xl tabular-nums text-white placeholder:text-[var(--muted-soft)]/60 focus:outline-none"
            placeholder="0.00"
            disabled={pay.kind === "submitting"}
          />
          <span className="text-sm text-[var(--muted-soft)]">SGD</span>
        </div>
      </div>

      {account && (
        <SourceTokenPicker
          balances={balances}
          balancesLoading={balancesQ.isLoading}
          merchantReceiveType={merchantReceiveType}
          value={payerCoinType}
          onChange={setPayerCoinType}
          disabled={pay.kind === "submitting"}
        />
      )}

      <div className="relative z-10 space-y-1.5">
        <label htmlFor="memo" className="block text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">
          Memo <span className="normal-case text-[var(--muted-soft)]">(optional, on-chain)</span>
        </label>
        <input
          id="memo"
          type="text"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          maxLength={64}
          placeholder="chicken rice"
          className="glass-input w-full px-3 py-2 text-sm"
          disabled={pay.kind === "submitting"}
        />
      </div>

      <QuoteDisplay
        loading={pricesQ.isLoading}
        error={pricesQ.error}
        quote={suiQuote}
        stale={stale}
      />

      <PreSignReceipt
        sgdMinorUnits={sgdMinorUnits}
        outputAmount={outputAmount}
        merchantReceiveType={merchantReceiveType}
        payerLabel={payerLabel}
        isDirect={isDirect}
      />

      {!account ? (
        <div className="relative z-10 glass-card-warning rounded-2xl p-3 space-y-2">
          <p className="text-sm text-amber-100">Connect a Sui wallet to pay.</p>
          <ConnectButton />
        </div>
      ) : (
        <div className="relative z-10">
          <PayButton
            state={pay}
            sgdMinorUnits={sgdMinorUnits}
            canPay={canPay}
            onClick={handlePay}
          />
        </div>
      )}

      <PayResult state={pay} />
    </section>
  );
}

function SourceTokenPicker({
  balances,
  balancesLoading,
  merchantReceiveType,
  value,
  onChange,
  disabled,
}: {
  balances: UserBalance[];
  balancesLoading: boolean;
  merchantReceiveType: SupportedReceiveToken;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}) {
  if (balancesLoading) {
    return (
      <div className="relative z-10 space-y-1.5">
        <label className="block text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">
          Pay from
        </label>
        <p className="text-xs text-[var(--muted-soft)]">Reading wallet balances…</p>
      </div>
    );
  }
  if (balances.length === 0) {
    return (
      <div className="relative z-10 space-y-1.5">
        <label className="block text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">
          Pay from
        </label>
        <p className="text-xs text-amber-300">
          Your wallet has no balances on this network. Fund some SUI to start.
        </p>
      </div>
    );
  }
  return (
    <div className="relative z-10 space-y-1.5">
      <label className="block text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">
        Pay from
      </label>
      <ul className="space-y-1" role="radiogroup" aria-label="Source token">
        {balances.map((b) => {
          const selected = value === b.coinType;
          const direct = b.coinType === merchantReceiveType;
          return (
            <li key={b.coinType}>
              <button
                type="button"
                onClick={() => onChange(b.coinType)}
                disabled={disabled}
                role="radio"
                aria-checked={selected}
                className={`w-full flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition disabled:opacity-50 backdrop-blur-md ${
                  selected
                    ? "border-[var(--accent)] bg-[var(--accent)]/12 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_0_18px_-10px_var(--accent-glow)]"
                    : "border-white/10 bg-white/[0.03] text-[var(--muted)] hover:border-white/25"
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium">{b.symbol}</span>
                  {direct && (
                    <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--success)]">
                      direct
                    </span>
                  )}
                </span>
                <span className="text-xs tabular-nums text-[var(--muted)] shrink-0">
                  {formatBalance(b.balance, b.decimals)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-[10px] text-[var(--muted-soft)]">
        Direct = no routing fee. Other tokens route via Cetus Aggregator.
      </p>
    </div>
  );
}

function PreSignReceipt({
  sgdMinorUnits,
  outputAmount,
  merchantReceiveType,
  payerLabel,
  isDirect,
}: {
  sgdMinorUnits: number;
  outputAmount: bigint | null;
  merchantReceiveType: SupportedReceiveToken;
  payerLabel: string;
  isDirect: boolean;
}) {
  if (sgdMinorUnits <= 0 || !outputAmount) return null;
  const outFormatted = formatTokenAmount(outputAmount, merchantReceiveType);
  return (
    <div className="relative z-10 glass-card rounded-2xl p-3 space-y-1.5 text-xs">
      <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--accent)]">Before you sign</p>
      <div className="relative z-10 flex items-center justify-between">
        <span className="text-[var(--muted)]">Merchant receives</span>
        <span className="font-medium tabular-nums text-white">
          {outFormatted} {RECEIVE_LABEL[merchantReceiveType]}
        </span>
      </div>
      <div className="relative z-10 flex items-center justify-between text-[var(--muted-soft)]">
        <span>You pay from</span>
        <span className="text-white">{payerLabel}</span>
      </div>
      <div className="relative z-10 flex items-center justify-between text-[var(--muted-soft)] pt-1.5 border-t border-white/5">
        <span>Route</span>
        <span className={isDirect ? "text-[var(--success)]" : "text-[var(--accent-strong)]"}>
          {isDirect ? "Direct transfer (no routing fee)" : "Cetus Aggregator (≤1% slippage)"}
        </span>
      </div>
    </div>
  );
}

function PayButton({
  state,
  sgdMinorUnits,
  canPay,
  onClick,
}: {
  state: PayState;
  sgdMinorUnits: number;
  canPay: boolean;
  onClick: () => void;
}) {
  const submitting = state.kind === "submitting";
  const phaseLabel =
    state.kind === "submitting"
      ? state.phase === "uploading-receipt"
        ? "Preparing receipt on Walrus…"
        : state.phase === "quoting-route"
        ? "Quoting route on Cetus Aggregator…"
        : "Awaiting wallet signature…"
      : null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!canPay}
      className="glass-btn-primary group w-full"
    >
      {submitting ? (
        <span className="flex items-center gap-2">
          <Spinner /> {phaseLabel}
        </span>
      ) : sgdMinorUnits > 0 ? (
        <>
          <span>Pay {formatSgd(sgdMinorUnits / 100)}</span>
          <span className="text-white/80 group-hover:text-white transition">→</span>
        </>
      ) : (
        <span>Enter an SGD amount</span>
      )}
    </button>
  );
}

function PayResult({ state }: { state: PayState }) {
  if (state.kind === "idle" || state.kind === "submitting") return null;
  if (state.kind === "success") {
    return (
      <div className="relative z-10 glass-card-success rounded-2xl p-4 space-y-2 glass-rise">
        <p className="text-sm font-medium text-white inline-flex items-center gap-2">
          <span className="text-[var(--success)]">
            <CheckIcon />
          </span>
          Paid on testnet · {state.routedVia === "direct" ? "direct transfer" : "via Cetus Aggregator"}
        </p>
        <p className="text-xs text-[var(--muted)]">
          <a
            href={txUrl(state.digest)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[var(--accent)] hover:underline"
          >
            {state.digest.slice(0, 10)}…{state.digest.slice(-6)} ↗
          </a>
        </p>
        {state.blobId && (
          <p className="text-xs">
            <a
              href={`/verify/${encodeURIComponent(state.blobId)}`}
              className="text-[var(--accent)] hover:underline inline-flex items-center gap-1.5"
            >
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
              Verify receipt →
            </a>{" "}
            <span className="text-[var(--muted-soft)] font-mono">
              ({state.blobId.slice(0, 8)}…{state.blobId.slice(-6)})
            </span>
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="relative z-10 glass-card-danger rounded-2xl p-4 space-y-1">
      <p className="text-sm font-medium text-red-200">Pay failed</p>
      <p className="text-xs text-red-200/80 break-words">{state.message}</p>
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
    return <p className="relative z-10 text-xs text-[var(--muted-soft)]">Fetching live Pyth prices…</p>;
  }
  if (error) {
    return (
      <p className="relative z-10 text-xs text-amber-300">
        Pyth Hermes unreachable: {error instanceof Error ? error.message : String(error)}.
      </p>
    );
  }
  if (!quote) return null;

  return (
    <div className="relative z-10 glass-card rounded-2xl p-3 space-y-1.5 text-xs">
      <div className="relative z-10 flex items-center justify-between text-[var(--muted-soft)]">
        <span>1 SUI = ${quote.rates.usdPerSui.toFixed(4)} USD</span>
        <span>1 USD = {quote.rates.sgdPerUsd.toFixed(4)} SGD</span>
      </div>
      <div className="relative z-10 flex items-center justify-between pt-1.5 border-t border-white/5">
        <span className="text-[var(--muted-soft)]">
          {PYTH_FEED_LABELS[PYTH_FEEDS.USD_SGD]} · {PYTH_FEED_LABELS[PYTH_FEEDS.SUI_USD]}
        </span>
        <span
          className={
            stale ? "text-amber-300 inline-flex items-center gap-1.5" : "text-[var(--success)] inline-flex items-center gap-1.5"
          }
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              stale ? "bg-amber-300" : "bg-[var(--success)] live-dot"
            }`}
          />
          {stale ? `stale (${quote.maxAgeSeconds}s)` : `live (${quote.maxAgeSeconds}s ago)`}
        </span>
      </div>
    </div>
  );
}

function CheckBadge() {
  return (
    <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[var(--accent)]/35 border border-[var(--accent)]/55 shadow-[inset_0_1px_0_rgba(255,255,255,0.32)]">
      <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

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

function parseSgdInput(s: string): number {
  if (!s) return 0;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

function formatTokenAmount(amount: bigint, token: SupportedReceiveToken): string {
  const decimals = RECEIVE_DECIMALS[token];
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  const fracStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

function shortType(coinType: string): string {
  const idx = coinType.lastIndexOf("::");
  return idx >= 0 ? coinType.slice(idx + 2) : coinType;
}

function predictReceiptIdHex(input: {
  uen: string;
  payer: string;
  timestampMs: number;
  amount: bigint;
}): string {
  const uenHash = deriveUenHash(input.uen);
  const payerBytes = hexAddrToBytes(input.payer);
  const tsBytes = u64Le(BigInt(input.timestampMs));
  const amountBytes = u64Le(input.amount);

  const buf = new Uint8Array(uenHash.length + 32 + 8 + 8);
  let off = 0;
  buf.set(uenHash, off);
  off += uenHash.length;
  buf.set(payerBytes, off);
  off += 32;
  buf.set(tsBytes, off);
  off += 8;
  buf.set(amountBytes, off);

  const hash = blake2b(buf, { dkLen: 32 });
  return Array.from(hash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexAddrToBytes(addr: string): Uint8Array {
  const hex = addr.replace(/^0x/, "").padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function u64Le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
