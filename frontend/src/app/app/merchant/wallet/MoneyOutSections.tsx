"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import {
  formatSgdMinor,
  formatUsdsuiExact,
  parseUsdsuiToMinor,
} from "@/lib/money";
import { buildGaslessUsdsuiSendAll } from "@/lib/quay/transfer";
import { USDSUI } from "@/lib/quay/scallop";
import { txUrl } from "@/lib/sui-config";
import { zkLoginSign, type ZkLoginSession } from "@/lib/zklogin";
import { getSuiClient } from "@/lib/sui-client";

import { CoinbaseOfframpSection } from "./CoinbaseOfframpSection";
import { StrandedUsdcCard } from "./StrandedUsdcCard";

/**
 * Money-out controls for /merchant/wallet. Hierarchy (D2-design): cash-out
 * to SGD is the primary hero; withdraw-to-address is a quieter secondary
 * action beneath it. Both operate on LIQUID USDsui only — a merchant
 * earning yield holds sCoin, so we detect that and point them at the
 * earning toggle instead of failing (D3).
 *
 * Cash-out is custodial (treasury holds funds briefly) and sandbox-only;
 * the disclosure copy says so. Withdraw is fully non-custodial.
 */

const USDSUI_UNIT = 10 ** USDSUI.decimals;

function base64ToBytes(b64: string): Uint8Array {
  if (typeof window !== "undefined" && typeof window.atob === "function") {
    const s = window.atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

function formatUsdsui(minor: bigint): string {
  const dollars = minor / BigInt(USDSUI_UNIT);
  const frac = minor % BigInt(USDSUI_UNIT);
  return `${dollars}.${frac.toString().padStart(USDSUI.decimals, "0").slice(0, 2)}`;
}



interface Balances {
  liquidMinor: bigint;
  yieldMinor: bigint;
}

function useUsdsuiBalances(owner: string | undefined) {
  const sui = getSuiClient();
  return useQuery<Balances>({
    queryKey: ["usdsui-balances", owner],
    queryFn: async () => {
      if (!owner) return { liquidMinor: 0n, yieldMinor: 0n };
      const [liquid, yld] = await Promise.all([
        sui.getBalance({ owner, coinType: USDSUI.coinType }),
        sui.getBalance({ owner, coinType: USDSUI.sCoinType }),
      ]);
      return {
        liquidMinor: BigInt(liquid.balance.balance),
        yieldMinor: BigInt(yld.balance.balance),
      };
    },
    enabled: !!owner,
    staleTime: 10_000,
  });
}

export function MoneyOutSections({ session }: { session: ZkLoginSession }) {
  const balQ = useUsdsuiBalances(session.address);
  const bal = balQ.data;

  if (balQ.isLoading || !bal) {
    return (
      <section className="glass-card rounded-2xl p-5">
        <p className="relative z-10 text-sm text-[var(--muted-soft)]">Loading your balance…</p>
      </section>
    );
  }

  // Warm empty state: nothing liquid to move AND nothing earning to free up.
  //
  // The Coinbase rail works from a pure-sCoin balance — it redeems as part of
  // the flow — so a merchant whose funds are all earning must still see it.
  // Gating this on `liquidMinor === 0n` alone swallowed the whole section for
  // exactly the merchants most likely to want it.
  if (bal.liquidMinor === 0n && bal.yieldMinor === 0n) {
    return (
      <section className="glass-card rounded-2xl p-5 space-y-2">
        <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--accent)]">Cash out</p>
        {bal.yieldMinor > 0n ? (
          <p className="relative z-10 text-sm text-[var(--muted)] leading-relaxed">
            Your USDsui is currently earning interest. Turn earning off below to
            free it up, then come back to cash out or withdraw.
          </p>
        ) : (
          <p className="relative z-10 text-sm text-[var(--muted)] leading-relaxed">
            No USDsui to cash out yet — payments you accept show up here.{" "}
            <Link href="/scan" className="text-[var(--accent)] hover:underline">
              Take a payment →
            </Link>
          </p>
        )}
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <StrandedUsdcCard owner={session.address} />
      {bal.liquidMinor === 0n ? (
        <section className="glass-card rounded-2xl p-5 space-y-2">
          <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--accent)]">
            Cash out
          </p>
          <p className="relative z-10 text-sm text-[var(--muted)] leading-relaxed">
            Your USDsui is currently earning interest. The Coinbase cash-out
            below can free it up for you, or turn earning off to withdraw it
            directly.
          </p>
        </section>
      ) : (
        <>
          <CashOutSection session={session} liquidMinor={bal.liquidMinor} onDone={() => balQ.refetch()} />
          <WithdrawSection session={session} liquidMinor={bal.liquidMinor} onDone={() => balQ.refetch()} />
        </>
      )}
      <CoinbaseOfframpSection
        session={session}
        liquidMinor={bal.liquidMinor}
        yieldMinor={bal.yieldMinor}
        onDone={() => balQ.refetch()}
      />
    </div>
  );
}

