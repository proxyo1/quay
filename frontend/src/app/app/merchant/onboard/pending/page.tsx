"use client";

import { useSuiClient } from "@mysten/dapp-kit";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import type { KybStatusResponse } from "@/lib/kyb/types";
import { finalizeKyb, KybClientError, pollKybStatus } from "@/lib/kyb/client";
import {
  clearPendingHandoff,
  loadPendingHandoff,
  type KybPendingHandoff,
} from "@/lib/kyb/handoff";
import { txUrl } from "@/lib/sui-config";
import { useZkLoginSession, zkLoginSign } from "@/lib/zklogin";

const POLL_INTERVAL_MS = 30_000;

type FinalizeState =
  | { kind: "idle" }
  | { kind: "running"; phase: "signing" | "submitting" | "waiting" }
  | { kind: "done"; digest: string }
  | { kind: "error"; message: string };

export default function PendingPage() {
  const { session, hydrated, expired, signOut } = useZkLoginSession();
  const router = useRouter();
  const sui = useSuiClient();
  const [handoff, setHandoff] = useState<KybPendingHandoff | null>(null);
  const [status, setStatus] = useState<KybStatusResponse | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [finalize, setFinalize] = useState<FinalizeState>({ kind: "idle" });

  useEffect(() => {
    setHandoff(loadPendingHandoff());
  }, []);

  useEffect(() => {
    if (hydrated && !session) {
      const expiredParam = expired ? "&expired=1" : "";
      router.replace(`/merchant/login?next=/merchant/onboard/pending${expiredParam}`);
    }
  }, [hydrated, session, expired, router]);

  const pollOnce = useCallback(async () => {
    if (!handoff) return;
    try {
      const res = await pollKybStatus(handoff.pollingToken);
      setStatus(res);
      setPollError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPollError(msg);
    }
  }, [handoff]);

  useEffect(() => {
    if (!handoff) return;
    void pollOnce();
    const id = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [handoff, pollOnce]);

  async function handleComplete() {
    if (!handoff || !session) return;
    setFinalize({ kind: "running", phase: "signing" });
    try {
      const finalized = await finalizeKyb(handoff.pollingToken, session.address);
      // Decode tx bytes and sign as the merchant (zkLogin).
      const bytes = base64ToBytes(finalized.txBytesB64);
      setFinalize({ kind: "running", phase: "submitting" });
      const senderSig = await zkLoginSign(session, bytes);
      const result = await sui.executeTransactionBlock({
        transactionBlock: bytes,
        signature: [senderSig, finalized.sponsorSignature],
        options: { showEffects: true },
      });
      if (result.effects?.status?.status !== "success") {
        const raw = result.effects?.status?.error ?? "unknown";
        throw new Error(humanizeRegisterAbort(raw, handoff.uen));
      }
      setFinalize({ kind: "running", phase: "waiting" });
      await sui.waitForTransaction({ digest: result.digest });
      clearPendingHandoff();
      setFinalize({ kind: "done", digest: result.digest });
    } catch (e) {
      const message = e instanceof KybClientError ? e.message : e instanceof Error ? e.message : String(e);
      setFinalize({ kind: "error", message });
    }
  }

  if (!hydrated || !session) {
    return (
      <main className="relative z-10 mx-auto w-full max-w-md px-5 py-16">
        <p className="text-sm text-[var(--muted-soft)]">Loading…</p>
      </main>
    );
  }

  if (!handoff) {
    return (
      <main className="relative z-10 mx-auto w-full max-w-md px-5 py-12 space-y-4">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">No pending submission found</h1>
          <p className="text-sm text-[var(--muted)]">
            This page tracks the status of a KYB submission you just sent. If
            you came back from a new tab, the status link was lost — start a
            fresh submission below.
          </p>
        </header>
        <Link href="/merchant/onboard" className="glass-btn-primary inline-flex text-sm py-2.5 px-4">
          Start onboarding →
        </Link>
      </main>
    );
  }

  return (
    <main className="relative z-10 mx-auto w-full max-w-md px-5 py-6 space-y-6">
      <header className="flex items-center justify-between">
        <Link href="/merchant" className="text-[var(--accent)] hover:underline text-sm inline-flex items-center gap-1">
          <span aria-hidden>←</span> merchant
        </Link>
        <button type="button" onClick={signOut} className="glass-chip rounded-full">
          Sign out
        </button>
      </header>

      <section className="space-y-1">
        <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted-soft)]">
          KYB submission · {handoff.uen}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {renderHeadline(status)}
        </h1>
        <p className="text-sm text-[var(--muted)] leading-relaxed">
          {renderBody(status, handoff)}
        </p>
      </section>

      <PendingStatusCard status={status} pollError={pollError} />

      {status?.status === "approved" && (
        <ApproveActions finalize={finalize} onComplete={handleComplete} />
      )}

      {status?.status === "rejected" && (
        <section className="glass-card-danger rounded-2xl p-4 space-y-3">
          <p className="text-xs uppercase tracking-[0.12em] text-amber-300">
            Reviewer feedback
          </p>
          <p className="text-sm text-amber-100">
            {status.rejection_reason ?? "No reason provided."}
          </p>
          <Link
            href="/merchant/onboard"
            onClick={() => clearPendingHandoff()}
            className="glass-btn-primary inline-flex text-sm py-2.5 px-4"
          >
            Try again →
          </Link>
        </section>
      )}

      {status?.status === "finalized" && status.finalized_at && (
        <section className="glass-card-success rounded-2xl p-4 space-y-2">
          <p className="text-sm font-medium text-white">Registration complete</p>
          <p className="text-xs text-[var(--muted)]">
            Your business is on chain. Head to the terminal to start receiving payments.
          </p>
          <Link href="/merchant/terminal" className="glass-btn-primary inline-flex text-sm py-2.5 px-4">
            Open terminal →
          </Link>
        </section>
      )}

      {finalize.kind === "done" && (
        <section className="glass-card-success rounded-2xl p-4 space-y-1">
          <p className="text-sm font-medium text-white">Confirmed on chain ✓</p>
          <p className="text-xs text-[var(--muted)]">
            Receipt ·{" "}
            <a
              href={txUrl(finalize.digest)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[var(--accent)] hover:underline"
            >
              {finalize.digest.slice(0, 10)}…{finalize.digest.slice(-6)} ↗
            </a>
          </p>
        </section>
      )}
    </main>
  );
}

