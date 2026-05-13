"use client";

import { useSuiClient } from "@mysten/dapp-kit";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { use as usePromise } from "react";

import { deriveUenHash, lookupUen, type UenLookupResult } from "@/lib/quay";
import { QUAY } from "@/lib/sui-config";
import { getBlobUrl } from "@/lib/walrus/client";

/**
 * Public merchant page (Phase 6, D13 + D17 + D18).
 *
 * Trust-first hierarchy:
 *   1. ✓ Verified quay merchant badge
 *   2. (Name placeholder) + UEN
 *   3. Aggregate activity — count over 30d + last seen
 *   4. Logo (visual confirmation, not the lead)
 *   5. Evidence hash short-hex
 *
 * Activity policy (D13): aggregate-only. No amounts. No payer addresses.
 * Mobile-first per D18.
 */

const ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface PaymentReceiptEvent {
  merchant: string;
  payer: string;
  amount: string;
  uen_hash: number[];
  timestamp_ms: string;
}

interface Aggregate {
  countLast30d: number;
  lastSeenMs: number | null;
}

export default function MerchantPage({
  params,
}: {
  params: Promise<{ uen: string }>;
}) {
  const { uen: uenParam } = usePromise(params);
  const uen = decodeURIComponent(uenParam).toUpperCase();
  const sui = useSuiClient();

  const entryQuery = useQuery<UenLookupResult>({
    queryKey: ["public-merchant", uen],
    queryFn: () => lookupUen(sui, QUAY.registryId, uen),
    refetchOnWindowFocus: false,
  });

  const aggQuery = useQuery<Aggregate>({
    queryKey: ["merchant-activity", uen],
    enabled: entryQuery.data?.claimed === true,
    queryFn: async () => {
      const entry = entryQuery.data;
      if (!entry || !entry.claimed) return { countLast30d: 0, lastSeenMs: null };
      const uenHashBytes = Array.from(deriveUenHash(uen));
      const since = Date.now() - ACTIVITY_WINDOW_MS;

      const events = await sui.queryEvents({
        query: { MoveEventType: `${QUAY.packageId}::payments::PaymentReceipt` },
        order: "descending",
        limit: 200,
      });
      let count = 0;
      let lastSeenMs: number | null = null;
      for (const ev of events.data) {
        const p = ev.parsedJson as PaymentReceiptEvent | undefined;
        if (!p) continue;
        if (p.merchant !== entry.owner) continue;
        // Match by uen_hash too — same merchant address can hold multiple UENs.
        if (!arraysEqual(p.uen_hash, uenHashBytes)) continue;
        const ts = Number(p.timestamp_ms);
        if (Number.isNaN(ts)) continue;
        if (ts < since) continue;
        count += 1;
        if (lastSeenMs == null || ts > lastSeenMs) lastSeenMs = ts;
      }
      return { countLast30d: count, lastSeenMs };
    },
    refetchInterval: 30_000,
  });

  return (
    <main className="relative z-10 mx-auto max-w-md px-5 py-8 space-y-5">
      {entryQuery.isLoading && <LoadingCard />}
      {entryQuery.error && (
        <ErrorCard message={errMsg(entryQuery.error)} uen={uen} />
      )}
      {entryQuery.data && !entryQuery.data.claimed && <UnknownCard uen={uen} />}
      {entryQuery.data && entryQuery.data.claimed && (
        <MerchantView
          uen={uen}
          entry={entryQuery.data}
          aggregate={aggQuery.data ?? { countLast30d: 0, lastSeenMs: null }}
          activityLoading={aggQuery.isLoading}
        />
      )}
    </main>
  );
}

