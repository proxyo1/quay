"use client";

import { useSuiClient } from "@mysten/dapp-kit";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { fetchMerchantProfile, getEntriesTableId } from "@/lib/quay";
import { USDSUI } from "@/lib/quay/scallop";
import { QUAY, accountUrl, txUrl } from "@/lib/sui-config";
import { uploadBlob, WalrusUploadError } from "@/lib/walrus/client";
import {
  buildMerchantProfileBytes,
  LEGACY_RECEIVE_TOKEN,
  RECEIVE_TOKEN_OPTIONS,
  type SupportedReceiveToken,
  type YieldRouting,
} from "@/lib/walrus/profileSchema";
import { useZkLoginSession, zkLoginSign, type ZkLoginSession } from "@/lib/zklogin";

import { MoneyOutSections } from "./MoneyOutSections";

function receiveLabel(token: SupportedReceiveToken): string {
  const opt = RECEIVE_TOKEN_OPTIONS.find((o) => o.type === token);
  return opt?.label ?? token;
}

export default function WalletPage() {
  const { session, hydrated, expired, signOut } = useZkLoginSession();
  const router = useRouter();

  useEffect(() => {
    if (hydrated && !session) {
      const expiredParam = expired ? "&expired=1" : "";
      router.replace(`/merchant/login?next=/merchant/wallet${expiredParam}`);
    }
  }, [hydrated, session, expired, router]);

  if (hydrated && !session) {
    return (
      <main className="relative z-10 mx-auto max-w-2xl px-6 py-16">
        <p className="text-sm text-[var(--muted-soft)]">Redirecting to sign-in…</p>
      </main>
    );
  }
  if (!session) return null;

  async function copy(s: string) {
    try {
      await navigator.clipboard.writeText(s);
    } catch {
      /* ignore */
    }
  }

  return (
    <main className="relative z-10 mx-auto max-w-2xl px-5 py-8 space-y-6">
      <Link href="/merchant" className="text-xs text-[var(--accent)] hover:underline inline-flex items-center gap-1">
        <span aria-hidden>←</span> merchant
      </Link>
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Account</h1>
        <p className="text-sm text-[var(--muted)] leading-relaxed">
          Your business account, signed in with Google. No passwords to
          remember, no recovery codes to back up. Sign back in from any
          device and everything&apos;s right where you left it.
        </p>
      </header>

      <MoneyOutSections session={session} />

      <SettlementPreferenceSection session={session} />

      <section className="glass-card rounded-2xl p-5 space-y-2">
        <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">Signed in as</p>
        <p className="relative z-10 text-sm text-white">{session.email}</p>
      </section>

      <section className="glass-card rounded-2xl p-5 space-y-3">
        <div className="relative z-10 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">Account ID</p>
            <p className="font-mono text-sm text-white break-all mt-1">{session.address}</p>
          </div>
          <button
            type="button"
            onClick={() => copy(session.address)}
            className="glass-chip rounded-lg shrink-0"
          >
            Copy
          </button>
        </div>
        <p className="relative z-10 text-xs text-[var(--muted-soft)]">
          <a
            href={accountUrl(session.address)}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent)] hover:underline"
          >
            View on Sui ↗
          </a>
        </p>
      </section>

      <section className="glass-card rounded-2xl p-5 space-y-3">
        <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">Session</p>
        <button
          type="button"
          onClick={() => {
            signOut();
            router.replace("/merchant");
          }}
          className="relative z-10 glass-chip rounded-lg"
        >
          Sign out
        </button>
        <p className="relative z-10 text-[11px] text-[var(--muted-soft)]">
          Signing out clears this device. Sign back in with the same Google
          account to land on the same business.
        </p>
      </section>

      <footer className="text-[11px] text-[var(--muted-soft)] pt-4 border-t border-white/5">
        Powered by Sui · Walrus · Pyth
      </footer>
    </main>
  );
}

// ─── Settlement preference section ──────────────────────────────────────

interface MerchantUenRow {
  uen: string;
  metadataBlobId: string | null;
}

interface MerchantRegisteredEvent {
  uen_hash: number[];
  sui_address: string;
  timestamp_ms: string;
}

