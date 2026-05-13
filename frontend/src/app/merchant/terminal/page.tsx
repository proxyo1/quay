"use client";

import { useSuiClient, useSuiClientQuery } from "@mysten/dapp-kit";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";

import { useZkLoginSession } from "@/lib/zklogin";
import { getEntriesTableId } from "@/lib/quay";
import { QUAY, objectUrl, txUrl } from "@/lib/sui-config";
import { getBlobUrl } from "@/lib/walrus/client";

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
}

export default function TerminalPage() {
  const { session, hydrated, signOut } = useZkLoginSession();
  const router = useRouter();

  useEffect(() => {
    if (hydrated && !session) {
      router.replace("/merchant/login?next=/merchant/terminal");
    }
  }, [hydrated, session, router]);

  if (hydrated && !session) {
    return (
      <main className="relative z-10 mx-auto w-full max-w-md px-5 py-16">
        <p className="text-sm text-neutral-500">Redirecting to sign-in…</p>
      </main>
    );
  }

  return <TerminalView session={session} onSignOut={signOut} />;
}

interface MerchantUen {
  uen: string;
  digest: string;
  timestamp: number;
  metadataBlobId: string | null;
}

interface MerchantRegisteredEvent {
  uen_hash: number[];
  sui_address: string;
  timestamp_ms: string;
}

function useMerchantUens(address: string | undefined) {
  const sui = useSuiClient();
  return useQuery<MerchantUen[]>({
    queryKey: ["merchant-uens", address],
    queryFn: async () => {
      if (!address) return [];
      const tableId = await getEntriesTableId(sui, QUAY.registryId);
      const events = await sui.queryEvents({
        query: { MoveEventType: `${QUAY.packageId}::payments::MerchantRegistered` },
        order: "descending",
        limit: 100,
      });
      const mine = events.data.filter(
        (e) => (e.parsedJson as MerchantRegisteredEvent | undefined)?.sui_address === address,
      );
      const entries = await Promise.all(
        mine.map(async (e) => {
          const ev = e.parsedJson as MerchantRegisteredEvent;
          try {
            const field = await sui.getDynamicFieldObject({
              parentId: tableId,
              name: { type: "vector<u8>", value: ev.uen_hash },
            });
            const extracted = extractEntryFields(field.data?.content);
            if (!extracted) return null;
            return {
              uen: extracted.uen,
              metadataBlobId: extracted.metadataBlobId,
              digest: e.id.txDigest,
              timestamp: Number(ev.timestamp_ms),
            };
          } catch {
            return null;
          }
        }),
      );
      return entries.filter((x): x is MerchantUen => x !== null);
    },
    enabled: !!address,
    refetchInterval: 10_000,
  });
}