function PendingStatusCard({
  status,
  pollError,
}: {
  status: KybStatusResponse | null;
  pollError: string | null;
}) {
  if (!status) {
    return (
      <section className="glass-card rounded-2xl p-4">
        <p className="text-xs text-[var(--muted-soft)]">Checking status…</p>
        {pollError && (
          <p className="mt-2 text-[11px] text-amber-300">Last error: {pollError}</p>
        )}
      </section>
    );
  }
  const badge = STATUS_BADGE[status.status];
  return (
    <section className="glass-card rounded-2xl p-4 space-y-2">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] ${badge.classes}`}
        >
          {badge.label}
        </span>
        <span className="text-[10px] text-[var(--muted-soft)]">
          Submitted {relativeTime(status.submitted_at)}
        </span>
      </div>
      {pollError && (
        <p className="text-[11px] text-amber-300">Reconnecting… ({pollError})</p>
      )}
    </section>
  );
}

const STATUS_BADGE: Record<KybStatusResponse["status"], { label: string; classes: string }> = {
  pending: {
    label: "Pending",
    classes: "border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning)]",
  },
  approved: {
    label: "Approved",
    classes: "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent-strong)]",
  },
  rejected: {
    label: "Rejected",
    classes: "border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger)]",
  },
  finalized: {
    label: "Live",
    classes: "border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)]",
  },
  collision: {
    label: "UEN claimed",
    classes: "border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger)]",
  },
};

function ApproveActions({
  finalize,
  onComplete,
}: {
  finalize: FinalizeState;
  onComplete: () => void;
}) {
  if (finalize.kind === "running") {
    const label =
      finalize.phase === "signing"
        ? "Signing transaction…"
        : finalize.phase === "submitting"
        ? "Submitting to Sui…"
        : "Waiting for confirmation…";
    return (
      <button
        type="button"
        disabled
        className="w-full rounded-2xl bg-[var(--accent)]/30 border border-[var(--accent)]/40 text-white font-medium py-4 px-5 cursor-wait flex items-center justify-center gap-2"
      >
        {label}
      </button>
    );
  }
  if (finalize.kind === "error") {
    return (
      <section className="space-y-2">
        <div className="glass-card-danger rounded-2xl p-4">
          <p className="text-sm font-medium text-red-200">Couldn&apos;t finalize</p>
          <p className="text-xs text-red-200/80 break-words mt-1">{finalize.message}</p>
        </div>
        <button type="button" onClick={onComplete} className="glass-btn-primary w-full">
          Try again
        </button>
      </section>
    );
  }
  if (finalize.kind === "done") return null;
  return (
    <button type="button" onClick={onComplete} className="glass-btn-primary w-full">
      Complete registration →
    </button>
  );
}

function renderHeadline(status: KybStatusResponse | null): string {
  if (!status) return "We're reviewing your application";
  switch (status.status) {
    case "pending":
      return "We're reviewing your application";
    case "approved":
      return "Approved ✓";
    case "rejected":
      return "Application needs adjustments";
    case "finalized":
      return "You're live on chain";
    case "collision":
      return "This UEN was just claimed elsewhere";
  }
}

function renderBody(status: KybStatusResponse | null, handoff: KybPendingHandoff): string {
  if (!status) return `Submitted ${relativeTime(handoff.submittedAt)}. Checking status…`;
  switch (status.status) {
    case "pending":
      return `Submitted ${relativeTime(status.submitted_at)}. We typically review within 1 business day. You can close this tab — we'll keep your spot.`;
    case "approved":
      return "Sign one transaction with your wallet to complete on-chain registration. Sponsor gas is covered.";
    case "rejected":
      return "Update your document or details and submit again.";
    case "finalized":
      return "Your merchant entry is on chain and ready to accept payments.";
    case "collision":
      return "Someone else claimed this UEN on chain between your submission and approval. Reach out if you believe this is a mistake.";
  }
}

function relativeTime(iso: string | null): string {
  if (!iso) return "just now";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "moments ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof window !== "undefined" && typeof window.atob === "function") {
    const bin = window.atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

function humanizeRegisterAbort(raw: string, uen: string): string {
  if (raw.includes("MoveAbort") && raw.includes("register_merchant")) {
    if (/,\s*1\)/.test(raw)) {
      return `Someone just registered ${uen} a moment ago. Try a different UEN.`;
    }
    if (/,\s*5\)/.test(raw)) return "We couldn't verify your registration. Please try again.";
    if (/,\s*9\)/.test(raw)) return "Verification expired — please try again.";
    if (/,\s*6\)/.test(raw)) return "Something went wrong with verification. Please try again.";
  }
  return raw;
}
