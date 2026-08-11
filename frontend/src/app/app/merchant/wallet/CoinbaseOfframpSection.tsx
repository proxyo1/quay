"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatSgdMinor, formatUsdsuiExact, parseUsdsuiToMinor } from "@/lib/money";
import { zkLoginSign, type ZkLoginSession } from "@/lib/zklogin";
import { getSuiClient } from "@/lib/sui-client";

/**
 * Coinbase cash-out — sell USDsui into the merchant's own Coinbase account.
 *
 * Design notes that are load-bearing rather than stylistic:
 *
 *  - **The widget opens with `window.open`, never a redirect.** The zkLogin
 *    signing key lives in localStorage and only client code can use it. A
 *    full-page navigation off-origin can come back in a different context with
 *    no session, leaving a committed order permanently unfillable — the funds
 *    would be owed to Coinbase with nothing able to sign the send. Keeping this
 *    tab alive is what lets it poll and then sign.
 *  - **The signature is never auto-fired.** When Coinbase confirms, the card
 *    primes a large button and waits for a tap. A wallet prompt appearing in an
 *    unattended tab trains merchants to dismiss prompts, which is precisely the
 *    habit not to build in a payments app. The merchant's tap is the only
 *    remaining step, so almost no clock is burned.
 *  - **Copy never implies bank settlement.** Coinbase pays SGD into the
 *    merchant's Coinbase balance; moving it to a bank is a separate thing they
 *    do in Coinbase. The Wise section's "on its way to your bank" is correct
 *    there and wrong here.
 */

type Step =
  | { k: "form" }
  | { k: "quoting" }
  | { k: "redeemConfirm"; plan: SessionResponse }
  | { k: "redeemSigning" }
  | { k: "handoff"; session: SessionResponse }
  | { k: "waitingCoinbase"; session: SessionResponse; ready: PrepareReady | null }
  | { k: "sendSigning" }
  | { k: "sending" }
  | { k: "settled"; sgdMinor: string }
  | { k: "expired"; amountMinor: string }
  | { k: "unmatched"; usdcMinor: string }
  | { k: "sessionLost"; requestId: string; deadlineMs: number | null }
  | { k: "error"; message: string };

interface SessionResponse {
  request_id: string;
  uen?: string;
  offramp_token: string;
  offramp_url?: string;
  sell_amount_usdc_minor: string;
  estimated_sgd_minor: string;
  coinbase_fee_sgd_minor: string;
  swap: { expected_in_usdsui_minor: string; max_in_usdsui_minor: string; venues: string[] };
  redeem: {
    required: boolean;
    redeemable_share_minor?: string;
    leftover_share_minor?: string;
    partial?: boolean;
    realizable_underlying_minor?: string;
  };
}

