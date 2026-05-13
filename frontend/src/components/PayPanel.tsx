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
  formatSui,
  quoteSgdToSui,
  STALE_THRESHOLD_SECONDS,
  usePythPrices,
} from "@/lib/pyth";
import { sanitizeMerchantName } from "@/lib/sgqr";
import { encodeV2 } from "@/lib/sgqr/quote-metadata";
import { buildPaySuiTx, deriveUenHash, encodeQuoteMetadata } from "@/lib/quay";
import { COIN_TYPES } from "@/lib/quay/pay";
import { txUrl } from "@/lib/sui-config";

type PayPhase = "uploading-receipt" | "awaiting-signature";

type PayState =
  | { kind: "idle" }
  | { kind: "submitting"; phase: PayPhase }
  | { kind: "success"; digest: string; blobId?: string }
  | { kind: "error"; message: string };

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
    if (!quote || !pricesQ.data || !account) return;
    setPay({ kind: "submitting", phase: "uploading-receipt" });
    try {
      const usdSgd = pricesQ.data.get(PYTH_FEEDS.USD_SGD)!;
      const suiUsd = pricesQ.data.get(PYTH_FEEDS.SUI_USD)!;

      const v1Quote = {
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
      };
      const v1Bytes = encodeQuoteMetadata(v1Quote);

      const predictedTimestampMs = Date.now();
      const receiptIdHex = predictReceiptIdHex({
        uen,
        payer: account.address,
        timestampMs: predictedTimestampMs,
        amount: quote.suiMist,
      });

      const receiptReq = {
        receipt_id_hex: receiptIdHex,
        payer: account.address,
        merchant: merchantAddress,
        uen_raw: uen,
        amount: quote.suiMist.toString(),
        token_type: COIN_TYPES.SUI,
        sgd_minor_units: quote.sgdMinorUnits,
        timestamp_ms: predictedTimestampMs,
        quote: {
          feed: PYTH_FEEDS.SUI_USD,
          price_usd: quote.usd.toFixed(6),
          sgd_per_usd: quote.rates.sgdPerUsd.toFixed(6),
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
        mistAmount: quote.suiMist,
        sgdMinorUnits: quote.sgdMinorUnits,
        memo: memo.trim() || undefined,
        quoteMetadata: v2Bytes,
      });
      const result = await signAndExecute({
        transaction: tx,
      });
      await sui.waitForTransaction({ digest: result.digest });
      setPay({ kind: "success", digest: result.digest, blobId });
    } catch (e) {
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
        quote={quote}
        stale={stale}
      />

      {!account ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
          <p className="text-sm text-amber-100">Connect a Sui wallet to pay.</p>
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
  const phaseLabel =
    state.kind === "submitting"
      ? state.phase === "uploading-receipt"
        ? "Preparing receipt on Walrus…"
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
      ) : quote ? (
        <>
          <span className="flex flex-col items-start text-left">
            <span>Pay {formatSgd(quote.sgd)}</span>
            <span className="text-[11px] font-normal text-white/70 group-hover:text-white transition">
              ≈ {formatSui(quote.sui)} · Walrus receipt
            </span>
          </span>
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
          Paid on testnet
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
      <div className="flex items-center justify-between">
        <span className="text-neutral-500">≈ via Pyth oracle</span>
        <span className="font-medium tabular-nums text-white">
          {formatSui(quote.sui)}{" "}
          <span className="text-neutral-500">({quote.suiMist.toString()} MIST)</span>
        </span>
      </div>
      <div className="flex items-center justify-between text-neutral-500">
        <span>= ${quote.usd.toFixed(4)} USD</span>
        <span>
          1 USD = {quote.rates.sgdPerUsd.toFixed(4)} SGD · 1 SUI = ${quote.rates.usdPerSui.toFixed(4)}
        </span>
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
