"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import type { KybStatusResponse } from "@/lib/kyb/types";
import {
  finalizeKyb,
  KybClientError,
  pollKybStatus,
  resendKybCode,
  verifyKybCode,
} from "@/lib/kyb/client";
import {
  clearPendingHandoff,
  loadPendingHandoff,
  type KybPendingHandoff,
} from "@/lib/kyb/handoff";
import { txUrl } from "@/lib/sui-config";
import { useZkLoginSession, zkLoginSign } from "@/lib/zklogin";
import { getSuiClient } from "@/lib/sui-client";

const POLL_INTERVAL_MS = 30_000;

type FinalizeState =
  | { kind: "idle" }
  | { kind: "running"; phase: "signing" | "submitting" | "waiting" }
  | { kind: "done"; digest: string }
  | { kind: "error"; message: string };

export default function PendingPage() {
  const { session, hydrated, expired, signOut } = useZkLoginSession();
  const router = useRouter();
  const sui = getSuiClient();
  const [handoff, setHandoff] = useState<KybPendingHandoff | null>(null);
  const [status, setStatus] = useState<KybStatusResponse | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [finalize, setFinalize] = useState<FinalizeState>({ kind: "idle" });

  useEffect(() => {
    setHandoff(loadPendingHandoff());
  }, []);

  // Only bounce to login when there is nothing to resume.
  //
  // Verification requires leaving Quay for a banking app, and on a phone that
  // round trip can lose the zkLogin session, which lives in browser storage.
  // Sending the merchant to a login screen at that point would cost them the
  // work they just did: they read the code, came back, and got a wall.
  //
  // The polling token is sufficient authority to enter a code — it is bound to
  // the submission — so an unauthenticated merchant with a saved handoff stays
  // on this screen. A signature is only needed to finalize on chain, and that
  // step asks them to sign in at the moment it actually matters.
  useEffect(() => {
    if (hydrated && !session && !loadPendingHandoff()) {
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
      const resultRes = await sui.executeTransaction({
        transaction: bytes,
        signatures: [senderSig, finalized.sponsorSignature],
        include: { effects: true },
      });
      const result = resultRes.Transaction;
      if (!result?.status?.success) {
        const raw = result?.status?.error?.message ?? "unknown";
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

  if (!hydrated || (!session && !handoff)) {
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
        {session && (
          <button type="button" onClick={signOut} className="glass-chip rounded-full">
            Sign out
          </button>
        )}
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

      {status?.status === "awaiting_code" && (
        <CodeEntryCard
          pollingToken={handoff.pollingToken}
          reference={status.code_reference}
          sent={Boolean(status.code_sent_at)}
          onVerified={() => void pollOnce()}
        />
      )}

      {status?.status === "code_failed" && (
        <section className="glass-card-danger rounded-2xl p-4 space-y-2">
          <p className="text-sm font-medium text-red-200">Verification locked</p>
          <p className="text-xs text-red-200/80">
            For safety we stop after a few incorrect codes. Nothing is lost —
            contact us and we&apos;ll reset it.
          </p>
        </section>
      )}

      {status?.status === "approved" &&
        (session ? (
          <ApproveActions finalize={finalize} onComplete={handleComplete} />
        ) : (
          <section className="glass-card-accent rounded-2xl p-4 space-y-2">
            <p className="text-sm font-medium text-white">Verified. One step left.</p>
            <p className="text-xs text-[var(--muted)]">
              Sign in again to finish registering on chain. Your verification is
              saved.
            </p>
            <Link
              href="/merchant/login?next=/merchant/onboard/pending"
              className="glass-btn-primary inline-flex text-sm py-2.5 px-4"
            >
              Sign in →
            </Link>
          </section>
        ))}

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
    label: "Preparing",
    classes: "border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning)]",
  },
  awaiting_code: {
    label: "Waiting for you",
    classes: "border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning)]",
  },
  code_failed: {
    label: "Locked",
    classes: "border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger)]",
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


/**
 * The await-code screen.
 *
 * Hierarchy is deliberate and ordered by what the merchant needs while they
 * are about to leave the app:
 *
 *   1. WHERE TO LOOK    loudest, it is the instruction they carry away
 *   2. WHAT TO FIND     the reference, with the real string to match
 *   3. WHERE TO PUT IT  the input, reachable one-handed
 *   4. ESCAPE HATCHES   quietest
 *
 * Everything else is cut: no progress bar, no step counter, no reassurance
 * copy. This screen has one job.
 *
 * It also has to survive an app switch. The merchant leaves for their banking
 * app and may come back to an evicted tab, so nothing here depends on state
 * held since submit: the reference comes from the polling response and the
 * whole screen rebuilds from a cold start.
 */
function CodeEntryCard({
  pollingToken,
  reference,
  sent,
  onVerified,
}: {
  pollingToken: string;
  reference: string | null;
  sent: boolean;
  onVerified: () => void;
}) {
  const [code, setCode] = useState("");
  const [state, setState] = useState<CodeEntryState>({ kind: "idle" });

  const busy = state.kind === "checking" || state.kind === "resending";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setState({ kind: "checking" });
    try {
      const result = await verifyKybCode(pollingToken, code);
      switch (result.status) {
        case "verified":
          setState({ kind: "idle" });
          onVerified();
          return;
        case "wrong":
          setState({ kind: "wrong", remaining: result.remaining ?? 0 });
          return;
        case "locked":
          setState({ kind: "locked" });
          return;
        case "no_pending_code":
          setState({ kind: "stale" });
          return;
        case "unavailable":
          setState({ kind: "unavailable" });
          return;
      }
    } catch (e) {
      setState({
        kind: "unavailable",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function resend() {
    if (busy) return;
    setState({ kind: "resending" });
    try {
      await resendKybCode(pollingToken);
      setCode("");
      setState({ kind: "resent" });
      onVerified(); // re-polls; picks up the new reference
    } catch (e) {
      setState({
        kind: "unavailable",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <section className="glass-card-warning rounded-2xl p-4 space-y-4">
      {/* 2. WHAT TO FIND */}
      <div className="space-y-1.5">
        <p className="text-sm text-white leading-relaxed">
          {sent
            ? "Look for an incoming PayNow of S$0.01. The reference contains your code:"
            : "When it arrives, look for an incoming PayNow of S$0.01. The reference will look like:"}
        </p>
        <p className="font-mono text-lg tracking-wider text-[var(--warning)] break-all">
          {reference ?? "QUAY-XXXXXX"}
        </p>
      </div>

      {/* 3. WHERE TO PUT IT */}
      <form onSubmit={submit} className="space-y-2">
        <label
          htmlFor="verification-code"
          className="block text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]"
        >
          Code from your statement
        </label>
        <input
          id="verification-code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (state.kind !== "idle") setState({ kind: "idle" });
          }}
          // Merchants paste straight from their banking app, so the field
          // accepts the whole reference and the server strips the prefix.
          placeholder="QUAY-7F3K9M"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          disabled={busy}
          className="glass-input w-full px-3 py-3 font-mono text-base tracking-wider disabled:opacity-50"
          style={{ backgroundColor: "var(--surface-input)" }}
        />
        <button
          type="submit"
          disabled={!code.trim() || busy}
          className="glass-btn-primary w-full py-3.5 disabled:opacity-40"
        >
          {state.kind === "checking" ? "Checking…" : "Verify"}
        </button>
      </form>

      <CodeEntryFeedback state={state} />

      {/* 4. ESCAPE HATCHES */}
      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={resend}
          disabled={busy}
          className="text-xs text-[var(--muted)] underline underline-offset-2 disabled:opacity-40"
        >
          {state.kind === "resending" ? "Sending…" : "Didn't get it? Send a new one"}
        </button>
      </div>
    </section>
  );
}

type CodeEntryState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "resending" }
  | { kind: "resent" }
  | { kind: "wrong"; remaining: number }
  | { kind: "locked" }
  | { kind: "stale" }
  | { kind: "unavailable"; message?: string };

/**
 * Every failure gets a specific message and a way forward. A wrong code says
 * how many tries are left, an expired one offers a new code rather than
 * reading as an error, and an outage says "try again" rather than blaming
 * the merchant's code.
 */
function CodeEntryFeedback({ state }: { state: CodeEntryState }) {
  switch (state.kind) {
    case "wrong":
      return (
        <p className="text-xs text-[var(--danger)]">
          That code doesn&apos;t match.{" "}
          {state.remaining > 0
            ? `${state.remaining} ${state.remaining === 1 ? "try" : "tries"} left.`
            : "Last try."}
        </p>
      );
    case "locked":
      return (
        <p className="text-xs text-[var(--danger)]">
          Locked after too many incorrect codes. Contact us and we&apos;ll reset it.
        </p>
      );
    case "stale":
      return (
        <p className="text-xs text-[var(--muted)]">
          That code has expired or was already used. Send a new one below.
        </p>
      );
    case "resent":
      return (
        <p className="text-xs text-[var(--success)]">
          A new code is on its way. The previous one no longer works.
        </p>
      );
    case "unavailable":
      return (
        <p className="text-xs text-[var(--muted)]">
          We couldn&apos;t check that just now. Please try again in a moment.
          {state.message ? ` (${state.message})` : ""}
        </p>
      );
    default:
      return null;
  }
}

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
  if (!status) return "Setting up your verification";
  switch (status.status) {
    case "pending":
      return "Setting up your verification";
    case "awaiting_code":
      return "Check your bank app";
    case "code_failed":
      return "Too many incorrect codes";
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
  if (!status) return `Started ${relativeTime(handoff.submittedAt)}. Getting things ready…`;
  switch (status.status) {
    case "pending":
      return "We're preparing a S$0.01 payment to your PayNow. This page will update when it's on its way.";
    case "awaiting_code":
      return status.code_sent_at
        ? "We sent S$0.01 to your PayNow. Find it in your bank app and enter the code from the reference below."
        : "We're sending S$0.01 to your PayNow. While we're in early access this can take a few hours. It's safe to close this page and come back.";
    case "code_failed":
      return "This verification is locked. Get in touch and we'll reset it for you.";
    case "approved":
      return "Verified. Sign one transaction to finish registering. Gas is covered.";
    case "rejected":
      return "Update your details and try again.";
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