function useMerchantUenRows(address: string | undefined) {
  const sui = useSuiClient();
  return useQuery<MerchantUenRow[]>({
    queryKey: ["merchant-uens-wallet", address],
    queryFn: async () => {
      if (!address) return [];
      const tableId = await getEntriesTableId(sui, QUAY.registryId);
      const events = await sui.queryEvents({
        query: { MoveEventType: `${QUAY.packageId}::payments::MerchantRegistered` },
        order: "descending",
        limit: 100,
      });
      const mine = events.data.filter(
        (e) => (e.parsedJson as MerchantRegisteredEvent | undefined)?.sui_address === address,
      );
      const rows = await Promise.all(
        mine.map(async (e) => {
          const ev = e.parsedJson as MerchantRegisteredEvent;
          try {
            const field = await sui.getDynamicFieldObject({
              parentId: tableId,
              name: { type: "vector<u8>", value: ev.uen_hash },
            });
            const content = field.data?.content;
            if (!content || content.dataType !== "moveObject") return null;
            const fields = (content.fields as { value?: { fields?: Record<string, unknown> } })
              .value?.fields;
            if (!fields) return null;
            const uenRaw = fields.uen_raw;
            let uen: string | null = null;
            if (Array.isArray(uenRaw)) uen = new TextDecoder().decode(new Uint8Array(uenRaw as number[]));
            else if (typeof uenRaw === "string") uen = uenRaw;
            if (!uen) return null;
            const meta = fields.metadata_uri;
            const metadataBlobId = typeof meta === "string" && meta.length > 0 ? meta : null;
            return { uen, metadataBlobId };
          } catch {
            return null;
          }
        }),
      );
      return rows.filter((x): x is MerchantUenRow => x !== null);
    },
    enabled: !!address,
    staleTime: 10_000,
  });
}

type SaveState =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "sponsoring" }
  | { kind: "signing" }
  | { kind: "executing" }
  | { kind: "success"; digest: string }
  | { kind: "error"; message: string };

function SettlementPreferenceSection({ session }: { session: ZkLoginSession }) {
  const uensQ = useMerchantUenRows(session.address);
  const uens = uensQ.data ?? [];

  return (
    <section className="glass-card rounded-2xl p-5 space-y-3">
      <div className="relative z-10">
        <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--accent)]">Get paid in</p>
        <p className="text-[11px] text-[var(--muted-soft)] mt-0.5">
          Choose the currency you want to receive. Customers can pay with
          anything — we auto-convert so you always get this one.
        </p>
      </div>
      {uensQ.isLoading ? (
        <p className="relative z-10 text-xs text-[var(--muted-soft)]">Loading your businesses…</p>
      ) : uens.length === 0 ? (
        <p className="relative z-10 text-sm text-[var(--muted)]">
          You haven&apos;t added any businesses yet.{" "}
          <Link href="/merchant/onboard" className="text-[var(--accent)] hover:underline">
            Add one →
          </Link>
        </p>
      ) : (
        <ul className="relative z-10 space-y-3">
          {uens.map((row) => (
            <UenPreferenceRow key={row.uen} row={row} session={session} onSaved={() => uensQ.refetch()} />
          ))}
        </ul>
      )}
    </section>
  );
}

