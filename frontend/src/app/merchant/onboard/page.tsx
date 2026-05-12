"use client";

import { useSuiClient } from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useMerchantSession, loadKeypair } from "@/lib/merchant-session";
import { looksLikeUen } from "@/lib/sgqr";
import { isAllowedMetadataUri } from "@/lib/suiqr";
import { SUIQR, objectUrl, txUrl } from "@/lib/sui-config";

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
  const { session, hydrated } = useMerchantSession();
  const router = useRouter();
  const sui = useSuiClient();

  const [uen, setUen] = useState("");
  const [metadataUri, setMetadataUri] = useState("");
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

  const uenValid = looksLikeUen(uen);
  const metaUriValid = !metadataUri || isAllowedMetadataUri(metadataUri);
  const ready = !!session && uenValid && metaUriValid;

  async function handleSubmit() {
    if (!session) return;
    setState({ kind: "submitting" });
    try {
      const res = await fetch("/api/sponsor/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uen,
          claimer: session.address,
          metadata_uri: metadataUri.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const sp = (await res.json()) as SponsoredRegister;
      const bytes = base64ToBytes(sp.tx_bytes_b64);

      const kp = loadKeypair(session);
      const senderSig = await kp.signTransaction(bytes);

      const result = await sui.executeTransactionBlock({
        transactionBlock: bytes,
        signature: [senderSig.signature, sp.sponsor_signature],
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
          Suiqr signs an attestation for your UEN, then submits register_merchant
          on your behalf. The sponsor wallet pays the gas. Your signed-in
          wallet only signs to authorize.
        </p>
      </header>

      {session && <SessionCard session={session} />}

      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500">UEN</p>
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
        </div>

        <div>
          <label htmlFor="meta" className="block text-xs text-gray-500 mb-1">
            Profile URI (optional) — must start with https:// or ipfs://
          </label>
          <input
            id="meta"
            type="text"
            value={metadataUri}
            onChange={(e) => {
              setMetadataUri(e.target.value.trim());
              if (state.kind !== "idle" && state.kind !== "submitting") setState({ kind: "idle" });
            }}
            placeholder="ipfs://merchant-profile-cid"
            className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-sm"
            disabled={state.kind === "submitting"}
          />
          {metadataUri && !metaUriValid && (
            <p className="text-xs text-amber-600 mt-1">
              Allowlist (AD30): only https:// and ipfs:// URIs are accepted.
            </p>
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
          V0 auto-issues attestations for any well-shaped UEN. Production gates
          this behind SGQR-photo + BizFile+ review (or a NETS-controlled signer).
          Sponsored gas: 5 onboarding txs per wallet per day on testnet.
        </p>
      </footer>
    </main>
  );
}

function SessionCard({ session }: { session: NonNullable<ReturnType<typeof useMerchantSession>["session"]> }) {
  return (
    <section className="rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10 p-4 text-sm space-y-1">
      <p className="font-medium">Signed in</p>
      <p className="text-xs text-gray-600 dark:text-gray-400 font-mono">
        {session.email}
      </p>
      <p className="text-xs text-gray-600 dark:text-gray-400 font-mono">
        wallet: {session.address.slice(0, 10)}…{session.address.slice(-6)}
      </p>
      <p className="text-[11px] text-gray-500 pt-1">
        Want to back up your private key?{" "}
        <Link href="/merchant/wallet" className="text-blue-600 hover:underline">
          /merchant/wallet
        </Link>
      </p>
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
        POST /api/sponsor/register → your session signs → executeTransactionBlock
      </span>
    </button>
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
