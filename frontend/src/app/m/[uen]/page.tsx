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
    <main className="mx-auto max-w-md px-4 py-8 space-y-5">
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
      <section className="rounded-lg border border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/20 p-4">
        <p className="text-emerald-900 dark:text-emerald-100 text-base font-semibold flex items-baseline gap-2">
          <span>✓</span>
          <span>Verified quay merchant</span>
        </p>
      </section>

      {/* 2. Name placeholder + UEN */}
      <section className="space-y-0.5">
        <p className="text-xl font-semibold">Merchant</p>
        <p className="text-xs text-gray-500 font-mono">UEN {uen}</p>
      </section>

      {/* 3. Activity (aggregate only per D13) */}
      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-1.5">
        <p className="text-xs uppercase tracking-wide text-gray-500">Activity</p>
        {activityLoading ? (
          <p className="text-sm text-gray-500">Loading payment activity…</p>
        ) : aggregate.countLast30d === 0 ? (
          <p className="text-sm">Verified merchant — no payments yet.</p>
        ) : (
          <>
            <p className="text-sm">
              Active — last payment{" "}
              <span className="font-medium">
                {aggregate.lastSeenMs != null
                  ? formatRelativeTime(aggregate.lastSeenMs)
                  : "recently"}
              </span>
            </p>
            <p className="text-sm">
              <span className="font-medium">{aggregate.countLast30d}</span>{" "}
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
      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-1">
        <p className="text-xs uppercase tracking-wide text-gray-500">Evidence</p>
        {entry.evidenceHashHex && entry.evidenceHashHex.length > 0 ? (
          <p
            className="text-xs font-mono text-gray-700 dark:text-gray-300 break-all"
            title={`Verified by quay issuer`}
          >
            0x{entry.evidenceHashHex.slice(0, 12)}…{entry.evidenceHashHex.slice(-8)}
          </p>
        ) : (
          <p className="text-xs text-gray-500">
            No evidence hash on this entry (legacy registration).
          </p>
        )}
        <p className="text-xs text-gray-500 mt-1.5">
          The issuer signed off after reviewing specific evidence content; the
          on-chain hash is the public commitment.
        </p>
      </section>

      <footer className="text-xs text-gray-500 border-t border-gray-100 dark:border-gray-800 pt-4">
        <p>
          Merchant Sui address:{" "}
          <span className="font-mono">{shortAddr(entry.owner)}</span>
        </p>
        <p className="mt-1">
          <Link href="/" className="text-blue-600 hover:underline">
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
      <div className="flex items-center justify-center h-16 w-16 rounded-md bg-gray-200 dark:bg-gray-700 text-xl font-medium text-gray-600 dark:text-gray-300">
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
        // Fallback: hide the broken img and show initials in its sibling.
        e.currentTarget.style.display = "none";
        const fb = e.currentTarget.nextElementSibling as HTMLElement | null;
        if (fb) fb.style.display = "flex";
      }}
      className="h-16 w-16 rounded-md object-cover"
    />
  );
}

function LoadingCard() {
  return (
    <section className="rounded-md border border-gray-200 dark:border-gray-700 p-5">
      <p className="text-sm text-gray-500">Looking up merchant…</p>
    </section>
  );
}

function ErrorCard({ message, uen }: { message: string; uen: string }) {
  return (
    <section className="rounded-lg border border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-900/20 p-5 space-y-1">
      <p className="text-red-900 dark:text-red-100 font-semibold">Lookup failed</p>
      <p className="text-sm text-red-800 dark:text-red-200">{message}</p>
      <p className="text-xs text-red-700 dark:text-red-300 font-mono mt-2">UEN {uen}</p>
    </section>
  );
}

function UnknownCard({ uen }: { uen: string }) {
  return (
    <section className="rounded-lg border border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40 p-5 space-y-1">
      <p className="text-base font-semibold">✗ Not a quay merchant</p>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        UEN <span className="font-mono">{uen}</span>
        {" "}hasn&apos;t been registered.
      </p>
      <p className="text-xs text-gray-500 mt-2">
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
