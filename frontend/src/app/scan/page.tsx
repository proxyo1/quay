"use client";

import { ConnectButton, useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import Link from "next/link";
import { useEffect, useState } from "react";

import { PayPanel } from "@/components/PayPanel";
import { SgqrCameraScanner } from "@/components/SgqrCameraScanner";
import {
  extractPayNow,
  looksLikeUen,
  parseSgqr,
  sanitizeMerchantCity,
  sanitizeMerchantName,
  type SgqrPayload,
} from "@/lib/sgqr";
import { QUAY, objectUrl } from "@/lib/sui-config";

type Source = "scan" | "manual";

type Input =
  | { kind: "empty" }
  | {
      kind: "ok";
      source: Source;
      uen: string;
      payload?: SgqrPayload;
    }
  | { kind: "error"; message: string };

type Lookup =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "registered"; address: string }
  | { kind: "not_registered" }
  | { kind: "error"; message: string };

const EXAMPLE_UEN = "202412345Z";

export default function ScanPage() {
  const account = useCurrentAccount();
  const sui = useSuiClient();

  const [uen, setUen] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [input, setInput] = useState<Input>({ kind: "empty" });
  const [lookup, setLookup] = useState<Lookup>({ kind: "idle" });

  function setManualUen(value: string) {
    const upper = value.trim().toUpperCase();
    setUen(upper);
    setLookup({ kind: "idle" });
    if (!upper) {
      setInput({ kind: "empty" });
      return;
    }
    setInput({ kind: "ok", source: "manual", uen: upper });
  }

  function onScanResult(text: string) {
    setScanOpen(false);
    try {
      const payload = parseSgqr(text.trim());
      if (!payload.crcValid) {
        setInput({ kind: "error", message: "Scanned QR has an invalid CRC — not an SGQR." });
        return;
      }
      const payNow = extractPayNow(payload);
      if (!payNow) {
        setInput({ kind: "error", message: "Scanned QR isn't an SG.PAYNOW code." });
        return;
      }
      if (payNow.proxyType === "mobile") {
        setInput({
          kind: "error",
          message:
            "Mobile-number PayNow isn't supported in V0 — UEN PayNow only. Type a UEN instead.",
        });
        return;
      }
      if (payNow.proxyType !== "uen") {
        setInput({
          kind: "error",
          message: `Proxy type '${payNow.proxyType}' isn't supported. UEN only in V0.`,
        });
        return;
      }
      setUen(payNow.proxyValue);
      setLookup({ kind: "idle" });
      setInput({ kind: "ok", source: "scan", uen: payNow.proxyValue, payload });
    } catch (e) {
      setInput({
        kind: "error",
        message: `Couldn't parse the scanned QR: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  useEffect(() => {
    if (input.kind !== "ok" || !looksLikeUen(input.uen)) {
      setLookup({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setLookup({ kind: "loading" });
    (async () => {
      try {
        const uenBytes = new TextEncoder().encode(input.uen);
        const result = await sui.devInspectTransactionBlock({
          sender: account?.address ?? `0x${"0".repeat(64)}`,
          transactionBlock: buildDevInspectQuery(uenBytes),
        });
        if (cancelled) return;
        const status = result.effects?.status?.status;
        if (status !== "success") {
          setLookup({ kind: "not_registered" });
          return;
        }
        const ret = result.results?.[0]?.returnValues?.[0];
        if (!ret) {
          setLookup({ kind: "not_registered" });
          return;
        }
        const [bytes] = ret;
        const hex = "0x" + Array.from(bytes as number[])
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        setLookup({ kind: "registered", address: hex });
      } catch (e) {
        if (!cancelled) {
          setLookup({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [input, sui, account?.address]);

  const okInput = input.kind === "ok" ? input : null;
  const merchantName = okInput?.payload?.merchantName;
  const showHero = input.kind === "empty";

  return (
    <main className="relative z-10 mx-auto w-full max-w-md px-5 py-6 space-y-6">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-[var(--accent)] hover:underline text-sm inline-flex items-center gap-1">
          <span aria-hidden>←</span> home
        </Link>
        <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] uppercase tracking-wider text-neutral-400">
          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] live-dot align-middle" />
          testnet
        </span>
      </header>

      <section className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Scan to pay</h1>
        <p className="text-sm text-neutral-400">
          Point your camera at any SGQR sticker — or type a UEN below.
        </p>
      </section>

      <WalletCard account={account} />

      {showHero && <ScanHeroIllustration />}

      <button
        type="button"
        onClick={() => setScanOpen(true)}
        className="group flex w-full items-center justify-between rounded-2xl bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white font-medium py-4 px-5 transition shadow-[0_8px_30px_-8px_var(--accent-glow)]"
      >
        <span className="flex items-center gap-2.5">
          <CameraIcon />
          Open camera
        </span>
        <span className="text-white/70 group-hover:text-white transition">→</span>
      </button>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 space-y-2">
        <label htmlFor="uen" className="block text-[11px] uppercase tracking-wider text-[var(--accent)]">
          UEN code
        </label>
        <input
          id="uen"
          type="text"
          value={uen}
          onChange={(e) => setManualUen(e.target.value)}
          placeholder="T11KH0001A"
          className="w-full bg-transparent border-0 px-0 py-1 text-lg font-mono tabular-nums text-white placeholder:text-neutral-600 focus:outline-none"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
        />
        <div className="flex items-center justify-between pt-1 border-t border-white/5">
          {uen && !looksLikeUen(uen) ? (
            <p className="text-[11px] text-amber-400">
              Expected 8–10 alphanumeric (e.g., 202012345Z).
            </p>
          ) : (
            <p className="text-[11px] text-neutral-500">8–10 alphanumeric Singapore UEN</p>
          )}
          <button
            type="button"
            onClick={() => setManualUen(EXAMPLE_UEN)}
            className="text-[11px] text-[var(--accent)] hover:underline shrink-0"
          >
            try demo →
          </button>
        </div>
      </section>

      {input.kind === "error" && (
        <section className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm text-red-300">{input.message}</p>
        </section>
      )}

      {okInput && looksLikeUen(okInput.uen) && (
        <ResultPane input={okInput} lookup={lookup} />
      )}

      {okInput &&
        looksLikeUen(okInput.uen) &&
        lookup.kind === "registered" && (
          <PayPanel
            merchantAddress={lookup.address}
            merchantName={merchantName}
            uen={okInput.uen}
          />
        )}

      <footer className="text-[11px] text-neutral-500 pt-4 border-t border-white/5">
        <p>
          On-chain registry:{" "}
          <a
            href={objectUrl(QUAY.registryId)}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[var(--accent)] hover:underline font-mono"
          >
            {QUAY.registryId.slice(0, 8)}…{QUAY.registryId.slice(-6)}
          </a>{" "}
          on {QUAY.network}
        </p>
      </footer>

      {scanOpen && (
        <SgqrCameraScanner
          onDecoded={onScanResult}
          onCancel={() => setScanOpen(false)}
        />
      )}
    </main>
  );
}

function WalletCard({ account }: { account: ReturnType<typeof useCurrentAccount> }) {
  if (!account) {
    return (
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-neutral-500">Wallet</p>
          <p className="text-sm text-neutral-300">Not connected</p>
        </div>
        <ConnectButton />
      </section>
    );
  }
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-[var(--accent)]/15 border border-[var(--accent)]/40 flex items-center justify-center shrink-0">
            <WalletIcon />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-wider text-neutral-500">Wallet</p>
            <p className="text-sm font-mono text-white truncate">
              {account.address.slice(0, 6)}…{account.address.slice(-4)}
            </p>
          </div>
        </div>
        <Link href="/history" className="text-xs text-[var(--accent)] hover:underline shrink-0">
          history →
        </Link>
      </div>
    </section>
  );
}

function ScanHeroIllustration() {
  return (
    <div className="relative mx-auto h-[220px] w-full max-w-xs">
      <div className="absolute inset-x-12 inset-y-2 rounded-[34px] border border-white/15 bg-gradient-to-b from-white/[0.03] to-transparent overflow-hidden shadow-[0_30px_80px_-30px_var(--accent-glow)]">
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-24 w-24 rounded-xl bg-white p-2 shadow-[0_0_60px_-10px_var(--accent-glow)]">
          <svg viewBox="0 0 21 21" className="h-full w-full text-black" aria-hidden>
            <rect x="0" y="0" width="7" height="7" fill="currentColor" />
            <rect x="1" y="1" width="5" height="5" fill="white" />
            <rect x="2" y="2" width="3" height="3" fill="currentColor" />
            <rect x="14" y="0" width="7" height="7" fill="currentColor" />
            <rect x="15" y="1" width="5" height="5" fill="white" />
            <rect x="16" y="2" width="3" height="3" fill="currentColor" />
            <rect x="0" y="14" width="7" height="7" fill="currentColor" />
            <rect x="1" y="15" width="5" height="5" fill="white" />
            <rect x="2" y="16" width="3" height="3" fill="currentColor" />
            <rect x="9" y="3" width="1" height="1" fill="currentColor" />
            <rect x="11" y="3" width="1" height="1" fill="currentColor" />
            <rect x="10" y="5" width="1" height="1" fill="currentColor" />
            <rect x="9" y="9" width="1" height="1" fill="currentColor" />
            <rect x="11" y="9" width="1" height="1" fill="currentColor" />
            <rect x="13" y="9" width="1" height="1" fill="currentColor" />
            <rect x="15" y="9" width="1" height="1" fill="currentColor" />
            <rect x="17" y="9" width="1" height="1" fill="currentColor" />
            <rect x="9" y="11" width="1" height="1" fill="currentColor" />
            <rect x="11" y="11" width="1" height="1" fill="currentColor" />
            <rect x="13" y="11" width="1" height="1" fill="currentColor" />
            <rect x="15" y="11" width="1" height="1" fill="currentColor" />
            <rect x="9" y="13" width="1" height="1" fill="currentColor" />
            <rect x="11" y="13" width="1" height="1" fill="currentColor" />
            <rect x="13" y="13" width="1" height="1" fill="currentColor" />
            <rect x="9" y="15" width="1" height="1" fill="currentColor" />
            <rect x="11" y="15" width="1" height="1" fill="currentColor" />
            <rect x="13" y="15" width="1" height="1" fill="currentColor" />
            <rect x="15" y="15" width="1" height="1" fill="currentColor" />
            <rect x="17" y="15" width="1" height="1" fill="currentColor" />
            <rect x="9" y="17" width="1" height="1" fill="currentColor" />
            <rect x="13" y="17" width="1" height="1" fill="currentColor" />
          </svg>
        </div>
        <div className="absolute left-6 right-6 top-1/2 h-px bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent shadow-[0_0_18px_4px_var(--accent)] scan-sweep" />
      </div>
    </div>
  );
}

function ResultPane({
  input,
  lookup,
}: {
  input: Extract<Input, { kind: "ok" }>;
  lookup: Lookup;
}) {
  const payload = input.payload;
  const name = sanitizeMerchantName(payload?.merchantName);
  const city = sanitizeMerchantCity(payload?.merchantCity);

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-wider text-neutral-500">
          UEN <span className="font-mono text-white normal-case">{input.uen}</span>
        </p>
        <span className="text-[11px] text-neutral-500">
          {input.source === "scan" ? "captured by camera" : "typed manually"}
        </span>
      </div>

      {payload && (name || city || payload.transactionAmount) && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-sm">
          {name && (
            <>
              <dt className="text-neutral-500 text-xs">Merchant</dt>
              <dd className="text-white font-medium">{name}</dd>
            </>
          )}
          {city && (
            <>
              <dt className="text-neutral-500 text-xs">City</dt>
              <dd className="text-neutral-300">{city}</dd>
            </>
          )}
          {payload.transactionAmount && (
            <>
              <dt className="text-neutral-500 text-xs">Suggested</dt>
              <dd className="text-neutral-300">
                {payload.transactionAmount}{" "}
                {payload.transactionCurrency === "702" ? "SGD" : payload.transactionCurrency}
              </dd>
            </>
          )}
        </dl>
      )}

      <RegistryStatus lookup={lookup} typed={input.source === "manual"} />
    </section>
  );
}

function RegistryStatus({ lookup, typed }: { lookup: Lookup; typed: boolean }) {
  if (lookup.kind === "idle" || lookup.kind === "loading") {
    return (
      <p className="text-xs text-neutral-500 inline-flex items-center gap-2">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-neutral-500 animate-pulse" />
        Looking up on chain…
      </p>
    );
  }
  if (lookup.kind === "registered") {
    return (
      <p className="text-xs text-[var(--success)] inline-flex items-center gap-2">
        <CheckIcon />
        Registered · pays to{" "}
        <code className="font-mono">
          {lookup.address.slice(0, 6)}…{lookup.address.slice(-4)}
        </code>
      </p>
    );
  }
  if (lookup.kind === "not_registered") {
    return (
      <p className="text-xs text-neutral-400">
        {typed
          ? "This UEN isn't on the quay registry yet."
          : "Merchant isn't on the quay registry — their SGQR still works for regular PayNow."}
      </p>
    );
  }
  return (
    <p className="text-xs text-red-400">Lookup failed: {lookup.message}</p>
  );
}

function CameraIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)]">
      <path d="M20 12V8a2 2 0 0 0-2-2H4a2 2 0 0 0 0 4h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6" />
      <path d="M18 12h.01" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function buildDevInspectQuery(uenBytes: Uint8Array): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${QUAY.packageId}::payments::merchant_address`,
    arguments: [
      tx.object(QUAY.registryId),
      tx.pure.vector("u8", Array.from(uenBytes)),
    ],
  });
  return tx;
}
