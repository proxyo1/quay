"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";

import { useZkLoginSession } from "@/lib/zklogin";
import { listOwnedMerchantEntries, type OwnedMerchantEntry } from "@/lib/quay";
import { bytesFromEventField, queryEventsByType, type QuayEvent } from "@/lib/quay/events";
import {
  formatTokenAmount,
  isYieldRoutedToken as isYieldRouted,
} from "@/lib/quay/token-meta";
import { QUAY, txUrl } from "@/lib/sui-config";
import { getBlobUrl } from "@/lib/walrus/client";
import { getSuiClient } from "@/lib/sui-client";

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
}

export default function TerminalPage() {
  const { session, hydrated, expired, signOut } = useZkLoginSession();
  const router = useRouter();

  useEffect(() => {
    if (hydrated && !session) {
      const expiredParam = expired ? "&expired=1" : "";
      router.replace(`/merchant/login?next=/merchant/terminal${expiredParam}`);
    }
  }, [hydrated, session, expired, router]);

  if (hydrated && !session) {
    return (
      <main className="relative z-10 mx-auto w-full max-w-md px-5 py-16">
        <p className="text-sm text-[var(--muted-soft)]">Redirecting to sign-in…</p>
      </main>
    );
  }

  return <TerminalView session={session} onSignOut={signOut} />;
}

type MerchantUen = OwnedMerchantEntry;

function useMerchantUens(address: string | undefined) {
  const sui = getSuiClient();
  return useQuery<MerchantUen[]>({
    queryKey: ["merchant-uens", address],
    queryFn: async () => {
      if (!address) return [];
      return listOwnedMerchantEntries(
        sui,
        QUAY.registryId,
        QUAY.packageId,
        address,
      );
    },
    enabled: !!address,
    refetchInterval: 10_000,
  });
}

function TerminalView({
  session,
  onSignOut,
}: {
  session: ReturnType<typeof useZkLoginSession>["session"];
  onSignOut: () => void;
}) {
  const merchantAddress = session?.address ?? "0x0";
  const uens = useMerchantUens(session?.address);

  const { data, error, isLoading } = useQuery({
    queryKey: ["terminal-receipts"],
    queryFn: () =>
      queryEventsByType(`${QUAY.packageId}::payments::PaymentReceipt`, 50),
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    enabled: !!session,
  });

  const receipts: NormalizedReceipt[] = useMemo(() => {
    if (!data || !session) return [];
    return data
      .map((ev, i) => normalizeEvent(ev, i))
      .filter((r): r is NormalizedReceipt => r !== null && r.merchant === merchantAddress);
  }, [data, session, merchantAddress]);

  const { todayTotalSgd, todayCount, avgTicket } = useMemo(() => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();
    let totalMinor = 0;
    let count = 0;
    for (const r of receipts) {
      if (r.timestampMs >= startMs) {
        totalMinor += r.sgdMinorUnits;
        count += 1;
      }
    }
    const avgMinor = count > 0 ? totalMinor / count : 0;
    return {
      todayTotalSgd: totalMinor / 100,
      todayCount: count,
      avgTicket: avgMinor / 100,
    };
  }, [receipts]);

  const latest = receipts[0];
  const latestIsRecent = latest && Date.now() - latest.timestampMs < 30_000;

  return (
    <main className="relative z-10 mx-auto w-full max-w-md px-5 py-6 space-y-6">
      <header className="flex items-center justify-between">
        <Link href="/merchant" className="text-[var(--accent)] hover:underline text-sm inline-flex items-center gap-1">
          <span aria-hidden>←</span> merchant
        </Link>
        <button
          type="button"
          onClick={onSignOut}
          className="glass-chip rounded-full"
        >
          Sign out
        </button>
      </header>

      <section className="space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-semibold tracking-tight">Terminal</h1>
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-[var(--accent)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] live-dot" />
            live
          </span>
        </div>
        {session && (
          <p className="text-[11px] text-[var(--muted-soft)]">
            {session.email}
          </p>
        )}
      </section>

      <section className="glass-card-accent rounded-3xl p-6 overflow-hidden">
        <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]">
          Today · {todayCount} payment{todayCount === 1 ? "" : "s"}
        </p>
        <p className="relative z-10 mt-1 text-5xl font-semibold tabular-nums">
          <span className="glass-shimmer">${todayTotalSgd.toFixed(2)}</span>
          <span className="ml-2 text-xl text-[var(--muted-soft)] font-normal">SGD</span>
        </p>
        <div className="relative z-10 mt-3 flex gap-4 text-[11px] text-[var(--muted)]">
          <span>
            avg <span className="text-white tabular-nums">${avgTicket.toFixed(2)}</span>
          </span>
          <span>·</span>
          <span>refreshes every 2s</span>
        </div>
      </section>

      {latest && latestIsRecent && (
        <section className="glass-card-success rounded-2xl p-3 glass-rise">
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 rounded-full bg-[var(--success)] live-dot shrink-0" />
            <div className="flex-1 min-w-0 text-sm text-white">
              <span className="font-semibold tabular-nums">
                ${(latest.sgdMinorUnits / 100).toFixed(2)} SGD
              </span>
              <span className="text-[var(--muted)]"> from a customer · {formatRelativeTime(latest.timestampMs)}</span>
            </div>
          </div>
        </section>
      )}

      <UenList state={uens} />

      {error ? (
        <section className="glass-card-danger rounded-2xl p-4 space-y-1">
          <p className="text-sm font-medium text-red-200">Couldn&apos;t load payments</p>
          <p className="text-xs text-red-200/80 break-words">
            {error instanceof Error ? error.message : String(error)}
          </p>
        </section>
      ) : isLoading && receipts.length === 0 ? (
        <p className="text-sm text-[var(--muted-soft)] text-center py-6">Waiting for payments…</p>
      ) : receipts.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="space-y-2">
          <h3 className="text-[10px] uppercase tracking-[0.12em] text-[var(--muted-soft)] px-1">Recent</h3>
          <ul className="space-y-2">
            {receipts.map((r, i) => (
              <ReceiptCard key={r.receiptId} r={r} highlight={i === 0 && latestIsRecent} />
            ))}
          </ul>
        </section>
      )}

      <footer className="text-[11px] text-[var(--muted-soft)] pt-4 border-t border-white/5">
        Powered by Sui · Walrus · Pyth
      </footer>
    </main>
  );
}