function UenPreferenceRow({
  row,
  session,
  onSaved,
}: {
  row: MerchantUenRow;
  session: ZkLoginSession;
  onSaved: () => void;
}) {
  const sui = useSuiClient();
  const [editing, setEditing] = useState(false);
  const [chosen, setChosen] = useState<SupportedReceiveToken | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const profileQ = useQuery({
    queryKey: ["merchant-profile", row.metadataBlobId],
    queryFn: () => fetchMerchantProfile(row.metadataBlobId),
    enabled: !!row.metadataBlobId,
    staleTime: 30_000,
  });

  const current = profileQ.data?.receiveToken ?? LEGACY_RECEIVE_TOKEN;
  const logoBlobId = profileQ.data?.logoBlobId ?? null;
  const merchantName = profileQ.data?.merchantName;

  async function handleSave(newToken: SupportedReceiveToken) {
    if (newToken === current) {
      setEditing(false);
      return;
    }
    setSave({ kind: "uploading" });
    try {
      // 1. Build the new v1 profile blob — preserve existing logo + name.
      const newBytes = buildMerchantProfileBytes({
        logoBlobId,
        preferredReceiveToken: newToken,
        merchantName,
      });
      let newBlobId: string;
      try {
        const upload = await uploadBlob(newBytes);
        newBlobId = upload.blobId;
      } catch (e) {
        const why = e instanceof WalrusUploadError ? e.message : String(e);
        throw new Error(`Couldn't save your settings: ${why}`);
      }

      // 2. Ask the sponsor endpoint to build + co-sign the update tx.
      setSave({ kind: "sponsoring" });
      const res = await fetch("/api/sponsor/update-metadata", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uen: row.uen,
          owner: session.address,
          new_metadata_blob_id: newBlobId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `sponsor HTTP ${res.status}`);
      }
      const sp = (await res.json()) as {
        tx_bytes_b64: string;
        sponsor_signature: string;
      };

      // 3. Sign the tx bytes as the merchant via zkLogin.
      setSave({ kind: "signing" });
      const txBytes = base64ToBytes(sp.tx_bytes_b64);
      const senderSig = await zkLoginSign(session, txBytes);

      // 4. Submit with both signatures.
      setSave({ kind: "executing" });
      const result = await sui.executeTransactionBlock({
        transactionBlock: txBytes,
        signature: [senderSig, sp.sponsor_signature],
        options: { showEffects: true },
      });
      const status = result.effects?.status?.status;
      if (status !== "success") {
        throw new Error(result.effects?.status?.error ?? "tx failed");
      }
      await sui.waitForTransaction({ digest: result.digest });
      setSave({ kind: "success", digest: result.digest });
      setEditing(false);
      onSaved();
    } catch (e) {
      setSave({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <li className="rounded-xl border border-white/10 bg-white/[0.02] backdrop-blur-md p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm text-white">{row.uen}</p>
          <p className="text-[11px] text-[var(--muted-soft)]">
            Currently getting paid in <span className="text-white font-medium">{receiveLabel(current)}</span>
          </p>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setChosen(current);
              setEditing(true);
              setSave({ kind: "idle" });
            }}
            className="glass-chip rounded-lg shrink-0"
          >
            Change
          </button>
        )}
      </div>

      {editing && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {RECEIVE_TOKEN_OPTIONS.map((opt) => {
              const selected = chosen === opt.type;
              return (
                <button
                  key={opt.type}
                  type="button"
                  onClick={() => setChosen(opt.type)}
                  disabled={save.kind !== "idle" && save.kind !== "error"}
                  className={`rounded-xl border px-3 py-2 text-left transition disabled:opacity-50 backdrop-blur-md ${
                    selected
                      ? "border-[var(--accent)] bg-[var(--accent)]/12 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_0_18px_-10px_var(--accent-glow)]"
                      : "border-white/10 bg-white/[0.03] text-[var(--muted)] hover:border-white/25"
                  }`}
                >
                  <p className="text-sm font-medium">{opt.label}</p>
                  <p className="text-[10px] text-[var(--muted-soft)] mt-0.5">{opt.description}</p>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => chosen && handleSave(chosen)}
              disabled={!chosen || chosen === current || (save.kind !== "idle" && save.kind !== "error")}
              className="glass-btn-primary text-xs py-2 px-3 disabled:opacity-50"
            >
              {save.kind === "idle" || save.kind === "error"
                ? "Save"
                : save.kind === "uploading"
                ? "Saving…"
                : save.kind === "sponsoring"
                ? "Saving…"
                : save.kind === "signing"
                ? "Saving…"
                : save.kind === "executing"
                ? "Saving…"
                : "Saved"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setSave({ kind: "idle" });
              }}
              disabled={save.kind !== "idle" && save.kind !== "error"}
              className="glass-chip rounded-lg disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          {save.kind === "error" && (
            <p className="text-[11px] text-red-300 break-words">Error: {save.message}</p>
          )}
          <p className="text-[10px] text-[var(--muted-soft)]">
            Network fees are on us — nothing to pay.
          </p>
        </div>
      )}

      {save.kind === "success" && !editing && (
        <p className="text-[11px] text-[var(--success)]">
          Saved ·{" "}
          <a
            href={txUrl(save.digest)}
            target="_blank"
            rel="noreferrer"
            className="font-mono hover:underline"
          >
            Receipt ↗
          </a>
        </p>
      )}

      {/*
        Yield-routing toggle (Phase 6). Only renders when the merchant has
        chosen USDsui as their receive token — yield-routing currently only
        supports USDsui on mainnet. On testnet, USDsui isn't in
        SUPPORTED_RECEIVE_TOKENS so this block stays dormant.
       */}
      {!editing && current === USDSUI.coinType && (
        <YieldRoutingToggle
          uen={row.uen}
          session={session}
          logoBlobId={logoBlobId}
          merchantName={merchantName}
          receiveToken={current}
          currentYieldRouting={profileQ.data?.yieldRouting ?? null}
          onSaved={onSaved}
        />
      )}
    </li>
  );
}

