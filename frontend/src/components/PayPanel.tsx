"use client";

import {
  ConnectButton,
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { blake2b } from "@noble/hashes/blake2.js";
import { useMemo, useState } from "react";

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
import {
  RECEIVE_TOKEN_OPTIONS,
  type SupportedReceiveToken,
} from "@/lib/walrus/profileSchema";
import { txUrl } from "@/lib/sui-config";

type PayPhase = "uploading-receipt" | "quoting-route" | "awaiting-signature";

type PayState =
  | { kind: "idle" }
  | { kind: "submitting"; phase: PayPhase }
  | { kind: "success"; digest: string; blobId?: string; routedVia: "direct" | "aggregator" }
  | { kind: "error"; message: string };

const COIN_DECIMALS: Record<SupportedReceiveToken, number> = {
  [COIN_TYPES.SUI]: 9,
  [COIN_TYPES.USDC_TESTNET]: 6,
};

const COIN_LABEL: Record<SupportedReceiveToken, string> = {
  [COIN_TYPES.SUI]: "SUI",
  [COIN_TYPES.USDC_TESTNET]: "USDC",
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
  const [payerCoinType, setPayerCoinType] = useState<SupportedReceiveToken>(merchantReceiveType);
  const [pay, setPay] = useState<PayState>({ kind: "idle" });

  const account = useCurrentAccount();
  const sui = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const dexClients = useMemo(() => getDexClients(sui), [sui]);

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
    if (merchantReceiveType === COIN_TYPES.USDC_TESTNET) {
      const usdSgd = pricesQ.data.get(PYTH_FEEDS.USD_SGD);
      if (!usdSgd) return null;
      // usdSgd is "USD per 1 SGD" (e.g., ~0.74). USDC ≈ USD.
      // outputUsdcMicro = (sgdMinor / 100) * usdPerSgd * 1e6
      //                 = sgdMinor * usdPerSgd * 10_000
      // Use raw price/expo math to avoid Number precision loss on big amounts.
      const usdPerSgdScaled = BigInt(usdSgd.rawPrice); // signed in SDK; raw is u64
      const expo = usdSgd.expo; // typically negative
      // outputUsdcMicro = sgdMinor * (rawPrice * 10^expo) * 10_000
      // Rearrange to integer math: multiply by 10^(4 + max(0, -expo)) then divide by 10^max(0, -expo).
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
          throw new Error(`No ${COIN_LABEL[payerCoinType]} coins in your wallet.`);
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
    <section className="relative rounded-3xl border border-[var(--accent)]/30 bg-gradient-to-b from-[var(--accent)]/[0.07] to-transparent p-5 space-y-4 overflow-hidden">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(400px_200px_at_50%_-50px,var(--accent-glow),transparent_60%)]" />
      <header className="space-y-1">
        <p className="text-[11px] uppercase tracking-wider text-[var(--accent)] inline-flex items-center gap-1.5">
          <CheckBadge />
          Registered merchant
        </p>
        <h2 className="text-2xl font-semibold tracking-tight">Pay {safeName}</h2>
        <p className="text-[11px] font-mono text-neutral-500">
          UEN {uen} → {merchantAddress.slice(0, 6)}…{merchantAddress.slice(-4)}
        </p>
        <p className="text-[11px] text-neutral-400 mt-1.5">
          Merchant receives in{" "}
          <span className="text-white font-medium">{COIN_LABEL[merchantReceiveType]}</span>
        </p>
      </header>

      <div className="rounded-2xl border border-white/10 bg-black/30 p-4 space-y-2">
        <label htmlFor="sgd-amount" className="block text-[11px] uppercase tracking-wider text-neutral-500">
          Amount
        </label>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl text-neutral-500 font-light">$</span>
          <input
            id="sgd-amount"
            type="text"
            inputMode="decimal"
            value={sgdInput}
            onChange={(e) => {
              setSgdInput(sanitizeAmountInput(e.target.value));
              if (pay.kind !== "idle" && pay.kind !== "submitting") setPay({ kind: "idle" });
            }}
            className="flex-1 bg-transparent border-0 px-0 text-3xl tabular-nums text-white placeholder:text-neutral-700 focus:outline-none"
            placeholder="0.00"
            disabled={pay.kind === "submitting"}
          />
          <span className="text-sm text-neutral-500">SGD</span>
        </div>
      </div>

      <SourceTokenPicker
        value={payerCoinType}
        onChange={setPayerCoinType}
        disabled={pay.kind === "submitting"}
      />

      <div className="space-y-1.5">
        <label htmlFor="memo" className="block text-[11px] uppercase tracking-wider text-neutral-500">
          Memo <span className="normal-case text-neutral-600">(optional, on-chain)</span>
        </label>
        <input
          id="memo"
          type="text"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          maxLength={64}
          placeholder="chicken rice"
          className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-neutral-600 focus:border-[var(--accent)]/50 focus:outline-none transition"
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
        payerCoinType={payerCoinType}
        isDirect={isDirect}
      />

      {!account ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
          <p className="text-sm text-amber-100">Connect a Sui wallet to pay.</p>
          <ConnectButton />
        </div>
      ) : (
        <PayButton
          state={pay}
          sgdMinorUnits={sgdMinorUnits}
          canPay={canPay}
          onClick={handlePay}
        />
      )}

      <PayResult state={pay} />
    </section>
  );
}

