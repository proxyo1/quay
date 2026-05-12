"use client";

import { ConnectButton, useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
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
import { SUIQR, objectUrl } from "@/lib/sui-config";

type Source = "scan" | "manual";

type Input =
  | { kind: "empty" }
  | {
      kind: "ok";
      source: Source;
      uen: string;
      /** Only present when source === "scan" — the full parsed SGQR payload. */
      payload?: SgqrPayload;
    }
  | { kind: "error"; message: string };

type Lookup =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "registered"; address: string }
  | { kind: "not_registered" }
  | { kind: "error"; message: string };

/** UEN of the staged demo merchant (KOPI HOUSE) for the "Try an example" link. */
const EXAMPLE_UEN = "T11KH0001A";

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
    if (!looksLikeUen(upper)) {
      setInput({ kind: "ok", source: "manual", uen: upper });
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
            "Mobile-number PayNow (proxy type 0) isn't supported in V0 — UEN PayNow only. Type a UEN instead, or scan a business SGQR.",
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

  // Whenever we have a valid UEN, run the on-chain registration lookup.
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

  return (
    <main className="mx-auto max-w-2xl px-6 py-10 space-y-8">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold">suiqr · scan</h1>
        <p className="text-sm text-gray-500">
          Scan a merchant&apos;s SGQR sticker with your camera, or type their UEN
          directly. Camera capture auto-fills the UEN once a valid QR is in
          frame.
        </p>
      </header>

      <section className="flex items-center justify-between rounded-md border border-gray-200 dark:border-gray-700 px-4 py-3">
        <span className="text-sm">
          Wallet:{" "}
          {account ? (
            <code className="font-mono text-xs">
              {account.address.slice(0, 6)}…{account.address.slice(-4)}
            </code>
          ) : (
            <span className="text-gray-400">not connected</span>
          )}
        </span>
        <ConnectButton />
      </section>

      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-500">Merchant</p>
            <p className="text-sm font-medium">Scan or type a UEN</p>
          </div>
          <button
            type="button"
            onClick={() => setScanOpen(true)}
            className="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 inline-flex items-center gap-1.5"
          >
            <CameraIcon />
            Scan SGQR
          </button>
        </div>

        <div>
          <label htmlFor="uen" className="block text-xs text-gray-500 mb-1">
            UEN
          </label>
          <input
            id="uen"
            type="text"
            value={uen}
            onChange={(e) => setManualUen(e.target.value)}
            placeholder="T11KH0001A"
            className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 font-mono"
          />
          {uen && !looksLikeUen(uen) && (
            <p className="text-xs text-amber-600 mt-1">
              Doesn&apos;t look like a UEN. Expected 8–10 alphanumeric chars (e.g., 202012345Z, T12LL3456A).
            </p>
          )}
          <button
            type="button"
            onClick={() => setManualUen(EXAMPLE_UEN)}
            className="text-xs text-blue-600 hover:underline mt-2"
          >
            ↳ Try the demo UEN ({EXAMPLE_UEN})
          </button>
        </div>
      </section>

      {input.kind === "error" && (
        <section className="rounded-md border border-red-200 bg-red-50 dark:bg-red-900/20 px-4 py-3">
          <p className="text-sm text-red-800 dark:text-red-300">{input.message}</p>
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

      <footer className="text-xs text-gray-500 space-y-1">
        <p>
          On-chain registry:{" "}
          <a
            href={objectUrl(SUIQR.registryId)}
            target="_blank"
            rel="noreferrer noopener"
            className="text-blue-600 hover:underline font-mono"
          >
            {SUIQR.registryId.slice(0, 10)}…{SUIQR.registryId.slice(-6)}
          </a>{" "}
          on {SUIQR.network}
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
    <section className="space-y-3 rounded-md border border-gray-200 dark:border-gray-700 px-4 py-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-sm">UEN {input.uen}</h2>
        <span className="text-xs text-gray-500">
          {input.source === "scan" ? "captured by camera" : "typed manually"}
        </span>
      </div>

      {payload && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {name && (
            <>
              <dt className="text-gray-500">Merchant</dt>
              <dd className="font-medium">{name}</dd>
            </>
          )}
          {city && (
            <>
              <dt className="text-gray-500">City</dt>
              <dd>{city}</dd>
            </>
          )}
          <dt className="text-gray-500">Type</dt>
          <dd>{payload.pointOfInitiationMethod}</dd>
          {payload.transactionAmount && (
            <>
              <dt className="text-gray-500">Suggested</dt>
              <dd>
                {payload.transactionAmount}{" "}
                {payload.transactionCurrency === "702" ? "SGD" : payload.transactionCurrency}
              </dd>
            </>
          )}
          {payload.additionalData?.billNumber && (
            <>
              <dt className="text-gray-500">Bill</dt>
              <dd>{payload.additionalData.billNumber}</dd>
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
    return <p className="text-xs text-gray-500">Looking up on-chain…</p>;
  }
  if (lookup.kind === "registered") {
    return (
      <p className="text-xs text-emerald-700 dark:text-emerald-300">
        ✓ Registered — pays to{" "}
        <code className="font-mono">
          {lookup.address.slice(0, 6)}…{lookup.address.slice(-4)}
        </code>
      </p>
    );
  }
  if (lookup.kind === "not_registered") {
    return (
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {typed
          ? "This UEN isn't on the suiqr registry yet."
          : "This merchant isn't on the suiqr registry yet — their SGQR will keep working for regular PayNow, just not on chain."}
      </p>
    );
  }
  return (
    <p className="text-xs text-red-600">Lookup failed: {lookup.message}</p>
  );
}

function CameraIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

function buildDevInspectQuery(uenBytes: Uint8Array): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${SUIQR.packageId}::payments::merchant_address`,
    arguments: [
      tx.object(SUIQR.registryId),
      tx.pure.vector("u8", Array.from(uenBytes)),
    ],
  });
  return tx;
}
