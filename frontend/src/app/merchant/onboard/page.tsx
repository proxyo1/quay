"use client";

import { useSuiClient } from "@mysten/dapp-kit";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { SgqrCameraScanner } from "@/components/SgqrCameraScanner";
import { extractPayNow, looksLikeUen, parseSgqr } from "@/lib/sgqr";
import { SUIQR, objectUrl, txUrl } from "@/lib/sui-config";
import { useZkLoginSession, zkLoginSign } from "@/lib/zklogin";

type SponsoredRegister = {
  tx_bytes_b64: string;
  sponsor_signature: string;
  sponsor_address: string;
  expires_at_ms: number;
  daily_cap: number;
};

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "registered"; digest: string }
  | { kind: "error"; message: string };

export default function OnboardPage() {
  const { session, hydrated, signOut } = useZkLoginSession();
  const router = useRouter();
  const sui = useSuiClient();

  const [uen, setUen] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [scanFeedback, setScanFeedback] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });

  if (hydrated && !session) {
    if (typeof window !== "undefined") {
      router.replace("/merchant/login?next=/merchant/onboard");
    }
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <p className="text-sm text-gray-500">Redirecting to sign-in…</p>
      </main>
    );
  }
  if (!session) return null;

  const uenValid = looksLikeUen(uen);
  const ready = uenValid && state.kind !== "submitting";

  function onScanResult(text: string) {
    setScanOpen(false);
    try {
      const payload = parseSgqr(text.trim());
      if (!payload.crcValid) {
        setScanFeedback("Scanned QR has an invalid CRC — not an SGQR. Type the UEN manually.");
        return;
      }
      const payNow = extractPayNow(payload);
      if (!payNow) {
        setScanFeedback("Scanned QR isn't an SG.PAYNOW code. Type the UEN manually.");
        return;
      }
      if (payNow.proxyType === "mobile") {
        setScanFeedback("Mobile-number PayNow isn't supported in V0 (AD3). Use a UEN-based SGQR.");
        return;
      }
      if (payNow.proxyType !== "uen") {
        setScanFeedback(`Proxy type '${payNow.proxyType}' not supported. UEN only in V0.`);
        return;
      }
      setUen(payNow.proxyValue);
      setScanFeedback(`Captured UEN ${payNow.proxyValue}.`);
      if (state.kind !== "idle" && state.kind !== "submitting") setState({ kind: "idle" });
    } catch (e) {
      setScanFeedback(`Couldn't parse QR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleSubmit() {
    if (!session) return;
    setState({ kind: "submitting" });
    try {
      const res = await fetch("/api/sponsor/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uen, claimer: session.address }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const sp = (await res.json()) as SponsoredRegister;
      const bytes = base64ToBytes(sp.tx_bytes_b64);
      const senderSig = await zkLoginSign(session, bytes);

      const result = await sui.executeTransactionBlock({
        transactionBlock: bytes,
        signature: [senderSig, sp.sponsor_signature],
        options: { showEffects: true },
      });
      if (result.effects?.status?.status !== "success") {
        throw new Error(`tx failed: ${result.effects?.status?.error ?? "unknown"}`);
      }
      await sui.waitForTransaction({ digest: result.digest });
      setState({ kind: "registered", digest: result.digest });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10 space-y-8">
      <header className="space-y-1">
        <Link href="/merchant" className="text-xs text-blue-600 hover:underline">
          ← merchant
        </Link>
        <h1 className="text-3xl font-semibold">Onboard a UEN</h1>
        <p className="text-sm text-gray-500">
          Scan your SGQR sticker or type the UEN. Suiqr signs an attestation,
          your Google identity signs the register tx via zkLogin, the sponsor
          covers gas.
        </p>
      </header>

      <SessionCard session={session} onSignOut={signOut} />

      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-500">UEN</p>
            <p className="text-sm font-medium">Your business identifier</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setScanFeedback(null);
              setScanOpen(true);
            }}
            className="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 inline-flex items-center gap-1.5"
            disabled={state.kind === "submitting"}
          >
            <CameraIcon />
            Scan SGQR
          </button>
        </div>

        <div>
          <label htmlFor="uen" className="block text-xs text-gray-500 mb-1">
            Singapore UEN (8–10 alphanumeric)
          </label>
          <input
            id="uen"
            type="text"
            value={uen}
            onChange={(e) => {
              setUen(e.target.value.trim().toUpperCase());
              setScanFeedback(null);
              if (state.kind !== "idle" && state.kind !== "submitting") setState({ kind: "idle" });
            }}
            placeholder="202412345Z"
            className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 font-mono"
            disabled={state.kind === "submitting"}
          />
          {uen && !uenValid && (
            <p className="text-xs text-amber-600 mt-1">
              Doesn&apos;t look like a UEN. Expected 8–10 alphanumeric chars (e.g., 202012345Z, T12LL3456A).
            </p>
          )}
          {scanFeedback && (
            <p className="text-xs text-emerald-700 dark:text-emerald-300 mt-1">{scanFeedback}</p>
          )}
        </div>
      </section>

      <SubmitFlow state={state} ready={ready} onSubmit={handleSubmit} />

      <footer className="text-xs text-gray-500 pt-6 border-t border-gray-100 dark:border-gray-800 space-y-1">
        <p>
          Registry:{" "}
          <a
            href={objectUrl(SUIQR.registryId)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-blue-600 hover:underline"
          >
            {SUIQR.registryId.slice(0, 10)}…{SUIQR.registryId.slice(-6)}
          </a>{" "}
          on {SUIQR.network}
        </p>
        <p>
          V0 auto-issues attestations for any well-shaped UEN; production gates
          this behind SGQR-photo + BizFile+ review or a NETS-controlled signer.
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

function SessionCard({
  session,
  onSignOut,
}: {
  session: NonNullable<ReturnType<typeof useZkLoginSession>["session"]>;
  onSignOut: () => void;
}) {
  return (
    <section className="rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10 p-4 text-sm space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">Signed in via Google zkLogin</p>
          <p className="text-xs text-gray-600 dark:text-gray-400 font-mono mt-1">
            {session.email}
          </p>
          <p className="text-xs text-gray-600 dark:text-gray-400 font-mono">
            wallet: {session.address.slice(0, 10)}…{session.address.slice(-6)}
          </p>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="text-xs text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
        >
          Sign out
        </button>
      </div>
    </section>
  );
}

function SubmitFlow({
  state,
  ready,
  onSubmit,
}: {
  state: State;
  ready: boolean;
  onSubmit: () => void;
}) {
  if (state.kind === "error") {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 p-3 text-sm">
        <p className="font-medium text-red-700 dark:text-red-300">Error</p>
        <p className="mt-1 text-xs text-red-700 dark:text-red-300 break-words">{state.message}</p>
        <button type="button" onClick={onSubmit} className="text-xs underline mt-2">
          Try again
        </button>
      </div>
    );
  }
  if (state.kind === "registered") {
    return (
      <div className="space-y-2">
        <div className="rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/30 p-3 text-sm">
          <p className="font-medium">
            ✓ Registered on testnet · sponsor paid gas
          </p>
          <p className="mt-1 text-xs">
            tx{" "}
            <a
              href={txUrl(state.digest)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-emerald-700 dark:text-emerald-300 hover:underline"
            >
              {state.digest.slice(0, 10)}…{state.digest.slice(-6)} ↗
            </a>
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link
            href="/merchant/terminal"
            className="flex-1 text-center rounded-md bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-2"
          >
            Open terminal →
          </Link>
          <Link
            href="/scan"
            className="flex-1 text-center rounded-md border border-emerald-300 dark:border-emerald-700 py-2 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
          >
            Test on /scan →
          </Link>
        </div>
      </div>
    );
  }
  if (state.kind === "submitting") {
    return <p className="text-sm text-gray-500">Sponsor signing + submitting on testnet…</p>;
  }
  return (
    <button
      type="button"
      onClick={onSubmit}
      disabled={!ready}
      className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium py-3 transition"
    >
      Claim this UEN
      <span className="block text-xs font-normal opacity-80 mt-0.5">
        zkLogin signs · sponsor pays gas · executeTransactionBlock
      </span>
    </button>
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

function base64ToBytes(b64: string): Uint8Array {
  if (typeof window !== "undefined" && typeof window.atob === "function") {
    const s = window.atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(b64, "base64"));
}