function SourceTokenPicker({
  value,
  onChange,
  disabled,
}: {
  value: SupportedReceiveToken;
  onChange: (next: SupportedReceiveToken) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] uppercase tracking-wider text-neutral-500">
        Pay from
      </label>
      <div className="grid grid-cols-2 gap-2">
        {RECEIVE_TOKEN_OPTIONS.map((opt) => {
          const selected = value === opt.type;
          return (
            <button
              key={opt.type}
              type="button"
              onClick={() => onChange(opt.type)}
              disabled={disabled}
              className={`rounded-xl border px-3 py-2 text-left transition disabled:opacity-50 ${
                selected
                  ? "border-[var(--accent)] bg-[var(--accent)]/[0.08] text-white"
                  : "border-white/10 bg-black/20 text-neutral-300 hover:border-white/25"
              }`}
              aria-pressed={selected}
            >
              <span className="text-sm font-medium">{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PreSignReceipt({
  sgdMinorUnits,
  outputAmount,
  merchantReceiveType,
  payerCoinType,
  isDirect,
}: {
  sgdMinorUnits: number;
  outputAmount: bigint | null;
  merchantReceiveType: SupportedReceiveToken;
  payerCoinType: SupportedReceiveToken;
  isDirect: boolean;
}) {
  if (sgdMinorUnits <= 0 || !outputAmount) return null;
  const outFormatted = formatTokenAmount(outputAmount, merchantReceiveType);
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3 space-y-1.5 text-xs">
      <p className="text-[11px] uppercase tracking-wider text-[var(--accent)]">Before you sign</p>
      <div className="flex items-center justify-between">
        <span className="text-neutral-400">Merchant receives</span>
        <span className="font-medium tabular-nums text-white">
          {outFormatted} {COIN_LABEL[merchantReceiveType]}
        </span>
      </div>
      <div className="flex items-center justify-between text-neutral-500">
        <span>You pay from</span>
        <span className="text-white">{COIN_LABEL[payerCoinType]}</span>
      </div>
      <div className="flex items-center justify-between text-neutral-500 pt-1.5 border-t border-white/5">
        <span>Route</span>
        <span className={isDirect ? "text-[var(--success)]" : "text-[var(--accent)]"}>
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
      className="group flex w-full items-center justify-between rounded-2xl bg-[var(--accent)] hover:bg-[var(--accent-strong)] disabled:bg-white/5 disabled:text-neutral-500 disabled:cursor-not-allowed text-white font-medium py-4 px-5 transition shadow-[0_8px_30px_-8px_var(--accent-glow)] disabled:shadow-none"
    >
      {submitting ? (
        <span className="flex items-center gap-2">
          <Spinner /> {phaseLabel}
        </span>
      ) : sgdMinorUnits > 0 ? (
        <>
          <span>Pay {formatSgd(sgdMinorUnits / 100)}</span>
          <span className="text-white/70 group-hover:text-white transition">→</span>
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
      <div className="rounded-2xl border border-[var(--success)]/30 bg-[var(--success)]/[0.08] p-4 space-y-2">
        <p className="text-sm font-medium text-white inline-flex items-center gap-2">
          <span className="text-[var(--success)]">
            <CheckIcon />
          </span>
          Paid on testnet · {state.routedVia === "direct" ? "direct transfer" : "via Cetus Aggregator"}
        </p>
        <p className="text-xs text-neutral-400">
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
            <span className="text-neutral-500 font-mono">
              ({state.blobId.slice(0, 8)}…{state.blobId.slice(-6)})
            </span>
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 space-y-1">
      <p className="text-sm font-medium text-red-300">Pay failed</p>
      <p className="text-xs text-red-300/80 break-words">{state.message}</p>
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
    return <p className="text-xs text-neutral-500">Fetching live Pyth prices…</p>;
  }
  if (error) {
    return (
      <p className="text-xs text-amber-400">
        Pyth Hermes unreachable: {error instanceof Error ? error.message : String(error)}.
      </p>
    );
  }
  if (!quote) return null;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-3 space-y-1.5 text-xs">
      <div className="flex items-center justify-between text-neutral-500">
        <span>1 SUI = ${quote.rates.usdPerSui.toFixed(4)} USD</span>
        <span>1 USD = {quote.rates.sgdPerUsd.toFixed(4)} SGD</span>
      </div>
      <div className="flex items-center justify-between pt-1.5 border-t border-white/5">
        <span className="text-neutral-500">
          {PYTH_FEED_LABELS[PYTH_FEEDS.USD_SGD]} · {PYTH_FEED_LABELS[PYTH_FEEDS.SUI_USD]}
        </span>
        <span
          className={
            stale ? "text-amber-400 inline-flex items-center gap-1.5" : "text-[var(--success)] inline-flex items-center gap-1.5"
          }
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              stale ? "bg-amber-400" : "bg-[var(--success)] live-dot"
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
    <span className="inline-flex h-3 w-3 items-center justify-center rounded-full bg-[var(--accent)]/30 border border-[var(--accent)]/50">
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
  const decimals = COIN_DECIMALS[token];
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  const fracStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
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
