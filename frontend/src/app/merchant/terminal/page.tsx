"use client";

import { ConnectButton, useCurrentAccount, useSuiClientQuery } from "@mysten/dapp-kit";
import Link from "next/link";
import { useMemo } from "react";

import { SUIQR, objectUrl, txUrl } from "@/lib/sui-config";

interface PaymentReceiptEvent {
  receipt_id: number[];
  merchant: string;
  payer: string;
  amount: string; // u64 stringified
  token_type: { name: string };
  uen_hash: number[];
  timestamp_ms: string;
  memo: number[] | null;
  sgd_minor_units: string;
  quote_metadata: number[] | null;
}

interface NormalizedReceipt {
  receiptId: string;
  digest: string;
  txDigest: string;
  payer: string;
  merchant: string;
  amount: bigint;
  sgdMinorUnits: number;
  tokenType: string;
  memo: string;
  timestampMs: number;
}

/**
 * Day 8 — merchant terminal.
 *
 * Connected wallet sees a live feed of PaymentReceipt events targeting
 * its address, plus a running "today total" in SGD. Refreshes every
 * 2s via dapp-kit's useSuiClientQuery. WebSocket subscription would be
 * lower-latency but the JSON-RPC polling path is more reliable across
 * fullnode operators (and easier to reason about under flaky networks).
 */
export default function TerminalPage() {
  const account = useCurrentAccount();

  const { data, error, isLoading } = useSuiClientQuery(
    "queryEvents",
    {
      query: {
        MoveEventType: `${SUIQR.packageId}::payments::PaymentReceipt`,
      },
      order: "descending",
      limit: 50,
    },
    { refetchInterval: 2000, refetchIntervalInBackground: false },
  );

  const receipts: NormalizedReceipt[] = useMemo(() => {
    if (!data?.data || !account) return [];
    return data.data
      .map((ev) => normalizeEvent(ev))
      .filter((r): r is NormalizedReceipt => r !== null && r.merchant === account.address);
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

  if (!account) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-10 space-y-6">
        <Link href="/merchant" className="text-xs text-blue-600 hover:underline">
          ← merchant
        </Link>
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold">Terminal</h1>
          <p className="text-sm text-gray-500">
            Connect the wallet that owns your registered UEN to see live payment events.
          </p>
        </header>
        <ConnectButton />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10 space-y-8">
      <Link href="/merchant" className="text-xs text-blue-600 hover:underline">
        ← merchant
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">Terminal</h1>
          <p className="text-xs text-gray-500 font-mono mt-1">
            you · {account.address.slice(0, 10)}…{account.address.slice(-6)}
          </p>
        </div>
        <ConnectButton />
      </header>

      <section className="rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10 p-6">
        <p className="text-xs uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
          Today
        </p>
        <p className="text-5xl font-semibold tabular-nums mt-1">
          ${todayTotalSgd.toFixed(2)}{" "}
          <span className="text-2xl text-gray-500 font-normal">SGD</span>
        </p>
        <p className="text-xs text-gray-500 mt-2 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          Live — refreshes every 2s
        </p>
      </section>

      {error ? (
        <section className="rounded-md border border-red-200 bg-red-50 dark:bg-red-900/20 p-3 text-sm">
          <p className="font-medium text-red-700 dark:text-red-300">Event query failed</p>
          <p className="text-xs text-red-700 dark:text-red-300 mt-1">
            {error instanceof Error ? error.message : String(error)}
          </p>
        </section>
      ) : isLoading && receipts.length === 0 ? (
        <p className="text-sm text-gray-500">Looking up recent payments…</p>
      ) : receipts.length === 0 ? (
        <section className="rounded-md border border-gray-200 dark:border-gray-700 p-6 text-center space-y-2">
          <p className="text-base font-medium">No payments yet</p>
          <p className="text-xs text-gray-500">
            Share your SGQR sticker. When a payer settles via /scan, the
            payment appears here within ~2 seconds of finality.
          </p>
          <p className="text-xs">
            <Link href="/scan" className="text-blue-600 hover:underline">
              Test a payment from /scan →
            </Link>
          </p>
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

      <footer className="text-xs text-gray-500 pt-6 border-t border-gray-100 dark:border-gray-800">
        <p>
          Registry:{" "}
          <a
            href={objectUrl(SUIQR.registryId)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-blue-600 hover:underline"
          >
            {SUIQR.registryId.slice(0, 10)}…{SUIQR.registryId.slice(-6)}
          </a>
        </p>
      </footer>
    </main>
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
          {" · "}
          <span className="font-mono text-xs">
            {r.payer.slice(0, 6)}…{r.payer.slice(-4)}
          </span>
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
    return {
      receiptId: `${ev.id.txDigest}_${ev.id.eventSeq}`,
      digest: ev.id.txDigest,
      txDigest: ev.id.txDigest,
      payer: p.payer,
      merchant: p.merchant,
      amount: BigInt(p.amount),
      sgdMinorUnits: Number(p.sgd_minor_units),
      tokenType: p.token_type?.name ?? "",
      memo: p.memo ? new TextDecoder().decode(Uint8Array.from(p.memo)) : "",
      timestampMs: Number(p.timestamp_ms),
    };
  } catch {
    return null;
  }
}

function shortTokenLabel(typeName: string): string {
  // Examples:
  //   "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
  //   "a1ec...::usdc::USDC"
  const parts = typeName.split("::");
  const symbol = parts.at(-1) ?? typeName;
  return symbol;
}

function formatTokenAmount(amount: bigint, symbol: string): string {
  if (symbol === "SUI") {
    const sui = Number(amount) / 1_000_000_000;
    return `${sui < 1 ? sui.toFixed(4) : sui.toFixed(2)} SUI`;
  }
  // Generic: just show as integer + symbol
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
  const ageDay = Math.floor(ageHour / 24);
  return `${ageDay}d ago`;
}
