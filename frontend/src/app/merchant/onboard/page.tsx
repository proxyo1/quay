"use client";

import {
  ConnectButton,
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSignTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import Link from "next/link";
import { useState } from "react";

import { looksLikeUen } from "@/lib/sgqr";
import { buildRegisterTx, isAllowedMetadataUri } from "@/lib/suiqr";
import { SUIQR, objectUrl, txUrl } from "@/lib/sui-config";

type Attestation = {
  attestation_hex: string;
  nonce_hex: string;
  expires_at_ms: number;
  issuer_pubkey_hex: string;
  chain_id: number;
  msg_hash_hex: string;
};

type SponsoredRegister = {
  tx_bytes_b64: string;
  sponsor_signature: string;
  sponsor_address: string;
  expires_at_ms: number;
  daily_cap: number;
};

type State =
  | { kind: "idle" }
  | { kind: "requesting_attestation" }
  | { kind: "attestation_ready"; attestation: Attestation }
  | { kind: "submitting" }
  | { kind: "registered"; digest: string; sponsored: boolean }
  | { kind: "error"; message: string };

export default function OnboardPage() {
  const account = useCurrentAccount();
  const sui = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const { mutateAsync: signTransaction } = useSignTransaction();

  const [uen, setUen] = useState("");
  const [metadataUri, setMetadataUri] = useState("");
  const [useSponsored, setUseSponsored] = useState(true);
  const [state, setState] = useState<State>({ kind: "idle" });

  const uenValid = looksLikeUen(uen);
  const metaUriValid = !metadataUri || isAllowedMetadataUri(metadataUri);
  const ready = !!account && uenValid && metaUriValid;

  function reset() {
    setState({ kind: "idle" });
  }

  async function handleStandard() {
    if (!account) return;
    setState({ kind: "requesting_attestation" });
    try {
      const res = await fetch("/api/attest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uen, claimer: account.address }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const attestation = (await res.json()) as Attestation;
      setState({ kind: "submitting" });
      const tx = buildRegisterTx({
        uen,
        nonce: hexToBytes(attestation.nonce_hex),
        attestation: hexToBytes(attestation.attestation_hex),
        expiresAtMs: BigInt(attestation.expires_at_ms),
        metadataUri: metadataUri.trim() || undefined,
      });
      const result = await signAndExecute({ transaction: tx });
      await sui.waitForTransaction({ digest: result.digest });
      setState({ kind: "registered", digest: result.digest, sponsored: false });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleSponsored() {
    if (!account) return;
    setState({ kind: "submitting" });
    try {
      const res = await fetch("/api/sponsor/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uen,
          claimer: account.address,
          metadata_uri: metadataUri.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const sp = (await res.json()) as SponsoredRegister;
      const bytes = base64ToBytes(sp.tx_bytes_b64);
      const senderSig = await signTransaction({ transaction: Transaction.from(bytes) });
      const result = await sui.executeTransactionBlock({
        transactionBlock: bytes,
        signature: [senderSig.signature, sp.sponsor_signature],
        options: { showEffects: true },
      });
      if (result.effects?.status?.status !== "success") {
        throw new Error(`tx failed: ${result.effects?.status?.error ?? "unknown"}`);
      }
      await sui.waitForTransaction({ digest: result.digest });
      setState({ kind: "registered", digest: result.digest, sponsored: true });
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
          Three steps: connect a Sui wallet, declare the UEN you own, claim it on chain.
        </p>
      </header>

      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-500">Step 1</p>
            <p className="text-sm font-medium">Wallet</p>
          </div>
          <ConnectButton />
        </div>
        {account && (
          <p className="text-xs text-gray-500 font-mono">
            connected · {account.address.slice(0, 10)}…{account.address.slice(-6)}
          </p>
        )}
      </section>

      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500">Step 2</p>
          <p className="text-sm font-medium">Your UEN</p>
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
              reset();
            }}
            placeholder="202412345Z"
            className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 font-mono"
            disabled={state.kind === "submitting" || state.kind === "requesting_attestation"}
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
              reset();
            }}
            placeholder="ipfs://merchant-profile-cid"
            className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-sm"
            disabled={state.kind === "submitting" || state.kind === "requesting_attestation"}
          />
          {metadataUri && !metaUriValid && (
            <p className="text-xs text-amber-600 mt-1">
              Allowlist (AD30): only https:// and ipfs:// URIs are accepted.
            </p>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm pt-1">
          <input
            type="checkbox"
            checked={useSponsored}
            onChange={(e) => {
              setUseSponsored(e.target.checked);
              reset();
            }}
            className="rounded"
            disabled={state.kind === "submitting" || state.kind === "requesting_attestation"}
          />
          <span>
            Use sponsored gas <span className="text-emerald-600 text-xs font-medium">(recommended — no SUI needed)</span>
          </span>
        </label>
      </section>

      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-4 space-y-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500">Step 3</p>
          <p className="text-sm font-medium">
            {useSponsored ? "Sign + submit (suiqr pays gas)" : "Attest + sign + submit"}
          </p>
        </div>

        <SubmitFlow
          state={state}
          ready={ready}
          useSponsored={useSponsored}
          onStandard={handleStandard}
          onSponsored={handleSponsored}
        />
      </section>

      <footer className="text-xs text-gray-500 pt-6 border-t border-gray-100 dark:border-gray-800 space-y-1">
        <p>
          Registry:{" "}
          <a href={objectUrl(SUIQR.registryId)} target="_blank" rel="noreferrer" className="font-mono text-blue-600 hover:underline">
            {SUIQR.registryId.slice(0, 10)}…{SUIQR.registryId.slice(-6)}
          </a>{" "}
          on {SUIQR.network}
        </p>
        <p>
          Sponsored gas covers up to 5 onboarding txs per wallet per day on
          testnet. V0 auto-issues attestations; production gates this behind
          SGQR-photo + BizFile+ review.
        </p>
      </footer>
    </main>
  );
}

function SubmitFlow({
  state,
  ready,
  useSponsored,
  onStandard,
  onSponsored,
}: {
  state: State;
  ready: boolean;
  useSponsored: boolean;
  onStandard: () => void;
  onSponsored: () => void;
}) {
  if (state.kind === "error") {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 p-3 text-sm">
        <p className="font-medium text-red-700 dark:text-red-300">Error</p>
        <p className="mt-1 text-xs text-red-700 dark:text-red-300 break-words">{state.message}</p>
        <button
          type="button"
          onClick={useSponsored ? onSponsored : onStandard}
          className="text-xs underline mt-2"
        >
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
            ✓ Registered on testnet
            {state.sponsored && (
              <span className="ml-2 text-xs font-normal text-emerald-700 dark:text-emerald-300">
                · sponsor paid gas
              </span>
            )}
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
        <Link
          href="/scan"
          className="block text-center text-sm text-emerald-700 dark:text-emerald-300 hover:underline"
        >
          Now test it on /scan →
        </Link>
      </div>
    );
  }

  if (state.kind === "requesting_attestation") {
    return <p className="text-sm text-gray-500">Asking suiqr for an attestation…</p>;
  }
  if (state.kind === "submitting") {
    return (
      <p className="text-sm text-gray-500">
        {useSponsored ? "Sponsor signing + submitting…" : "Submitting register_merchant on testnet…"}
      </p>
    );
  }

  return (
    <button
      type="button"
      onClick={useSponsored ? onSponsored : onStandard}
      disabled={!ready}
      className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium py-3 transition"
    >
      {useSponsored ? "Sign + submit (sponsor pays gas)" : "Request attestation + register"}
      <span className="block text-xs font-normal opacity-80 mt-0.5">
        {useSponsored
          ? "POST /api/sponsor/register → wallet signs bytes → executeTransactionBlock"
          : "POST /api/attest → wallet signs register_merchant → wallet pays gas"}
      </span>
    </button>
  );
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`hex length ${clean.length} is not even`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
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
