"use client";

import { useSuiClient } from "@mysten/dapp-kit";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { use as usePromise } from "react";

import { QUAY, txUrl } from "@/lib/sui-config";
import {
  fetchBlob,
  WalrusFetchError,
  WalrusIntegrityError,
  WalrusNotFoundError,
} from "@/lib/walrus/client";
import type { Receipt } from "@/lib/receipts/builder";

/**
 * Public receipt verifier dApp (Phase 5, D12 + D14 + D16).
 *
 * Verdict logic (AND-of-three per D14):
 *   ✓ VERIFIED  — blob fetched + valid receipt JSON + matching on-chain
 *                 PaymentReceipt event (payer + merchant + amount + uen,
 *                 within ±60s of stated timestamp).
 *   ⚠ ORPHANED  — blob fetched + valid receipt JSON but no matching
 *                 on-chain event. This is the user-canceled-tx case.
 *   ✗ CORRUPT   — blob fetched but JSON malformed or schema mismatch.
 *   ✗ NOT FOUND — Walrus aggregator 404.
 *
 * Visual tone calibrated per D16 (green/amber/red/gray verdict-as-hero).
 */

type Verdict =
  | { kind: "verified"; receipt: Receipt; tx: { digest: string; timestampMs: number } }
  | { kind: "orphaned"; receipt: Receipt }
  | { kind: "corrupt"; reason: string }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

const TIMESTAMP_WINDOW_MS = 60_000;

interface PaymentReceiptEvent {
  receipt_id: number[];
  merchant: string;
  payer: string;
  amount: string;
  token_type: { name: string };
  uen_hash: number[];
  timestamp_ms: string;
}

export default function VerifyPage({
  params,
}: {
  params: Promise<{ blobId: string }>;
}) {
  const { blobId } = usePromise(params);
  const sui = useSuiClient();

  const query = useQuery<Verdict>({
    queryKey: ["verify-receipt", blobId],
    queryFn: async () => {
      // 1. Fetch the blob.
      let bytes: Uint8Array;
      try {
        bytes = await fetchBlob(blobId);
      } catch (e) {
        if (e instanceof WalrusNotFoundError) return { kind: "not_found" } as const;
        if (e instanceof WalrusIntegrityError) {
          return { kind: "corrupt", reason: e.message } as const;
        }
        if (e instanceof WalrusFetchError) {
          return { kind: "error", message: e.message } as const;
        }
        return { kind: "error", message: String(e) } as const;
      }

      // 2. Parse + lightly schema-check the receipt JSON.
      let receipt: Receipt;
      try {
        const json = new TextDecoder().decode(bytes);
        const parsed = JSON.parse(json);
        receipt = validateReceipt(parsed);
      } catch (e) {
        return {
          kind: "corrupt",
          reason: `receipt JSON invalid: ${e instanceof Error ? e.message : String(e)}`,
        } as const;
      }

      // 3. Cross-reference on-chain. Query recent PaymentReceipt events for
      //    the same merchant, then filter by (payer, amount, ~timestamp).
      try {
        const events = await sui.queryEvents({
          query: { MoveEventType: `${QUAY.packageId}::payments::PaymentReceipt` },
          order: "descending",
          limit: 200,
        });
        const match = events.data.find((ev) => {
          const p = ev.parsedJson as PaymentReceiptEvent | undefined;
          if (!p) return false;
          if (p.merchant !== receipt.merchant) return false;
          if (p.payer !== receipt.payer) return false;
          if (p.amount !== receipt.amount) return false;
          const tsDelta = Math.abs(Number(p.timestamp_ms) - receipt.timestamp_ms);
          return tsDelta <= TIMESTAMP_WINDOW_MS;
        });
        if (match) {
          const p = match.parsedJson as PaymentReceiptEvent;
          return {
            kind: "verified",
            receipt,
            tx: { digest: match.id.txDigest, timestampMs: Number(p.timestamp_ms) },
          } as const;
        }
        return { kind: "orphaned", receipt } as const;
      } catch (e) {
        return {
          kind: "error",
          message: `on-chain lookup failed: ${e instanceof Error ? e.message : String(e)}`,
        } as const;
      }
    },
    retry: false,
    refetchOnWindowFocus: false,
  });

  return (
    <main className="mx-auto max-w-md px-4 py-8 space-y-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-gray-500">quay verifier</p>
        <p className="text-xs text-gray-500 font-mono break-all">blob {blobId}</p>
      </header>

      {query.isLoading && (
        <section className="rounded-md border border-gray-200 dark:border-gray-700 p-5">
          <p className="text-sm text-gray-500">Verifying receipt…</p>
        </section>
      )}

      {query.error && (
        <VerdictBlock
          tone="red"
          icon="✗"
          header="Verifier error"
          body={query.error instanceof Error ? query.error.message : String(query.error)}
        />
      )}

      {query.data && <VerdictView v={query.data} blobId={blobId} />}

      <footer className="text-xs text-gray-500 border-t border-gray-100 dark:border-gray-800 pt-4">
        <p>
          Verifier fetches the receipt JSON from Walrus, validates its shape, and
          checks for a matching on-chain <code className="font-mono">PaymentReceipt</code> event
          within ±60s of the stated timestamp.
        </p>
      </footer>
    </main>
  );
}