function extractEntryFields(
  content: unknown,
): { uen: string; metadataBlobId: string | null } | null {
  if (!content || typeof content !== "object") return null;
  const c = content as { dataType?: string; fields?: Record<string, unknown> };
  if (c.dataType !== "moveObject") return null;
  const value = c.fields?.value as { fields?: Record<string, unknown> } | undefined;
  const fields = value?.fields;
  if (!fields) return null;

  const uenRaw = fields.uen_raw;
  let uen: string | null = null;
  if (Array.isArray(uenRaw)) {
    uen = new TextDecoder().decode(new Uint8Array(uenRaw as number[]));
  } else if (typeof uenRaw === "string") {
    uen = uenRaw;
  }
  if (!uen) return null;

  const meta = fields.metadata_uri;
  const metadataBlobId = typeof meta === "string" && meta.length > 0 ? meta : null;

  return { uen, metadataBlobId };
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

  const { data, error, isLoading } = useSuiClientQuery(
    "queryEvents",
    {
      query: { MoveEventType: `${QUAY.packageId}::payments::PaymentReceipt` },
      order: "descending",
      limit: 50,
    },
    {
      refetchInterval: 2000,
      refetchIntervalInBackground: false,
      enabled: !!session,
    },
  );

  const receipts: NormalizedReceipt[] = useMemo(() => {
    if (!data?.data || !session) return [];
    return data.data
      .map((ev) => normalizeEvent(ev))
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
          className="text-xs px-3 py-1.5 rounded-full border border-white/15 text-neutral-300 hover:bg-white/5"
        >
          Sign out
        </button>
      </header>

      <section className="space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-semibold tracking-tight">Terminal</h1>
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-[var(--accent)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] live-dot" />
            live
          </span>
        </div>
        {session && (
          <p className="text-[11px] text-neutral-500 font-mono">
            {session.email} · {session.address.slice(0, 8)}…{session.address.slice(-6)}
          </p>
        )}
      </section>

      <section className="relative rounded-3xl border border-[var(--accent)]/30 bg-gradient-to-b from-[var(--accent)]/[0.08] to-transparent p-6 overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(500px_240px_at_50%_-60px,var(--accent-glow),transparent_60%)]" />
        <p className="text-[11px] uppercase tracking-wider text-neutral-400">
          Today · {todayCount} payment{todayCount === 1 ? "" : "s"}
        </p>
        <p className="mt-1 text-5xl font-semibold tabular-nums text-white">
          ${todayTotalSgd.toFixed(2)}
          <span className="ml-2 text-xl text-neutral-500 font-normal">SGD</span>
        </p>
        <div className="mt-3 flex gap-4 text-[11px] text-neutral-400">
          <span>
            avg <span className="text-white tabular-nums">${avgTicket.toFixed(2)}</span>
          </span>
          <span>·</span>
          <span>refreshes every 2s</span>
        </div>
      </section>

      {latest && latestIsRecent && (
        <section className="rounded-2xl border border-[var(--success)]/30 bg-[var(--success)]/[0.06] p-3 animate-in fade-in">
          <div className="flex items-center gap-3">
            <span className="inline-block h-2 w-2 rounded-full bg-[var(--success)] live-dot shrink-0" />
            <div className="flex-1 min-w-0 text-sm text-white">
              <span className="font-semibold tabular-nums">
                ${(latest.sgdMinorUnits / 100).toFixed(2)} SGD
              </span>
              <span className="text-neutral-400"> from </span>
              <span className="font-mono">
                {latest.payer.slice(0, 6)}…{latest.payer.slice(-4)}
              </span>
              <span className="text-neutral-400"> · {formatRelativeTime(latest.timestampMs)}</span>
            </div>
          </div>
        </section>
      )}

      <UenList state={uens} />

      {error ? (
        <section className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 space-y-1">
          <p className="text-sm font-medium text-red-300">Event query failed</p>
          <p className="text-xs text-red-300/80 break-words">
            {error instanceof Error ? error.message : String(error)}
          </p>
        </section>
      ) : isLoading && receipts.length === 0 ? (
        <p className="text-sm text-neutral-500 text-center py-6">Listening for payments…</p>
      ) : receipts.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="space-y-2">
          <h3 className="text-[10px] uppercase tracking-wider text-neutral-500 px-1">Recent</h3>
          <ul className="space-y-2">
            {receipts.map((r, i) => (
              <ReceiptCard key={r.receiptId} r={r} highlight={i === 0 && latestIsRecent} />
            ))}
          </ul>
        </section>
      )}

      <footer className="text-[11px] text-neutral-500 pt-4 border-t border-white/5">
        Registry:{" "}
        <a
          href={objectUrl(QUAY.registryId)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[var(--accent)] hover:underline"
        >
          {QUAY.registryId.slice(0, 8)}…{QUAY.registryId.slice(-6)}
        </a>
      </footer>
    </main>
  );
}

function EmptyState() {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-center space-y-2">
      <div className="mx-auto h-12 w-12 rounded-full bg-[var(--accent)]/10 border border-[var(--accent)]/30 flex items-center justify-center">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
      </div>
      <p className="text-base font-medium text-white">No payments yet</p>
      <p className="text-xs text-neutral-500">
        Once a payer scans your SGQR, the payment appears here ~2s after finality.
      </p>
      <div className="pt-1 flex justify-center gap-3">
        <Link href="/merchant/onboard" className="text-xs text-[var(--accent)] hover:underline">
          Onboard UEN →
        </Link>
        <span className="text-neutral-700">·</span>
        <Link href="/scan" className="text-xs text-[var(--accent)] hover:underline">
          Test from scan →
        </Link>
      </div>
    </section>
  );
}