function EmptyState() {
  return (
    <section className="glass-card rounded-2xl p-6 text-center space-y-2">
      <div className="relative z-10 mx-auto h-12 w-12 rounded-full bg-[var(--accent)]/15 border border-[var(--accent)]/35 flex items-center justify-center shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_0_24px_-8px_var(--accent-glow)]">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-strong)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
      </div>
      <p className="relative z-10 text-base font-medium text-white">No payments yet</p>
      <p className="relative z-10 text-xs text-[var(--muted-soft)]">
        Once a customer scans your SGQR, the payment shows up here in seconds.
      </p>
      <div className="relative z-10 pt-1 flex justify-center gap-3">
        <Link href="/merchant/onboard" className="text-xs text-[var(--accent)] hover:underline">
          Add a business →
        </Link>
        <span className="text-[var(--muted-soft)]">·</span>
        <Link href="/scan" className="text-xs text-[var(--accent)] hover:underline">
          Try a test payment →
        </Link>
      </div>
    </section>
  );
}

function UenList({ state }: { state: ReturnType<typeof useMerchantUens> }) {
  if (state.isLoading) {
    return (
      <section className="glass-card rounded-2xl p-4">
        <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">Your businesses</p>
        <p className="relative z-10 mt-2 text-sm text-[var(--muted-soft)]">Loading…</p>
      </section>
    );
  }
  if (state.error) {
    return (
      <section className="glass-card-danger rounded-2xl p-4">
        <p className="text-[11px] uppercase tracking-[0.12em] text-red-200">Your businesses</p>
        <p className="mt-1 text-xs text-red-200/80">
          {state.error instanceof Error ? state.error.message : String(state.error)}
        </p>
      </section>
    );
  }
  const uens = state.data ?? [];
  if (uens.length === 0) {
    return (
      <section className="glass-card rounded-2xl p-4">
        <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">Your businesses</p>
        <p className="relative z-10 mt-2 text-sm text-[var(--muted)]">
          No businesses added yet.{" "}
          <Link href="/merchant/onboard" className="text-[var(--accent)] hover:underline">
            Add one →
          </Link>
        </p>
      </section>
    );
  }
  return (
    <section className="glass-card rounded-2xl p-4 space-y-2">
      <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">
        Your business{uens.length > 1 ? "es" : ""}
      </p>
      <ul className="relative z-10 space-y-2">
        {uens.map((u) => (
          <li key={u.uen} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <MerchantLogo blobId={u.metadataBlobId} alt={u.uen} />
              <span className="font-mono text-sm text-white truncate">{u.uen}</span>
            </div>
            <a
              href={txUrl(u.digest ?? "")}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-[var(--accent)] hover:underline shrink-0"
              title={`Added ${new Date(u.timestamp).toLocaleString()}`}
            >
              Receipt ↗
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MerchantLogo({ blobId, alt }: { blobId: string | null; alt: string }) {
  const initial = alt.charAt(0).toUpperCase();
  if (!blobId) {
    return (
      <span className="inline-flex items-center justify-center h-7 w-7 rounded-lg bg-[var(--accent)]/20 border border-[var(--accent)]/40 text-[10px] font-semibold text-[var(--accent-strong)] shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]">
        {initial}
      </span>
    );
  }
  return (
    <span className="relative inline-flex items-center justify-center h-7 w-7 shrink-0">
      <img
        src={getBlobUrl(blobId)}
        alt={alt}
        width={28}
        height={28}
        loading="lazy"
        decoding="async"
        onError={(e) => {
          e.currentTarget.style.display = "none";
          const fallback = e.currentTarget.nextElementSibling as HTMLElement | null;
          if (fallback) fallback.style.display = "inline-flex";
        }}
        className="h-7 w-7 rounded-lg object-cover ring-1 ring-white/20"
      />
      <span
        className="absolute inset-0 hidden items-center justify-center rounded-lg bg-[var(--accent)]/20 border border-[var(--accent)]/40 text-[10px] font-semibold text-[var(--accent-strong)]"
      >
        {initial}
      </span>
    </span>
  );
}

function ReceiptCard({ r, highlight }: { r: NormalizedReceipt; highlight: boolean }) {
  const yieldRouted = isYieldRouted(r.tokenType);
  return (
    <li
      className={`rounded-2xl p-4 ${
        highlight
          ? "glass-card-accent"
          : "glass-card"
      }`}
    >
      <div className="relative z-10 flex items-start gap-3">
        <div className="h-9 w-9 rounded-full bg-[var(--success)]/15 border border-[var(--success)]/40 flex items-center justify-center text-[var(--success)] shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]">
          <ArrowDown />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-lg font-semibold tabular-nums text-white">
              ${(r.sgdMinorUnits / 100).toFixed(2)}{" "}
              <span className="text-xs text-[var(--muted-soft)] font-normal">SGD</span>
              {yieldRouted && (
                <span
                  className="ml-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--accent)] align-middle"
                  title="This payment is earning interest"
                >
                  <span aria-hidden>↑</span> earning
                </span>
              )}
            </p>
            <span className="text-[11px] text-[var(--muted-soft)] tabular-nums shrink-0">
              {formatRelativeTime(r.timestampMs)}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-[var(--muted)] truncate">
            Paid with <span className="font-mono">{formatTokenAmount(r.amount, r.tokenType)}</span>
          </p>
          {r.memo && (
            <p className="mt-1.5 text-xs text-[var(--muted)] italic">&ldquo;{r.memo}&rdquo;</p>
          )}
          <a
            href={txUrl(r.txDigest)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-[11px] text-[var(--accent)] hover:underline"
          >
            Receipt ↗
          </a>
        </div>
      </div>
    </li>
  );
}

function ArrowDown() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </svg>
  );
}

function normalizeEvent(ev: QuayEvent, index: number): NormalizedReceipt | null {
  if (!ev.parsedJson) return null;
  const p = ev.parsedJson as PaymentReceiptEvent;
  if (!p.receipt_id || !p.merchant) return null;
  try {
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
    };
  } catch {
    return null;
  }
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
