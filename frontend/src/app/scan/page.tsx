"use client";

import { ConnectButton, useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { useEffect, useMemo, useState } from "react";

import { SUIQR, objectUrl } from "@/lib/sui-config";
import { sanitizeMerchantCity, sanitizeMerchantName } from "@/lib/sgqr";
import { extractPayNow, parseSgqr, type PayNowInfo, type SgqrPayload } from "@/lib/sgqr";

type ParseState =
  | { kind: "idle" }
  | { kind: "ok"; payload: SgqrPayload; payNow: PayNowInfo | null }
  | { kind: "error"; message: string };

type RegistryLookup =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "registered"; address: string }
  | { kind: "not_registered" }
  | { kind: "error"; message: string };

/**
 * Day 3 demo page. Paste an SGQR payload (or type a UEN with the manual
 * fallback per AD5), see it parsed, sanitized, and looked up against the
 * on-chain MerchantRegistry. No camera yet — that ships once we have real
 * SGQR photos to test against.
 */
export default function ScanPage() {
  const account = useCurrentAccount();
  const sui = useSuiClient();

  const [raw, setRaw] = useState("");
  const [state, setState] = useState<ParseState>({ kind: "idle" });
  const [lookup, setLookup] = useState<RegistryLookup>({ kind: "idle" });

  const example = useMemo(
    () =>
      "00020101021126370010SG.PAYNOW010220210202412345Z030105204000053037025802SG5915FOOD-COURT KIOSK6009Singapore62160512BillNumber123",
    [],
  );

  function onParse(input: string) {
    setLookup({ kind: "idle" });
    if (!input.trim()) {
      setState({ kind: "idle" });
      return;
    }
    try {
      const payload = parseSgqr(input.trim());
      const payNow = extractPayNow(payload);
      setState({ kind: "ok", payload, payNow });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  function onTypeUen(uen: string) {
    // Manual fallback: user types a UEN directly (no SGQR). We construct a
    // minimal PayNowInfo so the on-chain lookup path is reusable.
    setRaw("");
    if (!uen.trim()) {
      setState({ kind: "idle" });
      return;
    }
    setState({
      kind: "ok",
      payload: {
        payloadFormatIndicator: "(manual)",
        pointOfInitiationMethod: "static",
        merchantAccountInfo: [],
        crc: "(n/a)",
        crcValid: true,
        raw: `(manual UEN entry: ${uen})`,
      },
      payNow: {
        tag: "(manual)",
        proxyType: "uen",
        proxyValue: uen.trim(),
        editable: false,
      },
    });
  }

  // Lookup the parsed UEN against the on-chain registry whenever a UEN appears.
  useEffect(() => {
    if (state.kind !== "ok" || !state.payNow || state.payNow.proxyType !== "uen") {
      setLookup({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setLookup({ kind: "loading" });
    (async () => {
      try {
        const uenBytes = new TextEncoder().encode(state.payNow!.proxyValue);
        // Compute the registry key off-chain: blake2b256(b"PAYNOW_UEN_V1" || uen).
        // We can call the view function `merchant_address` via devInspect to
        // get back the on-chain address (which aborts if not registered).
        const result = await sui.devInspectTransactionBlock({
          sender: account?.address ?? "0x0",
          transactionBlock: buildDevInspectQuery(uenBytes),
        });
        if (cancelled) return;
        const status = result.effects?.status?.status;
        if (status !== "success") {
          // is_registered returns false, OR merchant_address aborted
          setLookup({ kind: "not_registered" });
          return;
        }
        const ret = result.results?.[0]?.returnValues?.[0];
        if (!ret) {
          setLookup({ kind: "not_registered" });
          return;
        }
        // returnValues[0] is [bytes[], typeName]. For an address return,
        // bytes[] is the 32-byte raw address.
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
  }, [state, sui, account?.address]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-10 space-y-8">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold">suiqr · scan</h1>
        <p className="text-sm text-gray-500">
          Paste an SGQR payload below, or type a UEN directly. Camera scanning
          ships once we field-test against real Singapore SGQR stickers.
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

      <section className="space-y-3">
        <label className="block text-sm font-medium">SGQR payload</label>
        <textarea
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            onParse(e.target.value);
          }}
          rows={4}
          placeholder="00020101021126..."
          className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-transparent p-3 font-mono text-xs"
        />
        <button
          type="button"
          onClick={() => {
            setRaw(example);
            onParse(example);
          }}
          className="text-xs text-blue-600 hover:underline"
        >
          ↳ load example
        </button>
      </section>

      <section className="space-y-3">
        <label className="block text-sm font-medium">
          …or type a UEN directly{" "}
          <span className="text-xs text-gray-500">(manual fallback, AD5)</span>
        </label>
        <input
          type="text"
          placeholder="202012345Z"
          className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-transparent p-3 font-mono text-sm"
          onChange={(e) => onTypeUen(e.target.value)}
        />
      </section>

      <ResultPane state={state} lookup={lookup} />

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
    </main>
  );
}

function ResultPane({ state, lookup }: { state: ParseState; lookup: RegistryLookup }) {
  if (state.kind === "idle") return null;
  if (state.kind === "error") {
    return (
      <section className="rounded-md border border-red-200 bg-red-50 dark:bg-red-900/20 px-4 py-3">
        <p className="text-sm text-red-800 dark:text-red-300">
          <strong>Parse error:</strong> {state.message}
        </p>
      </section>
    );
  }

  const { payload, payNow } = state;
  const name = sanitizeMerchantName(payload.merchantName);
  const city = sanitizeMerchantCity(payload.merchantCity);

  return (
    <section className="space-y-4 rounded-md border border-gray-200 dark:border-gray-700 px-4 py-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Parsed</h2>
        <span
          className={`text-xs px-2 py-1 rounded ${
            payload.crcValid
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
              : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
          }`}
        >
          CRC {payload.crcValid ? "valid" : "MISMATCH"}
        </span>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-500">Merchant</dt>
        <dd className="font-medium">{name || <em className="text-gray-400">(none)</em>}</dd>
        <dt className="text-gray-500">City</dt>
        <dd>{city || <em className="text-gray-400">(none)</em>}</dd>
        <dt className="text-gray-500">Type</dt>
        <dd>{payload.pointOfInitiationMethod}</dd>
        {payload.transactionAmount && (
          <>
            <dt className="text-gray-500">Amount</dt>
            <dd>
              {payload.transactionAmount} {payload.transactionCurrency === "702" ? "SGD" : payload.transactionCurrency}
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

      {payNow ? (
        <div
          className={`rounded-md border px-3 py-3 text-sm ${
            payNow.proxyType === "uen"
              ? "border-emerald-200 bg-emerald-50 dark:bg-emerald-900/10"
              : payNow.proxyType === "mobile"
                ? "border-amber-200 bg-amber-50 dark:bg-amber-900/10"
                : "border-gray-200 bg-gray-50 dark:bg-gray-900/30"
          }`}
        >
          {payNow.proxyType === "uen" ? (
            <>
              <div className="font-medium">PayNow UEN: <code className="font-mono">{payNow.proxyValue}</code></div>
              <RegistryStatus lookup={lookup} />
            </>
          ) : payNow.proxyType === "mobile" ? (
            <>
              <div className="font-medium text-amber-900 dark:text-amber-200">
                Mobile-number PayNow (proxy type 0)
              </div>
              <p className="text-xs text-amber-800 dark:text-amber-300 mt-1">
                V0 does not support mobile-number PayNow (~70% of SG hawkers).
                Only business UEN PayNow is wired in for the hackathon submission.
                See plan AD3 + AD4.
              </p>
            </>
          ) : (
            <div>Proxy type: {payNow.proxyType} — not handled in V0.</div>
          )}
        </div>
      ) : (
        <div className="rounded-md border border-gray-200 px-3 py-3 text-sm text-gray-600 dark:text-gray-400">
          No SG.PAYNOW MAI found in this QR.
        </div>
      )}
    </section>
  );
}

function RegistryStatus({ lookup }: { lookup: RegistryLookup }) {
  if (lookup.kind === "idle") return null;
  if (lookup.kind === "loading") {
    return <p className="text-xs text-gray-500 mt-2">Looking up on-chain…</p>;
  }
  if (lookup.kind === "registered") {
    return (
      <p className="text-xs mt-2">
        ✓ Registered on-chain — pays to{" "}
        <code className="font-mono">
          {lookup.address.slice(0, 6)}…{lookup.address.slice(-4)}
        </code>
      </p>
    );
  }
  if (lookup.kind === "not_registered") {
    return (
      <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">
        Not yet registered with suiqr. Merchant must onboard via Gmail (Day 6).
      </p>
    );
  }
  return (
    <p className="text-xs text-red-600 mt-2">
      Lookup failed: {lookup.message}
    </p>
  );
}

/** Build a devInspect transaction that calls `merchant_address(registry, uen)`. */
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