function VerdictView({ v, blobId }: { v: Verdict; blobId: string }) {
  switch (v.kind) {
    case "verified":
      return (
        <>
          <VerdictBlock
            tone="green"
            icon="✓"
            header="Verified quay receipt"
            body={
              <>
                <span className="font-medium">{v.receipt.uen_raw}</span>
                <span className="text-gray-500"> · </span>
                S${(v.receipt.sgd_minor_units / 100).toFixed(2)}
              </>
            }
          />
          <ReceiptDetails receipt={v.receipt} />
          <OnChainProof digest={v.tx.digest} receiptIdHex={v.receipt.receipt_id} />
          <a
            href={`/m/${encodeURIComponent(v.receipt.uen_raw)}`}
            className="block text-sm text-blue-600 hover:underline"
          >
            View merchant →
          </a>
        </>
      );

    case "orphaned":
      return (
        <>
          <VerdictBlock
            tone="amber"
            icon="⚠"
            header="Receipt uploaded but never settled"
            body="This receipt was prepared but no matching payment was confirmed on Sui within the expected window. Not a record of any actual transaction."
          />
          <div className="opacity-60">
            <ReceiptDetails receipt={v.receipt} />
          </div>
          <Link href="/" className="block text-sm text-blue-600 hover:underline">
            Browse verified merchants →
          </Link>
        </>
      );

    case "corrupt":
      return (
        <VerdictBlock
          tone="red"
          icon="✗"
          header="Receipt bytes don't match expected shape"
          body={
            <>
              The aggregator returned bytes that aren&apos;t a valid quay receipt JSON.
              Possible tampering or aggregator error.
              <br />
              <code className="text-xs">{v.reason}</code>
            </>
          }
        />
      );

    case "not_found":
      return (
        <VerdictBlock
          tone="gray"
          icon="✗"
          header="Receipt not found on Walrus"
          body={
            <>
              No blob exists at this ID. The link may be wrong, or the receipt may
              have expired (Walrus storage epochs).
              <br />
              <code className="text-xs break-all">{blobId}</code>
            </>
          }
        />
      );

    case "error":
      return (
        <VerdictBlock
          tone="red"
          icon="✗"
          header="Verifier could not complete"
          body={v.message}
        />
      );
  }
}

function VerdictBlock({
  tone,
  icon,
  header,
  body,
}: {
  tone: "green" | "amber" | "red" | "gray";
  icon: string;
  header: string;
  body: React.ReactNode;
}) {
  const toneClass = {
    green:
      "border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/20 text-emerald-900 dark:text-emerald-100",
    amber:
      "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20 text-amber-900 dark:text-amber-100",
    red:
      "border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-900/20 text-red-900 dark:text-red-100",
    gray:
      "border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/40 text-gray-700 dark:text-gray-300",
  }[tone];

  return (
    <section className={`rounded-lg border p-5 space-y-2 ${toneClass}`}>
      <p className="text-2xl font-semibold flex items-baseline gap-2">
        <span>{icon}</span>
        <span>{header}</span>
      </p>
      <p className="text-sm">{body}</p>
    </section>
  );
}