function UenList({ state }: { state: ReturnType<typeof useMerchantUens> }) {
  if (state.isLoading) {
    return (
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <p className="text-[11px] uppercase tracking-wider text-neutral-500">Your UENs</p>
        <p className="mt-2 text-sm text-neutral-500">Loading from chain…</p>
      </section>
    );
  }
  if (state.error) {
    return (
      <section className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4">
        <p className="text-[11px] uppercase tracking-wider text-red-300">Your UENs</p>
        <p className="mt-1 text-xs text-red-300/80">
          {state.error instanceof Error ? state.error.message : String(state.error)}
        </p>
      </section>
    );
  }
  const uens = state.data ?? [];
  if (uens.length === 0) {
    return (
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <p className="text-[11px] uppercase tracking-wider text-neutral-500">Your UENs</p>
        <p className="mt-2 text-sm text-neutral-400">
          No UENs claimed yet.{" "}
          <Link href="/merchant/onboard" className="text-[var(--accent)] hover:underline">
            Onboard one →
          </Link>
        </p>
      </section>
    );
  }
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 space-y-2">
      <p className="text-[11px] uppercase tracking-wider text-neutral-500">
        Your UEN{uens.length > 1 ? "s" : ""}
      </p>
      <ul className="space-y-2">
        {uens.map((u) => (
          <li key={u.uen} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <MerchantLogo blobId={u.metadataBlobId} alt={u.uen} />
              <span className="font-mono text-sm text-white truncate">{u.uen}</span>
            </div>
            <a
              href={txUrl(u.digest)}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-[var(--accent)] hover:underline font-mono shrink-0"
              title={`Registered ${new Date(u.timestamp).toLocaleString()}`}
            >
              registration ↗
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
      <span className="inline-flex items-center justify-center h-7 w-7 rounded-lg bg-[var(--accent)]/15 border border-[var(--accent)]/40 text-[10px] font-semibold text-[var(--accent-strong)] shrink-0">
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
        className="h-7 w-7 rounded-lg object-cover"
      />
      <span
        className="absolute inset-0 hidden items-center justify-center rounded-lg bg-[var(--accent)]/15 border border-[var(--accent)]/40 text-[10px] font-semibold text-[var(--accent-strong)]"
      >
        {initial}
      </span>
    </span>
  );
}

function ReceiptCard({ r, highlight }: { r: NormalizedReceipt; highlight: boolean }) {
  const tokenLabel = shortTokenLabel(r.tokenType);
  return (
    <li
      className={`rounded-2xl border bg-white/[0.02] p-4 ${
        highlight ? "border-[var(--accent)]/40 shadow-[0_0_30px_-12px_var(--accent-glow)]" : "border-white/10"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-full bg-[var(--success)]/10 border border-[var(--success)]/40 flex items-center justify-center text-[var(--success)] shrink-0">
          <ArrowDown />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-lg font-semibold tabular-nums text-white">
              ${(r.sgdMinorUnits / 100).toFixed(2)}{" "}
              <span className="text-xs text-neutral-500 font-normal">SGD</span>
            </p>
            <span className="text-[11px] text-neutral-500 tabular-nums shrink-0">
              {formatRelativeTime(r.timestampMs)}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-neutral-400 font-mono truncate">
            {formatTokenAmount(r.amount, tokenLabel)} from {r.payer.slice(0, 6)}…{r.payer.slice(-4)}
          </p>
          {r.memo && (
            <p className="mt-1.5 text-xs text-neutral-300 italic">&ldquo;{r.memo}&rdquo;</p>
          )}
          <a
            href={txUrl(r.txDigest)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-[11px] text-[var(--accent)] hover:underline font-mono"
          >
            tx ↗
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
  const ageDay = Math.floor(ageHour / 24);
  return `${ageDay}d ago`;
}