interface PrepareReady {
  ready: true;
  request_id: string;
  tx_bytes_b64: string;
  sponsor_signature: string;
  to_address: string;
  sell_amount_usdc_minor: string;
  deadline_at_ms: number | null;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function formatUsdc(minor: string): string {
  const v = BigInt(minor || "0");
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

/**
 * `mm:ss` countdown whose colour escalates by threshold.
 *
 * Announced via `aria-live` only when crossing the 5-minute and 1-minute
 * marks — a per-second live region would flood a screen reader with noise.
 * Colour is never the sole carrier of urgency: the label reads "Expires in"
 * throughout and the final minute adds the words "Expiring now".
 */
function Countdown({ deadlineMs }: { deadlineMs: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const totalSec =
    deadlineMs === null ? null : Math.floor(Math.max(0, deadlineMs - now) / 1000);
  const threshold =
    totalSec === null ? "" : totalSec < 60 ? "1min" : totalSec < 300 ? "5min" : "";

  // Derived, not stored. `aria-live` announces only when its content changes,
  // so a value that depends solely on the threshold announces exactly once per
  // crossing — no state, no effect, and no per-second flood.
  const announcement =
    threshold === "1min"
      ? "Expiring now — less than one minute left"
      : threshold === "5min"
        ? "Less than five minutes left to finish this cash-out"
        : "";

  if (totalSec === null) return null;

  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  const urgent = threshold === "1min";
  const colour = urgent
    ? "text-[var(--danger)]"
    : threshold === "5min"
      ? "text-[var(--warning)]"
      : "text-[var(--muted)]";

  return (
    <>
      <span className={`font-mono tabular-nums ${colour}`}>
        {mm}:{ss}
        {/* Colour is never the sole carrier of urgency. */}
        {urgent && <span className="ml-1.5 font-sans text-[11px]">Expiring now</span>}
      </span>
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}

/** "Step N of 2", rendered in the existing eyebrow slot. */
function StepMarker({ n }: { n: 1 | 2 }) {
  return (
    <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]">
      Step {n} of 2
    </span>
  );
}

const DISCLOSURE =
  "You're selling to your own Coinbase account. Coinbase does the identity " +
  "check and pays SGD into that account — moving it to your bank is a " +
  "separate step you do in Coinbase. Quay never holds your funds. " +
  "Network fees are on us.";

export function CoinbaseOfframpSection({
  session,
  liquidMinor,
  yieldMinor,
  onDone,
}: {
  session: ZkLoginSession;
  liquidMinor: bigint;
  yieldMinor: bigint;
  onDone: () => void;
}) {
  const [available, setAvailable] = useState(true);
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>({ k: "form" });
  const windowRef = useRef<Window | null>(null);

  // Max sellable is liquid PLUS what can come out of Scallop — capping at
  // liquid alone would hide the whole feature from a merchant who is earning.
  const maxMinor = liquidMinor + yieldMinor;
  const amountMinor = useMemo(() => parseUsdsuiToMinor(amount), [amount]);

  const authHeaders = useCallback(
    (token?: string): Record<string, string> => ({
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }),
    [],
  );

  /**
   * Restore the UI for a merchant returning mid-flow. This recovers the ROW,
   * not the key — if the zkLogin session is gone, the only way back is a
   * re-login, which is what `sessionLost` routes to.
   */
  const rehydrate = useCallback((body: Record<string, unknown>) => {
    const status = body.status as string;
    const deadlineMs = (body.deadline_at_ms as number | null) ?? null;
    if (status === "settled") {
      setStep({ k: "settled", sgdMinor: String(body.estimated_sgd_minor ?? "0") });
    } else if (status === "expired") {
      setStep({ k: "expired", amountMinor: String(body.amount_usdsui_minor ?? "0") });
    } else if (status === "unmatched") {
      setStep({
        k: "unmatched",
        usdcMinor: String(body.sell_amount_usdc_minor ?? "0"),
      });
    } else if (status === "created" || status === "committed" || status === "sent") {
      // Resume, do NOT ask the merchant to sign in again.
      //
      // This component only renders when a valid zkLogin session exists, so an
      // open row never implies a lost key. Routing it to `sessionLost` produced
      // a loop: the card said "sign in", signing in remounted the component,
      // and it said it again — with a committed order sitting unsendable the
      // whole time.
      setStep({
        k: "waitingCoinbase",
        session: {
          request_id: String(body.request_id),
          offramp_token: "",
          sell_amount_usdc_minor: String(body.sell_amount_usdc_minor ?? "0"),
          estimated_sgd_minor: String(body.estimated_sgd_minor ?? "0"),
          coinbase_fee_sgd_minor: String(body.coinbase_fee_sgd_minor ?? "0"),
          swap: { expected_in_usdsui_minor: "0", max_in_usdsui_minor: "0", venues: [] },
          redeem: { required: false },
        },
        ready: null,
      });
    }
    void deadlineMs;
  }, []);

  // Flag discovery is a 404 from the server, never a client-side flag read.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/offramp/coinbase/status?owner=${session.address}`,
        );
        if (!cancelled && res.status === 404) setAvailable(false);
        if (res.ok) {
          const body = await res.json();
          if (!cancelled && body.found && body.status) {
            rehydrate(body);
          }
        }
      } catch {
        /* leave the section visible; the action will surface any real error */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.address, rehydrate]);