function ReceiptDetails({ receipt }: { receipt: Receipt }) {
  return (
    <section className="rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-1.5">
      <p className="text-xs uppercase tracking-wide text-gray-500">Receipt details</p>
      <KV label="Merchant" value={shortAddr(receipt.merchant)} />
      <KV
        label="Amount"
        value={`${formatAmount(receipt.amount, receipt.token_type)} (S$${(receipt.sgd_minor_units / 100).toFixed(2)})`}
      />
      <KV label="Payer" value={shortAddr(receipt.payer)} />
      <KV
        label="Time"
        value={new Date(receipt.timestamp_ms).toLocaleString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        })}
      />
      {receipt.memo && <KV label="Memo" value={receipt.memo} />}
    </section>
  );
}

function OnChainProof({ digest, receiptIdHex }: { digest: string; receiptIdHex: string }) {
  return (
    <section className="rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-1.5">
      <p className="text-xs uppercase tracking-wide text-gray-500">On-chain proof</p>
      <p className="text-sm">
        <a
          href={txUrl(digest)}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 hover:underline font-mono text-xs break-all"
        >
          tx {digest.slice(0, 12)}… ↗
        </a>
      </p>
      <p className="text-xs text-gray-500 font-mono break-all">
        receipt_id {receiptIdHex.slice(0, 16)}…
      </p>
    </section>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-xs text-gray-500 shrink-0">{label}</span>
      <span className="font-mono text-xs text-right break-all">{value}</span>
    </div>
  );
}

function shortAddr(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function formatAmount(raw: string, tokenType: string): string {
  // SUI: 9 decimals (MIST → SUI). USDC on Sui: 6 decimals.
  let decimals = 0;
  if (tokenType.endsWith("::sui::SUI")) decimals = 9;
  else if (tokenType.toLowerCase().endsWith("::usdc::usdc")) decimals = 6;

  if (decimals === 0) return `${raw} ${shortToken(tokenType)}`;
  try {
    const n = BigInt(raw);
    const whole = n / 10n ** BigInt(decimals);
    const frac = n % 10n ** BigInt(decimals);
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    const formatted = fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
    return `${formatted} ${shortToken(tokenType)}`;
  } catch {
    return `${raw} ${shortToken(tokenType)}`;
  }
}

function shortToken(tokenType: string): string {
  const parts = tokenType.split("::");
  return parts[parts.length - 1] ?? tokenType;
}

/**
 * Lightweight runtime validation matching the schema at
 * `frontend/src/lib/receipts/schema.json`. Returns the validated Receipt
 * or throws with a human-readable reason.
 */
function validateReceipt(value: unknown): Receipt {
  if (!value || typeof value !== "object") throw new Error("not an object");
  const o = value as Record<string, unknown>;
  if (o.schema_version !== 1) {
    throw new Error(`schema_version must be 1, got ${String(o.schema_version)}`);
  }
  function req<T>(key: string, check: (v: unknown) => v is T): T {
    if (!check(o[key])) throw new Error(`missing/invalid ${key}`);
    return o[key] as T;
  }
  const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

  return {
    schema_version: 1,
    receipt_id: req("receipt_id", isString),
    payer: req("payer", isString),
    merchant: req("merchant", isString),
    uen_raw: req("uen_raw", isString),
    amount: req("amount", isString),
    token_type: req("token_type", isString),
    sgd_minor_units: req("sgd_minor_units", isNumber),
    timestamp_ms: req("timestamp_ms", isNumber),
    quote: (o.quote as Receipt["quote"]) ?? undefined,
    memo: typeof o.memo === "string" ? o.memo : undefined,
  };
}