// ─────────────────────────── Cash out to SGD (hero) ─────────────────────

interface RecipientField {
  key: string;
  name: string;
  type: string;
  required: boolean;
  example?: string;
  valuesAllowed?: Array<{ key: string; name: string }> | null;
}
interface RecipientType {
  type: string;
  title: string;
  fields: RecipientField[];
}
interface QuoteResponse {
  rate_sgd_per_usd: number;
  fee_bps: number;
  net_sgd_minor: string;
  recipient_schema:
    | Array<{ type: string; title: string; fields: Array<{ group: RecipientField[] }> }>
    | null;
}

type CashStep =
  | { k: "form" }
  | { k: "quoting" }
  | { k: "review"; quote: QuoteResponse; types: RecipientType[] }
  | { k: "processing"; label: string }
  | { k: "success"; digest: string; netSgdMinor: string }
  | { k: "pending" }
  | { k: "error"; message: string };

function CashOutSection({
  session,
  liquidMinor,
  onDone,
}: {
  session: ZkLoginSession;
  liquidMinor: bigint;
  onDone: () => void;
}) {
  const sui = getSuiClient();
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<CashStep>({ k: "form" });
  const [recipientType, setRecipientType] = useState<string>("");
  const [details, setDetails] = useState<Record<string, string>>({});

  const amountMinor = parseUsdsuiToMinor(amount);
  const amountValid = amountMinor !== null && amountMinor > 0n && amountMinor <= liquidMinor;

  async function getQuote() {
    if (!amountValid || amountMinor === null) return;
    setStep({ k: "quoting" });
    try {
      const res = await fetch("/api/cashout/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount_usdsui_minor: amountMinor.toString() }),
      });
      if (res.status === 404) {
        setStep({ k: "error", message: "Cash-out isn't available right now." });
        return;
      }
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setStep({ k: "error", message: e.error ?? `quote failed (${res.status})` });
        return;
      }
      const quote = (await res.json()) as QuoteResponse;
      const types: RecipientType[] = (quote.recipient_schema ?? []).map((t) => ({
        type: t.type,
        title: t.title,
        // Only the fields Wise actually requires — drops optional ones
        // (e.g. PayNow's email) so the form stays minimal.
        fields: t.fields.flatMap((f) => f.group).filter((f) => f.required),
      }));
      // Pre-fill select fields (e.g. legalType) with their first allowed
      // value so the merchant only touches what matters (name + PayNow id).
      const initial: Record<string, string> = {};
      for (const f of types[0]?.fields ?? []) {
        if (f.type === "select" && f.valuesAllowed?.length) {
          initial[f.key] = f.valuesAllowed[0].key;
        }
      }
      setRecipientType(types[0]?.type ?? "");
      setDetails(initial);
      setStep({ k: "review", quote, types });
    } catch (e) {
      setStep({ k: "error", message: e instanceof Error ? e.message : "quote failed" });
    }
  }

  async function cashOut(quote: QuoteResponse, types: RecipientType[]) {
    const chosen = types.find((t) => t.type === recipientType);
    if (!chosen || amountMinor === null) return;
    const missing = chosen.fields.filter((f) => f.required && !details[f.key]?.trim());
    if (missing.length > 0) {
      setStep({ k: "error", message: `Please fill: ${missing.map((m) => m.name).join(", ")}` });
      return;
    }
    try {
      setStep({ k: "processing", label: "Preparing…" });
      const initRes = await fetch("/api/cashout/initiate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner: session.address,
          amount_usdsui_minor: amountMinor.toString(),
          recipient: { type: chosen.type, details },
        }),
      });
      if (!initRes.ok) {
        const e = await initRes.json().catch(() => ({}));
        throw new Error(e.error ?? `initiate failed (${initRes.status})`);
      }
      const init = (await initRes.json()) as {
        cashout_id: string;
        tx_bytes_b64: string;
        sponsor_signature: string;
        net_sgd_minor: string;
      };

      setStep({ k: "processing", label: "Signing…" });
      const txBytes = base64ToBytes(init.tx_bytes_b64);
      const senderSig = await zkLoginSign(session, txBytes);

      setStep({ k: "processing", label: "Sending USDsui…" });
      const resultRes = await sui.executeTransaction({
        transaction: txBytes,
        signatures: [senderSig, init.sponsor_signature],
        include: { effects: true },
      });
      const result = resultRes.Transaction;
      if (!result?.status?.success) {
        throw new Error(result?.status?.error?.message ?? "transfer failed");
      }
      await sui.waitForTransaction({ digest: result.digest });

      setStep({ k: "processing", label: "Sending SGD…" });
      const confirmRes = await fetch("/api/cashout/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cashout_id: init.cashout_id, digest: result.digest }),
      });
      const confirm = await confirmRes.json().catch(() => ({}));
      if (confirmRes.status === 202 || confirm.status === "pending") {
        setStep({ k: "pending" });
        onDone();
        return;
      }
      if (!confirmRes.ok) {
        throw new Error(confirm.error ?? `payout failed (${confirmRes.status})`);
      }
      setStep({ k: "success", digest: result.digest, netSgdMinor: init.net_sgd_minor });
      onDone();
    } catch (e) {
      setStep({ k: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  const processing = step.k === "processing" || step.k === "quoting";

  return (
    <section className="glass-card rounded-2xl p-5 space-y-3">
      <div className="relative z-10">
        <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--accent)]">Cash out to SGD</p>
        <p className="text-[11px] text-[var(--muted-soft)] mt-0.5">
          Available: {formatUsdsui(liquidMinor)} USDsui
        </p>
      </div>

      {(step.k === "form" || step.k === "quoting" || step.k === "error") && (
        <div className="relative z-10 space-y-2">
          <label htmlFor="cashout-amount" className="block text-[11px] text-[var(--muted)]">
            Amount (USDsui)
          </label>
          <div className="flex items-center gap-2">
            <input
              id="cashout-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="flex-1 min-h-[44px] rounded-lg border border-white/10 bg-white/[0.03] px-3 text-white placeholder:text-[var(--muted-soft)]"
            />
            <button
              type="button"
              onClick={() => setAmount(formatUsdsui(liquidMinor))}
              className="glass-chip rounded-lg min-h-[44px]"
            >
              Max
            </button>
          </div>
          <button
            type="button"
            onClick={getQuote}
            disabled={!amountValid || processing}
            className="glass-btn-primary text-sm py-2 px-4 min-h-[44px] disabled:opacity-50"
          >
            {step.k === "quoting" ? "Getting rate…" : "Continue"}
          </button>
          {amount !== "" && !amountValid && (
            <p className="text-[11px] text-[var(--muted)]">
              Enter an amount up to {formatUsdsui(liquidMinor)} USDsui.
            </p>
          )}
          {step.k === "error" && (
            <p className="text-[11px] text-red-300 break-words">{step.message}</p>
          )}
        </div>
      )}

      {step.k === "review" && (
        <div className="relative z-10 space-y-3">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <p className="text-sm text-white">
              You&apos;ll receive <span className="font-semibold">S${formatSgdMinor(BigInt(step.quote.net_sgd_minor))}</span>
            </p>
            <p className="text-[11px] text-[var(--muted)] mt-0.5">
              Rate {step.quote.rate_sgd_per_usd.toFixed(4)} · Quay fee {(step.quote.fee_bps / 100).toFixed(2)}%
            </p>
          </div>

          {step.types.length === 0 ? (
            <p className="text-[11px] text-[var(--muted)]">
              Cash-out is temporarily unavailable (payout provider unreachable). Try again shortly.
            </p>
          ) : (
            <div className="space-y-2">
              {step.types.length > 1 && (
                <select
                  value={recipientType}
                  onChange={(e) => {
                    setRecipientType(e.target.value);
                    setDetails({});
                  }}
                  className="w-full min-h-[44px] rounded-lg border border-white/10 bg-white/[0.03] px-3 text-white"
                >
                  {step.types.map((t) => (
                    <option key={t.type} value={t.type} className="bg-black">
                      {t.title}
                    </option>
                  ))}
                </select>
              )}
              {step.types
                .find((t) => t.type === recipientType)
                ?.fields.map((f) => (
                  <div key={f.key} className="space-y-1">
                    <label htmlFor={`r-${f.key}`} className="block text-[11px] text-[var(--muted)]">
                      {f.name}
                      {f.required ? " *" : ""}
                    </label>
                    {f.type === "select" && f.valuesAllowed?.length ? (
                      <select
                        id={`r-${f.key}`}
                        value={details[f.key] ?? f.valuesAllowed[0].key}
                        onChange={(e) => setDetails((d) => ({ ...d, [f.key]: e.target.value }))}
                        className="w-full min-h-[44px] rounded-lg border border-white/10 bg-white/[0.03] px-3 text-white"
                      >
                        {f.valuesAllowed.map((v) => (
                          <option key={v.key} value={v.key} className="bg-black">
                            {v.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={`r-${f.key}`}
                        value={details[f.key] ?? ""}
                        onChange={(e) => setDetails((d) => ({ ...d, [f.key]: e.target.value }))}
                        placeholder={f.example ?? ""}
                        className="w-full min-h-[44px] rounded-lg border border-white/10 bg-white/[0.03] px-3 text-white placeholder:text-[var(--muted-soft)]"
                      />
                    )}
                  </div>
                ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => cashOut(step.quote, step.types)}
              disabled={step.types.length === 0}
              className="glass-btn-primary text-sm py-2 px-4 min-h-[44px] disabled:opacity-50"
            >
              Cash out S${formatSgdMinor(BigInt(step.quote.net_sgd_minor))}
            </button>
            <button type="button" onClick={() => setStep({ k: "form" })} className="glass-chip rounded-lg min-h-[44px]">
              Back
            </button>
          </div>
        </div>
      )}

      {step.k === "processing" && (
        <p className="relative z-10 text-sm text-[var(--muted)]">{step.label}</p>
      )}

      {step.k === "success" && (
        <div className="relative z-10 space-y-1">
          <p className="text-sm text-[var(--success)]">
            S${formatSgdMinor(BigInt(step.netSgdMinor))} on its way to your bank.
          </p>
          <a href={txUrl(step.digest)} target="_blank" rel="noreferrer" className="text-[11px] font-mono text-[var(--accent)] hover:underline">
            Receipt ↗
          </a>
        </div>
      )}

      {step.k === "pending" && (
        <p className="relative z-10 text-sm text-[var(--muted)]">
          Your USDsui was received. The SGD payout is pending and will be retried — it&apos;ll
          land in your account shortly.
        </p>
      )}

      {/* Custody + fee disclosure — muted micro-copy, not an alert card. */}
      <p className="relative z-10 text-[10px] text-[var(--muted)] leading-relaxed border-t border-white/5 pt-2">
        Manual demo settlement, not production. Quay briefly holds your USDsui during
        cash-out and pays SGD from its own balance. A 0.25% FX fee applies. Network fees are on us.
      </p>
    </section>
  );
}

// ─────────────────────── Withdraw to address (secondary) ────────────────

type WStep =
  | { k: "idle" }
  | { k: "confirm" }
  | { k: "processing"; label: string }
  | { k: "success"; digest: string }
  | { k: "error"; message: string };

function WithdrawSection({
  session,
  liquidMinor,
  onDone,
}: {
  session: ZkLoginSession;
  liquidMinor: bigint;
  onDone: () => void;
}) {
  const sui = getSuiClient();
  const [open, setOpen] = useState(false);
  // "all" → gasless send_funds of the whole balance (free, no sponsor).
  // "amount" → sponsored partial transfer (split isn't gasless-allowlisted).
  const [mode, setMode] = useState<"all" | "amount">("all");
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<WStep>({ k: "idle" });

  const amountMinor = parseUsdsuiToMinor(amount);
  const addrValid = /^0x[0-9a-fA-F]{64}$/.test(destination.trim());
  const isAll = mode === "all";
  const partialValid = amountMinor !== null && amountMinor > 0n && amountMinor <= liquidMinor;
  const canReview = addrValid && (isAll ? liquidMinor > 0n : partialValid);
  // Amount shown on the confirm screen.
  const sendMinor = isAll ? liquidMinor : (amountMinor ?? 0n);

  async function send() {
    const dest = destination.trim();
    try {
      let txBytes: Uint8Array;
      let signature: string[];

      if (isAll) {
        // Gasless: build client-side, no sponsor, merchant signs gas=0 alone.
        setStep({ k: "processing", label: "Preparing…" });
        const { tx } = await buildGaslessUsdsuiSendAll({
          sui,
          owner: session.address,
          destination: dest,
        });
        txBytes = await tx.build({ client: sui });
        setStep({ k: "processing", label: "Signing…" });
        signature = [await zkLoginSign(session, txBytes)];
      } else {
        // Sponsored partial transfer (gas on us).
        if (amountMinor === null) return;
        setStep({ k: "processing", label: "Preparing…" });
        const res = await fetch("/api/sponsor/withdraw", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            owner: session.address,
            destination: dest,
            amount_usdsui_minor: amountMinor.toString(),
          }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error(e.error ?? `withdraw failed (${res.status})`);
        }
        const sp = (await res.json()) as { tx_bytes_b64: string; sponsor_signature: string };
        txBytes = base64ToBytes(sp.tx_bytes_b64);
        setStep({ k: "processing", label: "Signing…" });
        const senderSig = await zkLoginSign(session, txBytes);
        signature = [senderSig, sp.sponsor_signature];
      }

      setStep({ k: "processing", label: isAll ? "Sending (gasless)…" : "Sending…" });
      const resultRes = await sui.executeTransaction({
        transaction: txBytes,
        signatures: signature,
        include: { effects: true },
      });
      const result = resultRes.Transaction;
      if (!result?.status?.success) {
        throw new Error(result?.status?.error?.message ?? "transfer failed");
      }
      await sui.waitForTransaction({ digest: result.digest });
      setStep({ k: "success", digest: result.digest });
      setDestination("");
      setAmount("");
      onDone();
    } catch (e) {
      setStep({ k: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  if (!open) {
    return (
      <section className="glass-card rounded-2xl p-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="relative z-10 text-sm text-[var(--accent)] hover:underline"
        >
          or withdraw USDsui to an address →
        </button>
      </section>
    );
  }

  const processing = step.k === "processing";

  return (
    <section className="glass-card rounded-2xl p-5 space-y-3">
      <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">
        Withdraw USDsui to an address
      </p>

      {step.k !== "confirm" && step.k !== "success" && (
        <div className="relative z-10 space-y-2">
          <label htmlFor="wd-addr" className="block text-[11px] text-[var(--muted)]">Destination Sui address</label>
          <input
            id="wd-addr"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            className="w-full min-h-[44px] rounded-lg border border-white/10 bg-white/[0.03] px-3 font-mono text-sm text-white placeholder:text-[var(--muted-soft)]"
          />
          {destination !== "" && !addrValid && (
            <p className="text-[11px] text-[var(--muted)]">Enter a full 0x + 64-hex Sui address.</p>
          )}

          {/* Everything = gasless (free). Amount = sponsored partial transfer. */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              type="button"
              onClick={() => setMode("all")}
              className={`rounded-xl border px-3 py-2 text-left text-xs backdrop-blur-md transition ${isAll ? "border-[var(--accent)] bg-[var(--accent)]/12 text-white" : "border-white/10 bg-white/[0.03] text-[var(--muted)] hover:border-white/25"}`}
            >
              <p className="font-medium">Everything</p>
              <p className="text-[10px] text-[var(--muted-soft)]">{formatUsdsui(liquidMinor)} USDsui · free</p>
            </button>
            <button
              type="button"
              onClick={() => setMode("amount")}
              className={`rounded-xl border px-3 py-2 text-left text-xs backdrop-blur-md transition ${!isAll ? "border-[var(--accent)] bg-[var(--accent)]/12 text-white" : "border-white/10 bg-white/[0.03] text-[var(--muted)] hover:border-white/25"}`}
            >
              <p className="font-medium">Amount</p>
              <p className="text-[10px] text-[var(--muted-soft)]">a specific sum</p>
            </button>
          </div>

          {!isAll && (
            <>
              <label htmlFor="wd-amount" className="block text-[11px] text-[var(--muted)]">Amount (USDsui)</label>
              <div className="flex items-center gap-2">
                <input
                  id="wd-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="flex-1 min-h-[44px] rounded-lg border border-white/10 bg-white/[0.03] px-3 text-white placeholder:text-[var(--muted-soft)]"
                />
                <button type="button" onClick={() => setAmount(formatUsdsuiExact(liquidMinor))} className="glass-chip rounded-lg min-h-[44px]">
                  Max
                </button>
              </div>
            </>
          )}

          <p className="text-[10px] text-[var(--muted-soft)]">
            {isAll
              ? "Gasless — no network fee. Sends your full USDsui balance."
              : "Partial amount — network fees are on us."}
          </p>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => setStep({ k: "confirm" })}
              disabled={!canReview || processing}
              className="glass-btn-primary text-sm py-2 px-4 min-h-[44px] disabled:opacity-50"
            >
              {processing ? "Working…" : "Review withdrawal"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="glass-chip rounded-lg min-h-[44px]">
              Cancel
            </button>
          </div>
          {step.k === "error" && <p className="text-[11px] text-red-300 break-words">{step.message}</p>}
        </div>
      )}

      {step.k === "confirm" && (
        <div className="relative z-10 space-y-3">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-2">
            <p className="text-[11px] text-[var(--muted)]">Sending</p>
            <p className="text-sm text-white">
              {formatUsdsui(sendMinor)} USDsui{isAll ? " (everything)" : ""}
            </p>
            <p className="text-[11px] text-[var(--muted)] mt-2">To</p>
            <p className="font-mono text-xs text-white break-all">{destination.trim()}</p>
            <p className="text-[10px] text-[var(--muted-soft)] mt-2">
              {isAll ? "Gasless transfer — no network fee." : "Sponsored — network fees on us."}
            </p>
          </div>
          <p className="text-[11px] text-[var(--muted)]">
            On-chain transfers are final — double-check this address. Funds sent to the wrong
            address can&apos;t be recovered.
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={send} className="glass-btn-primary text-sm py-2 px-4 min-h-[44px]">
              Confirm &amp; send
            </button>
            <button type="button" onClick={() => setStep({ k: "idle" })} className="glass-chip rounded-lg min-h-[44px]">
              Back
            </button>
          </div>
        </div>
      )}

      {step.k === "processing" && <p className="relative z-10 text-sm text-[var(--muted)]">{step.label}</p>}

      {step.k === "success" && (
        <div className="relative z-10 space-y-1">
          <p className="text-sm text-[var(--success)]">Sent.</p>
          <a href={txUrl(step.digest)} target="_blank" rel="noreferrer" className="text-[11px] font-mono text-[var(--accent)] hover:underline">
            Receipt ↗
          </a>
          <button type="button" onClick={() => { setStep({ k: "idle" }); setOpen(false); }} className="block text-[11px] text-[var(--muted)] hover:underline pt-1">
            Done
          </button>
        </div>
      )}
    </section>
  );
}