  async function startCashOut() {
    if (!amountMinor || amountMinor <= 0n) return;
    setStep({ k: "quoting" });
    try {
      const res = await fetch("/api/offramp/coinbase/session", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          owner: session.address,
          amount_usdsui_minor: amountMinor.toString(),
        }),
      });
      if (res.status === 404) {
        setAvailable(false);
        return;
      }
      const body = await res.json();
      if (!res.ok) {
        setStep({ k: "error", message: body.error ?? "could not start the cash-out" });
        return;
      }
      const plan = body as SessionResponse;
      if (plan.redeem.required) {
        setStep({ k: "redeemConfirm", plan });
      } else {
        openWidget(plan);
      }
    } catch (e) {
      setStep({ k: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Step 1 of 2: pull the shortfall out of Scallop, then open the widget.
   *
   * This has to complete BEFORE Coinbase sees an order. The send PTB spends
   * liquid USDsui, so committing an order first and redeeming after would put
   * an uncontrollable dependency (Scallop's shared pool cash) behind an
   * irreversible commitment.
   */
  async function runRedeemThenOpen(plan: SessionResponse) {
    const needed = BigInt(plan.redeem.realizable_underlying_minor ?? "0");
    if (needed <= 0n) {
      openWidget(plan);
      return;
    }
    setStep({ k: "redeemSigning" });
    try {
      const res = await fetch("/api/sponsor/earn-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uen: plan.uen ?? "",
          owner: session.address,
          direction: "to_cash",
          amount_usdsui_minor: needed.toString(),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setStep({ k: "error", message: body.error ?? "could not free up your funds" });
        return;
      }

      const txBytes = base64ToBytes(body.tx.tx_bytes_b64);
      const senderSig = await zkLoginSign(session, txBytes);
      const sui = getSuiClient();
      const exec = await sui.executeTransaction({
        transaction: txBytes,
        signatures: [senderSig, body.tx.sponsor_signature],
        include: { effects: true },
      });
      const tx = exec.Transaction;
      if (!tx?.status?.success) {
        throw new Error(tx?.status?.error?.message ?? "the redeem failed");
      }
      await sui.waitForTransaction({ digest: tx.digest });
      onDone();
      openWidget(plan);
    } catch (e) {
      setStep({ k: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  function openWidget(plan: SessionResponse) {
    setStep({ k: "handoff", session: plan });
    // New context, not a redirect — see the component docblock.
    const w = window.open(plan.offramp_url, "_blank", "noopener,noreferrer");
    windowRef.current = w;
    setStep({ k: "waitingCoinbase", session: plan, ready: null });
  }

  // Poll while the merchant is in the widget. Background tabs get throttled on
  // mobile, so this is a coarse interval and the tap-to-send below does not
  // depend on catching the transition promptly.
  useEffect(() => {
    if (step.k !== "waitingCoinbase" || step.ready) return;
    const plan = step.session;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch("/api/offramp/coinbase/prepare", {
          method: "POST",
          headers: authHeaders(plan.offramp_token),
          body: JSON.stringify({
            request_id: plan.request_id,
            owner: session.address,
          }),
        });
        if (cancelled) return;
        if (res.status === 202) return; // not committed yet
        const body = await res.json();
        if (!res.ok) {
          if (res.status === 409) {
            setStep({ k: "error", message: body.error ?? "the order can no longer be filled" });
          }
          return;
        }
        setStep({ k: "waitingCoinbase", session: plan, ready: body as PrepareReady });
      } catch {
        /* transient — the next tick retries */
      }
    };

    void tick();
    const id = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [step, authHeaders, session.address]);

  /**
   * Abandon an open order. Releases the per-owner in-flight lock straight away
   * rather than making the merchant wait out the 30-minute TTL — without this,
   * closing the Coinbase window left them unable to start another cash-out.
   */
  async function cancelCashOut(plan: SessionResponse) {
    try {
      await fetch("/api/offramp/coinbase/status", {
        method: "POST",
        headers: authHeaders(plan.offramp_token),
        body: JSON.stringify({
          request_id: plan.request_id,
          owner: session.address,
          action: "cancel",
        }),
      });
    } catch {
      /* the TTL will collect it regardless */
    }
    setAmount("");
    setStep({ k: "form" });
    onDone();
  }

  async function submitSend(plan: SessionResponse, ready: PrepareReady) {
    setStep({ k: "sendSigning" });
    try {
      const txBytes = base64ToBytes(ready.tx_bytes_b64);
      const senderSig = await zkLoginSign(session, txBytes);
      setStep({ k: "sending" });

      const sui = getSuiClient();
      const res = await sui.executeTransaction({
        transaction: txBytes,
        // Sender first, then the sponsor.
        signatures: [senderSig, ready.sponsor_signature],
        include: { effects: true },
      });
      const tx = res.Transaction;
      if (!tx?.status?.success) {
        throw new Error(tx?.status?.error?.message ?? "the send failed");
      }
      await sui.waitForTransaction({ digest: tx.digest });

      await fetch("/api/offramp/coinbase/status", {
        method: "POST",
        headers: authHeaders(plan.offramp_token),
        body: JSON.stringify({
          request_id: plan.request_id,
          owner: session.address,
          sui_digest: tx.digest,
        }),
      });

      setStep({ k: "settled", sgdMinor: plan.estimated_sgd_minor });
      onDone();
    } catch (e) {
      setStep({ k: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  if (!available) return null;

  return (
    <section className="glass-card rounded-2xl p-5 space-y-3">
      <div className="relative z-10 flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--accent)]">
          Cash out via Coinbase
        </p>
        {(step.k === "redeemConfirm" || step.k === "redeemSigning") && <StepMarker n={1} />}
        {(step.k === "sendSigning" || step.k === "sending") && <StepMarker n={2} />}
      </div>

      {step.k === "form" && (
        <div className="relative z-10 space-y-3">
          <p className="text-sm text-[var(--muted)] leading-relaxed">
            Sell USDsui into your own Coinbase account and get paid in SGD.
          </p>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            aria-label="Amount of USDsui to cash out"
            className="w-full min-h-[44px] rounded-xl border border-white/10 bg-[var(--surface-input)] px-3 text-white placeholder:text-[var(--muted-soft)]"
          />
          <div className="flex items-center justify-between text-[11px] text-[var(--muted)]">
            <span>Available {formatUsdsuiExact(maxMinor)} USDsui</span>
            <button
              type="button"
              className="glass-chip min-h-[44px] px-3"
              onClick={() => setAmount(formatUsdsuiExact(maxMinor))}
            >
              Max
            </button>
          </div>
          {yieldMinor > 0n && (
            <p className="text-[11px] text-[var(--muted-soft)]">
              Includes {formatUsdsuiExact(yieldMinor)} currently earning interest —
              we&apos;ll free it up first.
            </p>
          )}
          <button
            type="button"
            disabled={!amountMinor || amountMinor <= 0n || amountMinor > maxMinor}
            onClick={startCashOut}
            className="glass-btn-primary w-full min-h-[44px] disabled:opacity-40"
          >
            Continue
          </button>
        </div>
      )}

      {step.k === "quoting" && (
        <p className="relative z-10 text-sm text-[var(--muted)]">Getting you a price…</p>
      )}

      {step.k === "redeemConfirm" && (
        <div className="relative z-10 space-y-3">
          <p className="text-sm text-white">
            Free up {formatUsdsuiExact(BigInt(step.plan.redeem.realizable_underlying_minor ?? "0"))}{" "}
            USDsui from earning first?
          </p>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            You&apos;ll pay a 10% fee on the interest earned. It stops earning once
            freed, even if you don&apos;t finish.
          </p>
          {step.plan.redeem.partial && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-xs text-[var(--muted)]">
              Only part of your balance can be freed right now — the rest keeps
              earning until Scallop&apos;s pool has more cash.
            </div>
          )}
          <button
            type="button"
            onClick={() => runRedeemThenOpen(step.plan)}
            className="glass-btn-primary w-full min-h-[44px]"
          >
            Free up and continue
          </button>
          <button
            type="button"
            onClick={() => setStep({ k: "form" })}
            className="glass-chip w-full min-h-[44px]"
          >
            Cancel
          </button>
        </div>
      )}

      {step.k === "handoff" && (
        <p className="relative z-10 text-sm text-[var(--muted)]">Opening Coinbase…</p>
      )}

      {step.k === "waitingCoinbase" && !step.ready && (
        <div className="relative z-10 space-y-3">
          <p className="text-sm text-white">Finish in the Coinbase window we opened.</p>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Keep this tab open — we&apos;ll take it from there.
          </p>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 flex flex-wrap items-center justify-between gap-1 text-xs">
            <span className="text-[var(--muted)]">Selling</span>
            <span className="font-mono text-white">
              {formatUsdc(step.session.sell_amount_usdc_minor)} USDC
            </span>
          </div>
          {/* Popup blockers are silent, so always offer a focusable way through. */}
          {step.session.offramp_url && (
            <a
              href={step.session.offramp_url}
              target="_blank"
              rel="noreferrer"
              className="glass-chip w-full min-h-[44px] flex items-center justify-center"
            >
              Reopen Coinbase
            </a>
          )}
          <button
            type="button"
            onClick={() => cancelCashOut(step.session)}
            className="glass-chip w-full min-h-[44px]"
          >
            Cancel this cash-out
          </button>
          <p className="text-[10px] text-[var(--muted)] border-t border-white/5 pt-2 leading-relaxed">
            Coinbase pays SGD into your own Coinbase account. Moving it to your
            bank is a separate step you do there.
          </p>
        </div>
      )}

      {step.k === "waitingCoinbase" && step.ready && (
        <div className="relative z-10 space-y-3">
          <p className="text-sm text-white">Coinbase is ready — one tap to finish.</p>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 flex flex-wrap items-center justify-between gap-1 text-xs">
            <span className="text-[var(--muted)]">Expires in</span>
            <Countdown deadlineMs={step.ready.deadline_at_ms} />
          </div>
          <button
            type="button"
            onClick={() => submitSend(step.session, step.ready!)}
            className="glass-btn-primary w-full min-h-[44px] text-base"
          >
            Send {formatUsdc(step.ready.sell_amount_usdc_minor)} USDC
          </button>
        </div>
      )}

      {(step.k === "redeemSigning" || step.k === "sendSigning") && (
        <p className="relative z-10 text-sm text-[var(--muted)]">Waiting for your signature…</p>
      )}
      {step.k === "sending" && (
        <p className="relative z-10 text-sm text-[var(--muted)]">Sending USDC…</p>
      )}

      {step.k === "settled" && (
        <div className="relative z-10 space-y-2">
          <p className="text-sm text-white">
            S${formatSgdMinor(BigInt(step.sgdMinor || "0"))} is in your Coinbase account.
          </p>
          <p className="text-xs text-[var(--muted)]">
            Move it to your bank from Coinbase whenever you like.
          </p>
        </div>
      )}

      {step.k === "expired" && (
        <div className="relative z-10 space-y-2">
          <p className="text-sm text-white">This cash-out expired</p>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Coinbase cancelled the order. Nothing was sent and your USDsui is
            untouched.
          </p>
          <button
            type="button"
            onClick={() => setStep({ k: "form" })}
            className="glass-chip w-full min-h-[44px]"
          >
            Try again
          </button>
        </div>
      )}

      {step.k === "unmatched" && (
        <div className="relative z-10 space-y-2">
          <p className="text-sm text-white">Coinbase didn&apos;t complete the sale</p>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            We delivered {formatUsdc(step.usdcMinor)} USDC to Coinbase, but the
            sale to SGD never went through. The USDC is almost certainly sitting
            in your Coinbase account — check there and sell it to SGD yourself.
            If Coinbase sent it back to your wallet instead, it appears as a
            USDC balance at the top of this page.
          </p>
        </div>
      )}

      {step.k === "sessionLost" && (
        <div className="relative z-10 space-y-2">
          <p className="text-sm text-white">Sign in again to finish</p>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Your order is still open. Signing in restores your key so we can send.
          </p>
          {step.deadlineMs && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 flex items-center justify-between text-xs">
              <span className="text-[var(--muted)]">Expires in</span>
              <Countdown deadlineMs={step.deadlineMs} />
            </div>
          )}
          <a
            href="/app/merchant/login?next=/app/merchant/wallet"
            className="glass-btn-primary w-full min-h-[44px] flex items-center justify-center"
          >
            Continue with Google
          </a>
        </div>
      )}

      {step.k === "error" && (
        <div className="relative z-10 space-y-2">
          <p className="text-sm text-[var(--danger)]">{step.message}</p>
          <button
            type="button"
            onClick={() => setStep({ k: "form" })}
            className="glass-chip w-full min-h-[44px]"
          >
            Start over
          </button>
        </div>
      )}

      {step.k === "form" && (
        <p className="relative z-10 text-[10px] text-[var(--muted)] border-t border-white/5 pt-2 leading-relaxed">
          {DISCLOSURE}
        </p>
      )}
    </section>
  );
}