// ─── Yield routing toggle ───────────────────────────────────────────────

type YieldToggleState =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "sponsoring" }
  | { kind: "signing" }
  | { kind: "executing" }
  | { kind: "success"; digest: string; summary: string }
  | { kind: "error"; message: string };

interface YieldRoutingMigration {
  kind: "none" | "mint" | "redeem";
  coin_count?: number;
  total_underlying_minor?: string;
  total_share_minor?: string;
  redeemable_share_minor?: string;
  leftover_share_minor?: string;
  partial?: boolean;
  reason?: string;
  fee_underlying_minor?: string;
  cost_basis_underlying_minor?: string;
  insufficient_cost_basis?: boolean;
  fee_recipient?: string;
}

function YieldRoutingToggle(props: {
  uen: string;
  session: ZkLoginSession;
  logoBlobId: string | null;
  merchantName: string | undefined;
  receiveToken: SupportedReceiveToken;
  currentYieldRouting: YieldRouting | null;
  onSaved: () => void;
}) {
  const sui = useSuiClient();
  const [state, setState] = useState<YieldToggleState>({ kind: "idle" });
  const enabled = props.currentYieldRouting?.enabled === true;

  // Live USDsui supply APY from Scallop (via our cached server route). When
  // unavailable we fall back to a generic range rather than a wrong number.
  const apyQ = useQuery({
    queryKey: ["scallop-usdsui-apy"],
    queryFn: async () => {
      const r = await fetch("/api/scallop/apy");
      if (!r.ok) throw new Error(`apy HTTP ${r.status}`);
      return (await r.json()) as {
        supply_apy: number;
        supply_apr: number | null;
        updated_at: string | null;
      };
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const apyPct =
    apyQ.data && Number.isFinite(apyQ.data.supply_apy)
      ? (apyQ.data.supply_apy * 100).toFixed(2)
      : null;
  const inFlight =
    state.kind !== "idle" &&
    state.kind !== "error" &&
    state.kind !== "success";

  async function handleToggle() {
    const newEnabled = !enabled;
    setState({ kind: "uploading" });
    try {
      // 1. Build the new profile blob — preserve everything, flip yield_routing.
      const newBytes = buildMerchantProfileBytes({
        logoBlobId: props.logoBlobId,
        preferredReceiveToken: props.receiveToken,
        merchantName: props.merchantName,
        yieldRouting: { enabled: newEnabled, protocol: "scallop", asset: "usdsui" },
      });
      let newBlobId: string;
      try {
        const upload = await uploadBlob(newBytes);
        newBlobId = upload.blobId;
      } catch (e) {
        const why = e instanceof WalrusUploadError ? e.message : String(e);
        throw new Error(`Couldn't save your settings: ${why}`);
      }

      // 2. Sponsor builds + signs the toggle-yield tx.
      setState({ kind: "sponsoring" });
      const res = await fetch("/api/sponsor/toggle-yield", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uen: props.uen,
          owner: props.session.address,
          new_metadata_blob_id: newBlobId,
          new_yield_enabled: newEnabled,
          idempotency_key: `${props.uen}:${newEnabled ? "on" : "off"}:${Date.now()}`,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          cause?: string;
        };
        // Surface both the top-line error AND the operator-actionable
        // `cause` (e.g. "Supabase not configured on the server") so the
        // user/dev can tell why a 503 fired instead of staring at an
        // opaque "feature disabled" string.
        const base = err.error ?? `sponsor HTTP ${res.status}`;
        throw new Error(err.cause ? `${base} — ${err.cause}` : base);
      }
      const sp = (await res.json()) as {
        tx: { tx_bytes_b64: string; sponsor_signature: string };
        migration: YieldRoutingMigration;
      };

      // 3. zkLogin sign as the merchant.
      setState({ kind: "signing" });
      const txBytes = base64ToBytes(sp.tx.tx_bytes_b64);
      const senderSig = await zkLoginSign(props.session, txBytes);

      // 4. Submit dual-signed.
      setState({ kind: "executing" });
      const result = await sui.executeTransactionBlock({
        transactionBlock: txBytes,
        signature: [senderSig, sp.tx.sponsor_signature],
        options: { showEffects: true },
      });
      const status = result.effects?.status?.status;
      if (status !== "success") {
        throw new Error(result.effects?.status?.error ?? "tx failed");
      }
      await sui.waitForTransaction({ digest: result.digest });
      setState({
        kind: "success",
        digest: result.digest,
        summary: summarizeMigration(sp.migration, newEnabled),
      });
      props.onSaved();
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] backdrop-blur-md p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--accent)]">
            Earn interest
          </p>
          <p className="text-[11px] text-[var(--muted-soft)] mt-0.5 leading-relaxed">
            Turn this on and your incoming balance starts earning interest
            automatically —{" "}
            {apyPct
              ? `currently ${apyPct}% APY on USDsui`
              : apyQ.isLoading
                ? "fetching the current rate…"
                : "typically 3–7% per year"}{" "}
            via Scallop. Cash out any time, same account.
          </p>
        </div>
        <span
          className={`shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-wide ${
            enabled
              ? "bg-[var(--accent)]/15 text-[var(--accent)]"
              : "bg-white/5 text-[var(--muted-soft)]"
          }`}
        >
          {enabled ? "On" : "Off"}
        </span>
      </div>

      {/* TODO: balance split (DR2/DR3) — earning vs cash with Move buttons.
          Requires fetching live USDsui + sUSDsui balances against mainnet
          RPC. Skipped on testnet (no real balances exist) — slot in here
          when QUAY flips to mainnet. */}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={handleToggle}
          disabled={inFlight}
          className={`text-xs py-2 px-3 disabled:opacity-50 ${
            enabled ? "glass-chip rounded-lg" : "glass-btn-primary"
          }`}
        >
          {state.kind === "idle" || state.kind === "error" || state.kind === "success"
            ? enabled ? "Turn earning off" : "Turn earning on"
            : "Saving…"}
        </button>
      </div>

      {state.kind === "error" && (
        <p className="text-[11px] text-red-300 break-words">Error: {state.message}</p>
      )}
      {state.kind === "success" && (
        <div className="space-y-1">
          <p className="text-[11px] text-[var(--success)]">
            {state.summary} ·{" "}
            <a
              href={txUrl(state.digest)}
              target="_blank"
              rel="noreferrer"
              className="font-mono hover:underline"
            >
              Receipt ↗
            </a>
          </p>
        </div>
      )}
    </div>
  );
}

