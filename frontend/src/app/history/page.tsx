"use client";

import { ConnectButton, useCurrentAccount, useSuiClientQuery } from "@mysten/dapp-kit";
import Link from "next/link";
import { useMemo } from "react";

import { decode as decodeQuoteMetadata } from "@/lib/sgqr/quote-metadata";
import { QUAY, objectUrl, txUrl } from "@/lib/sui-config";

interface PaymentReceiptEvent {
  receipt_id: number[];
  merchant: string;
  payer: string;
  amount: string;
  token_type: { name: string };
  uen_hash: number[];
  timestamp_ms: string;
  memo: number[] | null;
  sgd_minor_units: string;
  quote_metadata: number[] | null;
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

/**
 * Payer-side payment history.
 *
 * Mirrors /merchant/terminal from the payer's perspective. Sui's RPC only
 * accepts a single EventFilter at a time (the `All`/`Any` combinators are
 * no longer supported), so we query by MoveEventType globally and filter
 * `payer === account.address` on the client. limit:100 is a V0 ceiling —
 * if a wallet's payments don't appear in the most-recent global window
 * they won't show here; we'd need a backend indexer to scroll further.
 *
 * When quote_metadata is a v2 BCS payload, we surface the Walrus blob_id
 * as a "Verify receipt →" link to /verify/[blobId].
 */
export default function HistoryPage() {
  const account = useCurrentAccount();

  const { data, error, isLoading } = useSuiClientQuery(
    "queryEvents",
    {
      query: { MoveEventType: `${QUAY.packageId}::payments::PaymentReceipt` },
      order: "descending",
      limit: 100,
    },
    {
      refetchInterval: 5000,
      refetchIntervalInBackground: false,
      enabled: !!account,
    },
  );

  const receipts: NormalizedReceipt[] = useMemo(() => {
    if (!data?.data || !account) return [];
    return data.data
      .map(normalizeEvent)
      .filter((r): r is NormalizedReceipt => r !== null && r.payer === account.address);
  }, [data, account]);

  const todayTotalSgd = useMemo(() => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();
    let total = 0;
    for (const r of receipts) {
      if (r.timestampMs >= startMs) total += r.sgdMinorUnits;
    }
    return total / 100;
  }, [receipts]);

