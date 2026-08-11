"use client";

import { ConnectButton, useCurrentAccount } from "@mysten/dapp-kit";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo } from "react";

import { bytesFromEventField, queryEventsByType, type QuayEvent } from "@/lib/quay/events";
import { decode as decodeQuoteMetadata } from "@/lib/sgqr/quote-metadata";
import { QUAY, accountUrl, txUrl } from "@/lib/sui-config";

interface PaymentReceiptEvent {
  receipt_id: unknown;
  merchant: string;
  payer: string;
  amount: string;
  token_type: { name: string };
  uen_hash: unknown;
  timestamp_ms: string;
  memo: unknown;
  sgd_minor_units: string;
  quote_metadata: unknown;
}

interface NormalizedReceipt {
  receiptId: string;
  txDigest: string;
  payer: string;
  merchant: string;
  amount: bigint;
  sgdMinorUnits: number;
  tokenType: string;
  memo: string;
  timestampMs: number;
  receiptBlobId: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Payer-side payment history (Midnight Quay).
 *
 * Sui RPC accepts a single EventFilter at a time, so we query
 * PaymentReceipt globally then filter `payer === account.address` on the
 * client. Limit 100 receipts in the most recent global window.
 */
export default function HistoryPage() {
  const account = useCurrentAccount();

  const { data, error, isLoading } = useQuery({
    queryKey: ["payment-receipts"],
    queryFn: () =>
      queryEventsByType(`${QUAY.packageId}::payments::PaymentReceipt`, 100),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    enabled: !!account,
  });

  const receipts: NormalizedReceipt[] = useMemo(() => {
    if (!data || !account) return [];
    return data
      .map(normalizeEvent)
      .filter((r): r is NormalizedReceipt => r !== null && r.payer === account.address);
  }, [data, account]);

  const stats = useMemo(() => computeStats(receipts), [receipts]);

  return (
    <main className="relative z-10 mx-auto w-full max-w-md px-5 py-6 space-y-6">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-[var(--accent)] hover:underline text-sm inline-flex items-center gap-1">
          <span aria-hidden>←</span> home
        </Link>
        <span className="glass-pill">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] live-dot" />
          live
        </span>
      </header>

      <section className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Payment history</h1>
        <p className="text-sm text-[var(--muted)]">
          Outgoing receipts from your connected wallet. Refreshes every 5s.
        </p>
      </section>

      {!account ? (
        <section className="glass-card-accent rounded-2xl p-5 space-y-3">
          <p className="relative z-10 text-sm text-white">Connect a Sui wallet to view your payment history.</p>
          <div className="relative z-10">
            <ConnectButton />
          </div>
        </section>
      ) : (
        <>
          <WeekHero stats={stats} />

          <div className="grid grid-cols-3 gap-2">
            <KPI label="Today" amount={stats.todaySgd} />
            <KPI label="7 days" amount={stats.weekSgd} />
            <KPI label="All time" amount={stats.allTimeSgd} />
          </div>

          {error ? (
            <section className="glass-card-danger rounded-2xl p-4 space-y-1">
              <p className="text-sm font-medium text-red-200">Event query failed</p>
              <p className="text-xs text-red-200/80 break-words">
                {error instanceof Error ? error.message : String(error)}
              </p>
            </section>
          ) : isLoading && receipts.length === 0 ? (
            <p className="text-sm text-[var(--muted-soft)] text-center py-6">Loading…</p>
          ) : receipts.length === 0 ? (
            <EmptyState />
          ) : (
            <ReceiptList receipts={receipts} />
          )}
        </>
      )}

      <footer className="text-[11px] text-[var(--muted-soft)] pt-4 border-t border-white/5">
        Connected wallet:{" "}
        {account ? (
          <a
            href={accountUrl(account.address)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[var(--accent)] hover:underline"
          >
            {account.address.slice(0, 8)}…{account.address.slice(-6)}
          </a>
        ) : (
          <span className="text-[var(--muted-soft)]">none</span>
        )}
      </footer>
    </main>
  );
}

function WeekHero({
  stats,
}: {
  stats: ReturnType<typeof computeStats>;
}) {
  return (
    <section className="glass-card-accent rounded-3xl p-5 overflow-hidden">
      <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]">
        Spent this week
      </p>
      <p className="relative z-10 mt-1 text-4xl font-semibold tabular-nums">
        <span className="glass-shimmer">${stats.weekSgd.toFixed(2)}</span>
        <span className="ml-1.5 text-base text-[var(--muted-soft)] font-normal">SGD</span>
      </p>
      <div className="relative z-10 mt-3 h-12">
        <Sparkline points={stats.weeklyDaily} />
      </div>
      <div className="relative z-10 mt-2 flex justify-between text-[10px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">
        {stats.weekLabels.map((d, i) => (
          <span key={i} className={i === stats.weekLabels.length - 1 ? "text-[var(--accent-strong)]" : ""}>
            {d}
          </span>
        ))}
      </div>
    </section>
  );
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length === 0) return null;
  const max = Math.max(...points, 1);
  const w = 100;
  const h = 30;
  const step = points.length > 1 ? w / (points.length - 1) : 0;
  const coords = points.map((v, i) => {
    const x = i * step;
    const y = h - (v / max) * h;
    return [x, y] as const;
  });
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const areaPath = `${path} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-full" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="spark-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.4" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#spark-area)" />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {coords.length > 0 && (
        <circle cx={coords[coords.length - 1][0]} cy={coords[coords.length - 1][1]} r="2" fill="var(--accent)" />
      )}
    </svg>
  );
}

function KPI({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="glass-card rounded-2xl p-3">
      <p className="relative z-10 text-[10px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">{label}</p>
      <p className="relative z-10 mt-0.5 text-base font-semibold tabular-nums text-white">
        ${amount.toFixed(2)}
        <span className="text-[10px] text-[var(--muted-soft)] ml-0.5 font-normal">SGD</span>
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <section className="glass-card rounded-2xl p-6 text-center space-y-2">
      <div className="relative z-10 mx-auto h-12 w-12 rounded-full bg-[var(--accent)]/15 border border-[var(--accent)]/35 flex items-center justify-center shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_0_24px_-8px_var(--accent-glow)]">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-strong)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </div>
      <p className="relative z-10 text-base font-medium text-white">No payments yet</p>
      <p className="relative z-10 text-xs text-[var(--muted-soft)]">
        Scan an SGQR sticker. Once it&apos;s on chain, it shows up here.
      </p>
      <div className="relative z-10 pt-1">
        <Link href="/scan" className="text-xs text-[var(--accent)] hover:underline">
          Go to scan →
        </Link>
      </div>
    </section>
  );
}

function ReceiptList({ receipts }: { receipts: NormalizedReceipt[] }) {
  const groups = useMemo(() => groupByDay(receipts), [receipts]);
  return (
    <section className="space-y-4">
      {groups.map((group) => (
        <div key={group.label} className="space-y-2">
          <h3 className="text-[10px] uppercase tracking-[0.12em] text-[var(--muted-soft)] px-1">{group.label}</h3>
          <ul className="space-y-2">
            {group.items.map((r, i) => (
              <ReceiptCard key={r.receiptId} r={r} highlight={group.label === "Today" && i === 0} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function ReceiptCard({ r, highlight }: { r: NormalizedReceipt; highlight: boolean }) {
  const merchantInitial = r.merchant.slice(2, 3).toUpperCase();
  return (
    <li
      className={`rounded-2xl p-4 ${
        highlight ? "glass-card-accent" : "glass-card"
      }`}
    >
      <div className="relative z-10 flex items-start gap-3">
        <div className="h-9 w-9 rounded-full bg-[var(--accent)]/15 border border-[var(--accent)]/35 flex items-center justify-center text-[var(--accent-strong)] text-xs font-semibold shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]">
          {merchantInitial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-lg font-semibold tabular-nums text-white">
              ${(r.sgdMinorUnits / 100).toFixed(2)}{" "}
              <span className="text-xs text-[var(--muted-soft)] font-normal">SGD</span>
            </p>
            <span className="text-[11px] text-[var(--muted-soft)] tabular-nums shrink-0">
              {formatRelativeTime(r.timestampMs)}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-[var(--muted)] font-mono truncate">
            {formatTokenAmount(r.amount, r.tokenType)} → {r.merchant.slice(0, 6)}…{r.merchant.slice(-4)}
          </p>
          {r.memo && (
            <p className="mt-1.5 text-xs text-[var(--muted)] italic">&ldquo;{r.memo}&rdquo;</p>
          )}
          <div className="mt-2 flex items-center gap-3 text-[11px]">
            <a
              href={txUrl(r.txDigest)}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--accent)] hover:underline font-mono"
            >
              tx ↗
            </a>
            {r.receiptBlobId && (
              <Link
                href={`/verify/${encodeURIComponent(r.receiptBlobId)}`}
                className="text-[var(--accent)] hover:underline inline-flex items-center gap-1"
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
                verified
              </Link>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function computeStats(receipts: NormalizedReceipt[]) {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startToday = startOfToday.getTime();
  const startWeek = now - 7 * DAY_MS;

  let todayMinor = 0;
  let weekMinor = 0;
  let allMinor = 0;
  for (const r of receipts) {
    allMinor += r.sgdMinorUnits;
    if (r.timestampMs >= startToday) todayMinor += r.sgdMinorUnits;
    if (r.timestampMs >= startWeek) weekMinor += r.sgdMinorUnits;
  }

  // Bucket the last 7 days (including today) into daily totals
  const weeklyDaily: number[] = [];
  const weekLabels: string[] = [];
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let i = 6; i >= 0; i--) {
    const dayStart = startToday - i * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    let dayMinor = 0;
    for (const r of receipts) {
      if (r.timestampMs >= dayStart && r.timestampMs < dayEnd) dayMinor += r.sgdMinorUnits;
    }
    weeklyDaily.push(dayMinor / 100);
    weekLabels.push(dayNames[new Date(dayStart).getDay()]);
  }

  return {
    todaySgd: todayMinor / 100,
    weekSgd: weekMinor / 100,
    allTimeSgd: allMinor / 100,
    weeklyDaily,
    weekLabels,
  };
}

function groupByDay(receipts: NormalizedReceipt[]): { label: string; items: NormalizedReceipt[] }[] {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startToday = startOfToday.getTime();
  const startYesterday = startToday - DAY_MS;
  const startWeek = startToday - 7 * DAY_MS;

  const today: NormalizedReceipt[] = [];
  const yesterday: NormalizedReceipt[] = [];
  const thisWeek: NormalizedReceipt[] = [];
  const older: NormalizedReceipt[] = [];

  for (const r of receipts) {
    if (r.timestampMs >= startToday) today.push(r);
    else if (r.timestampMs >= startYesterday) yesterday.push(r);
    else if (r.timestampMs >= startWeek) thisWeek.push(r);
    else older.push(r);
  }

  const groups: { label: string; items: NormalizedReceipt[] }[] = [];
  if (today.length) groups.push({ label: "Today", items: today });
  if (yesterday.length) groups.push({ label: "Yesterday", items: yesterday });
  if (thisWeek.length) groups.push({ label: "This week", items: thisWeek });
  if (older.length) groups.push({ label: "Earlier", items: older });
  return groups;
}

function normalizeEvent(ev: QuayEvent, index: number): NormalizedReceipt | null {
  if (!ev.parsedJson) return null;
  const p = ev.parsedJson as PaymentReceiptEvent;
  if (!p.receipt_id || !p.merchant) return null;
  try {
    let receiptBlobId: string | null = null;
    if (p.quote_metadata) {
      try {
        const qm = bytesFromEventField(p.quote_metadata);
        const decoded = qm ? decodeQuoteMetadata(qm) : null;
        receiptBlobId = decoded?.receiptBlobId ?? null;
      } catch {
        // v1 / unknown discriminator — leave link off.
      }
    }
    return {
      receiptId: `${ev.txDigest}_${index}`,
      txDigest: ev.txDigest ?? "",
      payer: p.payer,
      merchant: p.merchant,
      amount: BigInt(p.amount),
      sgdMinorUnits: Number(p.sgd_minor_units),
      tokenType: p.token_type?.name ?? "",
      memo: (() => {
        const m = bytesFromEventField(p.memo);
        return m ? new TextDecoder().decode(m) : "";
      })(),
      timestampMs: Number(p.timestamp_ms),
      receiptBlobId,
    };
  } catch {
    return null;
  }
}

// Bridge publishes USDsui's on-chain symbol as "USDSUI" all-caps but the brand
// reads "USDsui" — mirror PayPanel's curated labels here.
const TOKEN_DISPLAY: Record<string, { label: string; decimals: number }> = {
  "::sui::SUI": { label: "SUI", decimals: 9 },
  "::usdc::USDC": { label: "USDC", decimals: 6 },
  "::usdsui::USDSUI": { label: "USDsui", decimals: 6 },
  "::scallop_usdsui::SCALLOP_USDSUI": { label: "sUSDsui", decimals: 6 },
};

function tokenDisplay(typeName: string): { label: string; decimals: number } {
  for (const [suffix, info] of Object.entries(TOKEN_DISPLAY)) {
    if (typeName.endsWith(suffix)) return info;
  }
  const parts = typeName.split("::");
  return { label: parts.at(-1) ?? typeName, decimals: 0 };
}

function formatTokenAmount(amount: bigint, typeName: string): string {
  const { label, decimals } = tokenDisplay(typeName);
  if (decimals === 0) return `${amount.toString()} ${label}`;
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const frac = amount % scale;
  // Show up to 4 fractional digits for sub-unit amounts, 2 otherwise.
  const showFour = whole === 0n;
  const fracDigits = showFour ? 4 : 2;
  const trimmed = (frac * 10n ** BigInt(fracDigits) / scale)
    .toString()
    .padStart(fracDigits, "0");
  return `${whole.toString()}.${trimmed} ${label}`;
}

function formatRelativeTime(ms: number): string {
  const ageSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (ageSec < 5) return "just now";
  if (ageSec < 60) return `${ageSec}s ago`;
  const ageMin = Math.floor(ageSec / 60);
  if (ageMin < 60) return `${ageMin}m ago`;
  const ageHour = Math.floor(ageMin / 60);
  if (ageHour < 24) return `${ageHour}h ago`;
  const ageDay = Math.floor(ageHour / 24);
  return `${ageDay}d ago`;
}