function summarizeMigration(
  migration: YieldRoutingMigration,
  newEnabled: boolean,
): string {
  if (migration.kind === "none") {
    return newEnabled
      ? "Earning on. Future payments will start earning interest."
      : "Earning off. Future payments will settle normally.";
  }
  if (migration.kind === "mint") {
    const amount = formatUsdsuiMinor(migration.total_underlying_minor);
    return `Earning on. Moved $${amount} into your earning balance.`;
  }
  // redeem
  const feeStr = migration.fee_underlying_minor
    ? formatUsdsuiMinor(migration.fee_underlying_minor)
    : null;
  const feeSuffix =
    feeStr && feeStr !== "0.00" ? ` (small fee of $${feeStr} deducted)` : "";
  if (migration.partial) {
    const redeemed = formatShareToUsdsui(migration.redeemable_share_minor);
    return `Earning off. Cashed out $${redeemed}${feeSuffix}. The rest stays earning — try again in a bit.`;
  }
  const total = formatShareToUsdsui(migration.total_share_minor);
  return `Earning off. Cashed out $${total}${feeSuffix}.`;
}

function formatUsdsuiMinor(minor: string | undefined): string {
  if (!minor) return "0";
  try {
    const v = Number(BigInt(minor)) / 1_000_000;
    return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return minor;
  }
}

// Approximate — without the live share price we can't be exact. Shows
// the share amount in nominal USDsui units (1:1 floor); the indexer
// supplies the exact underlying once the tx commits.
function formatShareToUsdsui(minor: string | undefined): string {
  return formatUsdsuiMinor(minor);
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