  const recentTotalSgd = useMemo(() => {
    let total = 0;
    for (const r of receipts) total += r.sgdMinorUnits;
    return total / 100;
  }, [receipts]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-10 space-y-8">
      <Link href="/" className="text-xs text-blue-600 hover:underline">
        ← home
      </Link>
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold">Payment history</h1>
        <p className="text-sm text-gray-500">
          Outgoing PaymentReceipt events from your connected wallet. Live —
          refreshes every 5s. Filters the most recent 100 quay payments
          network-wide; reach out if you need a longer window.
        </p>
      </header>

      {!account ? (
        <section className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-2">
          <p className="text-sm">Connect a Sui wallet to view your payment history.</p>
          <ConnectButton />
        </section>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3">
            <SummaryCard label="Today" amount={todayTotalSgd} highlight />
            <SummaryCard
              label={`Recent (${receipts.length})`}
              amount={recentTotalSgd}
            />
          </section>

          {error ? (
            <section className="rounded-md border border-red-200 bg-red-50 dark:bg-red-900/20 p-3 text-sm">
              <p className="font-medium text-red-700 dark:text-red-300">Event query failed</p>
              <p className="text-xs text-red-700 dark:text-red-300 mt-1">
                {error instanceof Error ? error.message : String(error)}
              </p>
            </section>
          ) : isLoading && receipts.length === 0 ? (
            <p className="text-sm text-gray-500">Looking up your payments…</p>
          ) : receipts.length === 0 ? (
            <section className="rounded-md border border-gray-200 dark:border-gray-700 p-6 text-center space-y-2">
              <p className="text-base font-medium">No payments yet</p>
              <p className="text-xs text-gray-500">
                Scan any SGQR sticker and pay a registered merchant. Your
                payment will appear here once it&apos;s finalized on chain.
              </p>
              <div className="pt-2">
                <Link href="/scan" className="text-xs text-blue-600 hover:underline">
                  Go to scan →
                </Link>
              </div>
            </section>
          ) : (
            <section className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-gray-500">Recent</p>
              <ul className="space-y-2">
                {receipts.map((r) => (
                  <ReceiptCard key={r.receiptId} r={r} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <footer className="text-xs text-gray-500 pt-6 border-t border-gray-100 dark:border-gray-800">
        <p>
          Connected wallet:{" "}
          {account ? (
            <a
              href={objectUrl(account.address)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-blue-600 hover:underline"
            >
              {account.address.slice(0, 10)}…{account.address.slice(-6)}
            </a>
          ) : (
            <span className="text-gray-400">none</span>
          )}
        </p>
      </footer>
    </main>
  );
}

function SummaryCard({
  label,
  amount,
  highlight,
}: {
  label: string;
  amount: number;
  highlight?: boolean;
}) {
  return (
    <div
      className={
        highlight
          ? "rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10 p-4"
          : "rounded-lg border border-gray-200 dark:border-gray-700 p-4"
      }
    >
      <p
        className={
          highlight
            ? "text-xs uppercase tracking-wide text-emerald-700 dark:text-emerald-300"
            : "text-xs uppercase tracking-wide text-gray-500"
        }
      >
        {label}
      </p>
      <p className="text-3xl font-semibold tabular-nums mt-1">
        ${amount.toFixed(2)}{" "}
        <span className="text-base text-gray-500 font-normal">SGD</span>
      </p>
    </div>
  );
}

function ReceiptCard({ r }: { r: NormalizedReceipt }) {
  const tokenLabel = shortTokenLabel(r.tokenType);
  return (
    <li className="rounded-md border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-2xl font-semibold tabular-nums">
          ${(r.sgdMinorUnits / 100).toFixed(2)}{" "}
          <span className="text-sm text-gray-500 font-normal">SGD</span>
        </p>
        <p className="text-xs text-gray-500 tabular-nums">
          {formatRelativeTime(r.timestampMs)}
        </p>
      </div>
      <div className="flex items-baseline justify-between gap-3 mt-1">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          <span className="tabular-nums">{formatTokenAmount(r.amount, tokenLabel)}</span>
          {" → "}
          <a
            href={objectUrl(r.merchant)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-blue-600 hover:underline"
          >
            {r.merchant.slice(0, 6)}…{r.merchant.slice(-4)}
          </a>
        </p>
        <a
          href={txUrl(r.txDigest)}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-blue-600 hover:underline font-mono"
        >
          tx ↗
        </a>
      </div>
      {r.memo && (
        <p className="text-xs text-gray-600 dark:text-gray-400 mt-2 italic">“{r.memo}”</p>
      )}
      {r.receiptBlobId && (
        <p className="text-xs mt-2">
          <Link
            href={`/verify/${encodeURIComponent(r.receiptBlobId)}`}
            className="text-emerald-700 dark:text-emerald-300 hover:underline"
          >
            Verify receipt →
          </Link>{" "}
          <span className="text-gray-500 font-mono">
            ({r.receiptBlobId.slice(0, 8)}…{r.receiptBlobId.slice(-6)} on Walrus)
          </span>
        </p>
      )}
    </li>
  );
}

function normalizeEvent(ev: {
  id: { txDigest: string; eventSeq: string };
  parsedJson?: unknown;
}): NormalizedReceipt | null {
  if (!ev.parsedJson) return null;
  const p = ev.parsedJson as PaymentReceiptEvent;
  if (!p.receipt_id || !p.merchant) return null;
  try {
    let receiptBlobId: string | null = null;
    if (p.quote_metadata) {
      try {
        const decoded = decodeQuoteMetadata(Uint8Array.from(p.quote_metadata));
        receiptBlobId = decoded.receiptBlobId;
      } catch {
        // v1 payload or unknown discriminator — leave blob link off.
      }
    }
    return {
      receiptId: `${ev.id.txDigest}_${ev.id.eventSeq}`,
      txDigest: ev.id.txDigest,
      payer: p.payer,
      merchant: p.merchant,
      amount: BigInt(p.amount),
      sgdMinorUnits: Number(p.sgd_minor_units),
      tokenType: p.token_type?.name ?? "",
      memo: p.memo ? new TextDecoder().decode(Uint8Array.from(p.memo)) : "",
      timestampMs: Number(p.timestamp_ms),
      receiptBlobId,
    };
  } catch {
    return null;
  }
}

function shortTokenLabel(typeName: string): string {
  const parts = typeName.split("::");
  return parts.at(-1) ?? typeName;
}

function formatTokenAmount(amount: bigint, symbol: string): string {
  if (symbol === "SUI") {
    const sui = Number(amount) / 1_000_000_000;
    return `${sui < 1 ? sui.toFixed(4) : sui.toFixed(2)} SUI`;
  }
  return `${amount.toString()} ${symbol}`;
}

function formatRelativeTime(ms: number): string {
  const ageSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (ageSec < 5) return "just now";
  if (ageSec < 60) return `${ageSec}s ago`;
  const ageMin = Math.floor(ageSec / 60);
  if (ageMin < 60) return `${ageMin}m ago`;
  const ageHour = Math.floor(ageMin / 60);
  if (ageHour < 24) return `${ageHour}h ago`;
  const ageDay = Math.floor(ageHour / 60 / 24);
  return `${ageDay}d ago`;
}
