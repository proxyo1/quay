"use client";

import { useSuiClient } from "@mysten/dapp-kit";
import { blake2b } from "@noble/hashes/blake2.js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { SgqrCameraScanner } from "@/components/SgqrCameraScanner";
import { extractPayNow, looksLikeUen, parseSgqr } from "@/lib/sgqr";
import { lookupUen } from "@/lib/quay";
import { QUAY, objectUrl, txUrl } from "@/lib/sui-config";
import { uploadBlob, WalrusUploadError } from "@/lib/walrus/client";
import { useZkLoginSession, zkLoginSign } from "@/lib/zklogin";

const LOGO_MAX_BYTES = 200 * 1024;
const LOGO_ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

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
  | { kind: "already-yours" }
  | { kind: "error"; message: string };

export default function OnboardPage() {
  const { session, hydrated, signOut } = useZkLoginSession();
  const router = useRouter();
  const sui = useSuiClient();

  const [uen, setUen] = useState("");
  const [merchantName, setMerchantName] = useState("");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoNotice, setLogoNotice] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanFeedback, setScanFeedback] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    if (hydrated && !session) {
      router.replace("/merchant/login?next=/merchant/onboard");
    }
  }, [hydrated, session, router]);

  if (hydrated && !session) {
    return (
      <main className="relative z-10 mx-auto w-full max-w-md px-5 py-16">
        <p className="text-sm text-neutral-500">Redirecting to sign-in…</p>
      </main>
    );
  }
  if (!session) return null;

  const uenValid = looksLikeUen(uen);
  const ready = uenValid && state.kind !== "submitting";
  const currentStep: 1 | 2 | 3 =
    state.kind === "submitting" || state.kind === "registered" || state.kind === "already-yours"
      ? 3
      : uenValid
      ? 2
      : 1;

  function onScanResult(text: string) {
    setScanOpen(false);
    try {
      const payload = parseSgqr(text.trim());
      if (!payload.crcValid) {
        setScanFeedback("Scanned QR has an invalid CRC — type the UEN manually.");
        return;
      }
      const payNow = extractPayNow(payload);
      if (!payNow) {
        setScanFeedback("Scanned QR isn't an SG.PAYNOW code.");
        return;
      }
      if (payNow.proxyType === "mobile") {
        setScanFeedback("Mobile-number PayNow isn't supported in V0. Use a UEN SGQR.");
        return;
      }
      if (payNow.proxyType !== "uen") {
        setScanFeedback(`Proxy type '${payNow.proxyType}' not supported.`);
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
    setLogoNotice(null);
    try {
      const existing = await lookupUen(sui, QUAY.registryId, uen);
      if (existing.claimed) {
        if (existing.owner === session.address) {
          setState({ kind: "already-yours" });
        } else {
          const ownerShort = `${existing.owner.slice(0, 8)}…${existing.owner.slice(-6)}`;
          setState({
            kind: "error",
            message: `UEN ${uen} is already registered to another account (${ownerShort}).`,
          });
        }
        return;
      }

      let metadataBlobId: string | undefined;
      if (logoFile) {
        try {
          const buf = new Uint8Array(await logoFile.arrayBuffer());
          const { blobId } = await uploadBlob(buf);
          metadataBlobId = blobId;
        } catch (err) {
          const why = err instanceof WalrusUploadError ? err.message : String(err);
          setLogoNotice(`Logo upload failed (${why}). Registering without a logo.`);
        }
      }

      const evidenceObject = {
        merchant_name: merchantName,
        uen,
        claimer: session.address,
        signed_at_ms: Date.now(),
      };
      const evidenceContent = JSON.stringify(evidenceObject);
      const evidenceBytes = new TextEncoder().encode(evidenceContent);
      const evidenceHashHex = toHex(blake2b(evidenceBytes, { dkLen: 32 }));

      const res = await fetch("/api/sponsor/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uen,
          claimer: session.address,
          metadata_blob_id: metadataBlobId,
          evidence_hash_hex: evidenceHashHex,
          evidence_content: evidenceContent,
        }),
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
        const raw = result.effects?.status?.error ?? "unknown";
        throw new Error(mapRegisterAbort(raw, uen));
      }
      await sui.waitForTransaction({ digest: result.digest });
      setState({ kind: "registered", digest: result.digest });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  function onLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setLogoNotice(null);
    if (!file) {
      setLogoFile(null);
      setLogoError(null);
      return;
    }
    if (!LOGO_ALLOWED_MIME.has(file.type)) {
      setLogoFile(null);
      setLogoError(`Unsupported type ${file.type || "(unknown)"} — use JPEG, PNG, or WebP.`);
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLogoFile(null);
      setLogoError(`Image is ${Math.round(file.size / 1024)}KB — max 200KB.`);
      return;
    }
    setLogoFile(file);
    setLogoError(null);
  }

  return (
    <main className="relative z-10 mx-auto w-full max-w-md px-5 py-6 space-y-6">
      <header className="flex items-center justify-between">
        <Link href="/merchant" className="text-[var(--accent)] hover:underline text-sm inline-flex items-center gap-1">
          <span aria-hidden>←</span> merchant
        </Link>
        <button
          type="button"
          onClick={signOut}
          className="text-xs px-3 py-1.5 rounded-full border border-white/15 text-neutral-300 hover:bg-white/5"
        >
          Sign out
        </button>
      </header>

      <section className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Claim your UEN</h1>
        <p className="text-sm text-neutral-400">
          Two minutes. No gas fees. Verified on Sui.
        </p>
      </section>

      <Stepper current={currentStep} />

      <SessionPill email={session.email} address={session.address} />

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 space-y-4">
        <button
          type="button"
          onClick={() => {
            setScanFeedback(null);
            setScanOpen(true);
          }}
          disabled={state.kind === "submitting"}
          className="group flex w-full items-center justify-between rounded-2xl bg-[var(--accent)]/10 border border-[var(--accent)]/30 hover:bg-[var(--accent)]/15 text-white font-medium py-3.5 px-4 transition disabled:opacity-50"
        >
          <span className="flex items-center gap-2.5">
            <CameraIcon />
            Scan SGQR sticker
          </span>
          <span className="text-[var(--accent)]">→</span>
        </button>

        <div className="space-y-1.5">
          <label htmlFor="uen" className="block text-[11px] uppercase tracking-wider text-[var(--accent)]">
            UEN
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
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 font-mono text-white placeholder:text-neutral-600 focus:border-[var(--accent)]/50 focus:outline-none transition"
            disabled={state.kind === "submitting"}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
          />
          {uen && !uenValid && (
            <p className="text-[11px] text-amber-400">
              Expected 8–10 alphanumeric (e.g., 202012345Z, T12LL3456A).
            </p>
          )}
          {uen && uenValid && (
            <p className="text-[11px] text-[var(--success)] inline-flex items-center gap-1.5">
              <CheckIcon /> Valid format
            </p>
          )}
          {scanFeedback && !uen && (
            <p className="text-[11px] text-[var(--accent)]">{scanFeedback}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="merchant-name" className="block text-[11px] uppercase tracking-wider text-neutral-500">
            Business name <span className="normal-case text-neutral-600">(optional)</span>
          </label>
          <input
            id="merchant-name"
            type="text"
            value={merchantName}
            onChange={(e) => setMerchantName(e.target.value)}
            placeholder="Curry Times Pte Ltd"
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-white placeholder:text-neutral-600 focus:border-[var(--accent)]/50 focus:outline-none transition"
            disabled={state.kind === "submitting"}
          />
          <p className="text-[11px] text-neutral-500">
            Hashed into the on-chain attestation alongside your UEN.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="logo" className="block text-[11px] uppercase tracking-wider text-neutral-500">
            Logo <span className="normal-case text-neutral-600">(optional, ≤200KB)</span>
          </label>
          <label
            htmlFor="logo"
            className={`block rounded-xl border-2 border-dashed px-4 py-5 text-center cursor-pointer transition ${
              logoFile
                ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.04]"
                : "border-white/15 hover:border-white/25 hover:bg-white/[0.02]"
            }`}
          >
            <UploadIcon />
            <p className="mt-1 text-xs text-neutral-300">
              {logoFile
                ? `${logoFile.name} (${Math.round(logoFile.size / 1024)}KB)`
                : "Tap to upload an image"}
            </p>
            <p className="text-[10px] text-neutral-500 mt-0.5">
              {logoFile ? "Will upload to Walrus on submit" : "JPEG, PNG, WebP"}
            </p>
          </label>
          <input
            id="logo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={onLogoChange}
            className="sr-only"
            disabled={state.kind === "submitting"}
          />
          {logoError && <p className="text-[11px] text-amber-400">{logoError}</p>}
          {logoNotice && <p className="text-[11px] text-amber-400">{logoNotice}</p>}
        </div>
      </section>

      <section className="rounded-2xl border border-[var(--accent)]/25 bg-[var(--accent)]/[0.05] p-4">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-xl bg-[var(--accent)]/15 border border-[var(--accent)]/40 flex items-center justify-center shrink-0">
            <SuiIcon />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">Sponsored gas</p>
            <p className="text-xs text-neutral-400 leading-relaxed mt-0.5">
              Quay pays the testnet gas while you onboard. ~10s to confirm via zkLogin.
            </p>
          </div>
        </div>
      </section>

      <SubmitFlow state={state} ready={ready} onSubmit={handleSubmit} />

      <footer className="text-[11px] text-neutral-500 pt-4 border-t border-white/5 space-y-1.5">
        <p>
          Registry:{" "}
          <a
            href={objectUrl(QUAY.registryId)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[var(--accent)] hover:underline"
          >
            {QUAY.registryId.slice(0, 8)}…{QUAY.registryId.slice(-6)}
          </a>
        </p>
        <p>V0 auto-issues attestations. Production gates this behind manual review.</p>
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

function Stepper({ current }: { current: 1 | 2 | 3 }) {
  const steps = [
    { n: 1, label: "Scan" },
    { n: 2, label: "Confirm" },
    { n: 3, label: "Sign" },
  ] as const;
  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => (
        <div key={s.n} className="flex items-center gap-2 flex-1">
          <div
            className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-semibold border ${
              current === s.n
                ? "bg-[var(--accent)] border-[var(--accent)] text-white"
                : current > s.n
                ? "bg-[var(--accent)]/20 border-[var(--accent)]/40 text-[var(--accent)]"
                : "border-white/15 text-neutral-500"
            }`}
          >
            {current > s.n ? <CheckIcon /> : s.n}
          </div>
          <span
            className={`text-[11px] uppercase tracking-wider ${
              current >= s.n ? "text-white" : "text-neutral-600"
            }`}
          >
            {s.label}
          </span>
          {i < steps.length - 1 && (
            <span className={`h-px flex-1 ${current > s.n ? "bg-[var(--accent)]/40" : "bg-white/10"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

function SessionPill({ email, address }: { email: string; address: string }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center gap-2.5">
        <div className="h-7 w-7 rounded-full bg-[var(--accent)]/15 border border-[var(--accent)]/40 flex items-center justify-center text-[var(--accent)] text-xs font-semibold shrink-0">
          {email?.charAt(0).toUpperCase() ?? "M"}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-white truncate">{email}</p>
          <p className="text-[10px] font-mono text-neutral-500 truncate">
            {address.slice(0, 10)}…{address.slice(-6)}
          </p>
        </div>
        <span className="text-[10px] text-[var(--success)] uppercase tracking-wider">zkLogin</span>
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
      <section className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 space-y-2">
        <p className="text-sm font-medium text-red-300">Error</p>
        <p className="text-xs text-red-300/80 break-words">{state.message}</p>
        <button
          type="button"
          onClick={onSubmit}
          className="text-xs text-[var(--accent)] hover:underline"
        >
          Try again
        </button>
      </section>
    );
  }
  if (state.kind === "already-yours") {
    return (
      <section className="rounded-2xl border border-[var(--accent)]/30 bg-[var(--accent)]/[0.05] p-4 space-y-2">
        <p className="text-sm font-medium text-white">You already own this UEN</p>
        <p className="text-xs text-neutral-400">
          Open the terminal to see incoming payments.
        </p>
        <Link
          href="/merchant/terminal"
          className="inline-block mt-1 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white text-sm font-medium px-4 py-2 transition"
        >
          Open terminal →
        </Link>
      </section>
    );
  }
  if (state.kind === "registered") {
    return (
      <section className="space-y-3">
        <div className="rounded-2xl border border-[var(--success)]/30 bg-[var(--success)]/[0.08] p-4 space-y-1">
          <p className="text-sm font-medium text-white inline-flex items-center gap-2">
            <span className="text-[var(--success)]">
              <CheckIcon />
            </span>
            Registered on testnet
          </p>
          <p className="text-xs text-neutral-400">
            Sponsor paid gas ·{" "}
            <a
              href={txUrl(state.digest)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[var(--accent)] hover:underline"
            >
              {state.digest.slice(0, 10)}…{state.digest.slice(-6)} ↗
            </a>
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Link
            href="/merchant/terminal"
            className="text-center rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white text-sm font-medium py-2.5 transition"
          >
            Open terminal →
          </Link>
          <Link
            href="/scan"
            className="text-center rounded-xl border border-white/15 hover:bg-white/5 text-white text-sm font-medium py-2.5 transition"
          >
            Test on /scan →
          </Link>
        </div>
      </section>
    );
  }
  if (state.kind === "submitting") {
    return (
      <button
        type="button"
        disabled
        className="w-full rounded-2xl bg-[var(--accent)]/40 text-white font-medium py-4 px-5 cursor-wait flex items-center justify-center gap-2"
      >
        <Spinner />
        Sponsor signing on testnet…
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onSubmit}
      disabled={!ready}
      className="group flex w-full items-center justify-between rounded-2xl bg-[var(--accent)] hover:bg-[var(--accent-strong)] disabled:bg-white/5 disabled:text-neutral-500 disabled:cursor-not-allowed text-white font-medium py-4 px-5 transition shadow-[0_8px_30px_-8px_var(--accent-glow)] disabled:shadow-none"
    >
      <span>Claim UEN</span>
      <span className={ready ? "text-white/70 group-hover:text-white transition" : "text-neutral-600"}>
        →
      </span>
    </button>
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

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-[var(--accent)]">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function SuiIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v20M5 12s2.5 4 7 4 7-4 7-4-2.5-4-7-4-7 4-7 4z" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function mapRegisterAbort(raw: string, uen: string): string {
  if (raw.includes("MoveAbort") && raw.includes("register_merchant")) {
    if (/,\s*1\)/.test(raw)) {
      return `UEN ${uen} was claimed between pre-flight and submit.`;
    }
    if (/,\s*5\)/.test(raw)) return "Attestation invalid (issuer key mismatch).";
    if (/,\s*9\)/.test(raw)) return "Attestation expired — retry the claim.";
    if (/,\s*6\)/.test(raw)) return "Attestation nonce replayed — retry the claim.";
  }
  return `tx failed: ${raw}`;
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