function MerchantView({
  uen,
  entry,
  aggregate,
  activityLoading,
}: {
  uen: string;
  entry: Extract<UenLookupResult, { claimed: true }>;
  aggregate: Aggregate;
  activityLoading: boolean;
}) {
  return (
    <>
      {/* 1. Trust badge (verdict-as-hero per D17) */}
      <section className="glass-card-success rounded-2xl p-4">
        <p className="text-emerald-100 text-base font-semibold flex items-baseline gap-2 tracking-tight">
          <span>✓</span>
          <span>Verified quay merchant</span>
        </p>
      </section>

      {/* 2. Name placeholder + UEN */}
      <section className="space-y-0.5">
        <p className="text-xl font-semibold tracking-tight text-white">Merchant</p>
        <p className="text-xs text-[var(--muted-soft)] font-mono">UEN {uen}</p>
      </section>

      {/* 3. Activity (aggregate only per D13) */}
      <section className="glass-card rounded-2xl p-4 space-y-1.5">
        <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">Activity</p>
        {activityLoading ? (
          <p className="relative z-10 text-sm text-[var(--muted-soft)]">Loading payment activity…</p>
        ) : aggregate.countLast30d === 0 ? (
          <p className="relative z-10 text-sm text-[var(--muted)]">Verified merchant — no payments yet.</p>
        ) : (
          <>
            <p className="relative z-10 text-sm text-[var(--muted)]">
              Active — last payment{" "}
              <span className="font-medium text-white">
                {aggregate.lastSeenMs != null
                  ? formatRelativeTime(aggregate.lastSeenMs)
                  : "recently"}
              </span>
            </p>
            <p className="relative z-10 text-sm text-[var(--muted)]">
              <span className="font-medium text-white">{aggregate.countLast30d}</span>{" "}
              {aggregate.countLast30d === 1 ? "payment" : "payments"} in last 30 days
            </p>
          </>
        )}
      </section>

      {/* 4. Logo (visual confirmation, not the lead) */}
      <section>
        <MerchantLogo blobId={entry.metadataBlobId} alt={uen} />
      </section>

      {/* 5. Evidence link (short-hex) */}
      <section className="glass-card rounded-2xl p-4 space-y-1">
        <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">Evidence</p>
        {entry.evidenceHashHex && entry.evidenceHashHex.length > 0 ? (
          <p
            className="relative z-10 text-xs font-mono text-[var(--muted)] break-all"
            title={`Verified by quay issuer`}
          >
            0x{entry.evidenceHashHex.slice(0, 12)}…{entry.evidenceHashHex.slice(-8)}
          </p>
        ) : (
          <p className="relative z-10 text-xs text-[var(--muted-soft)]">
            No evidence hash on this entry (legacy registration).
          </p>
        )}
        <p className="relative z-10 text-xs text-[var(--muted-soft)] mt-1.5">
          The issuer signed off after reviewing specific evidence content; the
          on-chain hash is the public commitment.
        </p>
      </section>

      <footer className="text-xs text-[var(--muted-soft)] border-t border-white/5 pt-4">
        <p>
          Merchant Sui address:{" "}
          <span className="font-mono text-[var(--muted)]">{shortAddr(entry.owner)}</span>
        </p>
        <p className="mt-1">
          <Link href="/" className="text-[var(--accent)] hover:underline">
            ← back to quay
          </Link>
        </p>
      </footer>
    </>
  );
}

function MerchantLogo({ blobId, alt }: { blobId: string | null; alt: string }) {
  const initial = alt.charAt(0).toUpperCase();
  if (!blobId) {
    return (
      <div className="flex items-center justify-center h-16 w-16 rounded-2xl bg-[var(--accent)]/15 border border-[var(--accent)]/40 text-xl font-medium text-[var(--accent-strong)] shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]">
        {initial}
      </div>
    );
  }
  return (
    <img
      src={getBlobUrl(blobId)}
      alt={alt}
      width={64}
      height={64}
      loading="lazy"
      decoding="async"
      onError={(e) => {
        e.currentTarget.style.display = "none";
        const fb = e.currentTarget.nextElementSibling as HTMLElement | null;
        if (fb) fb.style.display = "flex";
      }}
      className="h-16 w-16 rounded-2xl object-cover ring-1 ring-white/15 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.6)]"
    />
  );
}

function LoadingCard() {
  return (
    <section className="glass-card rounded-2xl p-5">
      <p className="relative z-10 text-sm text-[var(--muted-soft)]">Looking up merchant…</p>
    </section>
  );
}

function ErrorCard({ message, uen }: { message: string; uen: string }) {
  return (
    <section className="glass-card-danger rounded-2xl p-5 space-y-1">
      <p className="text-red-200 font-semibold">Lookup failed</p>
      <p className="text-sm text-red-200/90">{message}</p>
      <p className="text-xs text-red-200/70 font-mono mt-2">UEN {uen}</p>
    </section>
  );
}

function UnknownCard({ uen }: { uen: string }) {
  return (
    <section className="glass-card rounded-2xl p-5 space-y-1">
      <p className="relative z-10 text-base font-semibold text-white">✗ Not a quay merchant</p>
      <p className="relative z-10 text-sm text-[var(--muted)]">
        UEN <span className="font-mono text-white">{uen}</span>
        {" "}hasn&apos;t been registered.
      </p>
      <p className="relative z-10 text-xs text-[var(--muted-soft)] mt-2">
        Anyone can claim a UEN here on testnet — verification doesn&apos;t imply
        endorsement.
      </p>
    </section>
  );
}

function arraysEqual(a: number[] | undefined, b: number[]): boolean {
  if (!a) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function shortAddr(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function formatRelativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
