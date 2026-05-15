"use client";

import { useSuiClient } from "@mysten/dapp-kit";
import { decodeJwt } from "@mysten/sui/zklogin";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { fetchMerchantProfile, getEntriesTableId } from "@/lib/quay";
import { USDSUI } from "@/lib/quay/scallop";
import { QUAY, objectUrl, txUrl } from "@/lib/sui-config";
import { uploadBlob, WalrusUploadError } from "@/lib/walrus/client";
import {
  buildMerchantProfileBytes,
  LEGACY_RECEIVE_TOKEN,
  RECEIVE_TOKEN_OPTIONS,
  type SupportedReceiveToken,
  type YieldRouting,
} from "@/lib/walrus/profileSchema";
import { useZkLoginSession, zkLoginSign, type ZkLoginSession } from "@/lib/zklogin";

function receiveLabel(token: SupportedReceiveToken): string {
  const opt = RECEIVE_TOKEN_OPTIONS.find((o) => o.type === token);
  return opt?.label ?? token;
}

export default function WalletPage() {
  const { session, hydrated, signOut } = useZkLoginSession();
  const router = useRouter();

  useEffect(() => {
    if (hydrated && !session) {
      router.replace("/merchant/login?next=/merchant/wallet");
    }
  }, [hydrated, session, router]);

  if (hydrated && !session) {
    return (
      <main className="relative z-10 mx-auto max-w-2xl px-6 py-16">
        <p className="text-sm text-[var(--muted-soft)]">Redirecting to sign-in…</p>
      </main>
    );
  }
  if (!session) return null;

  const claims = (() => {
    try {
      return decodeJwt(session.jwt) as { iss?: string; email?: string; sub?: string; aud?: string | string[] };
    } catch {
      return null;
    }
  })();

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
        <h1 className="text-3xl font-semibold tracking-tight">Wallet</h1>
        <p className="text-sm text-[var(--muted)] leading-relaxed">
          Your quay merchant wallet — bound to your Google identity via Sui
          zkLogin. There&apos;s no private key to lose, no recovery phrase to
          back up. Sign back in with the same Google account from any device
          and your wallet is there.
        </p>
      </header>

      <SettlementPreferenceSection session={session} />

      <section className="glass-card rounded-2xl p-5 space-y-2">
        <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">Identity</p>
        <p className="relative z-10 text-sm text-white">{session.email}</p>
        {claims && (
          <ul className="relative z-10 text-[11px] text-[var(--muted-soft)] font-mono pt-1 space-y-0.5">
            <li>iss: {claims.iss}</li>
            <li>sub: {claims.sub?.slice(0, 24)}…</li>
            <li>aud: {Array.isArray(claims.aud) ? claims.aud[0] : claims.aud}</li>
          </ul>
        )}
      </section>

      <section className="glass-card rounded-2xl p-5 space-y-3">
        <div className="relative z-10 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">Sui address</p>
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
          View on Sui:{" "}
          <a
            href={objectUrl(session.address)}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent)] hover:underline"
          >
            suiscan ↗
          </a>
        </p>
      </section>

      <section className="glass-card rounded-2xl p-5 space-y-3">
        <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">zkLogin session</p>
        <ul className="relative z-10 text-[11px] text-[var(--muted-soft)] font-mono space-y-1">
          <li>maxEpoch: {session.maxEpoch}</li>
          <li>addressSeed: {session.proof.addressSeed.slice(0, 24)}…</li>
          <li>ephemeral: bech32 stored in localStorage (rotated per session)</li>
        </ul>
        <p className="relative z-10 text-[11px] text-[var(--muted)] leading-relaxed">
          The ephemeral keypair signs transaction bytes; Enoki&apos;s Groth16
          proof binds those signatures to your Google identity. Once Sui
          advances past <code className="font-mono">maxEpoch</code>, sign in
          again to refresh the proof. No private key for you to back up — the
          source of truth is your Google account.
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
          Signing out clears the local session. Sign in again with the same
          Google account to land on the same Sui address.
        </p>
      </section>
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
        <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--accent)]">Settlement preference</p>
        <p className="text-[11px] text-[var(--muted-soft)] mt-0.5">
          Choose the token Quay delivers when a payer scans your SGQR. Payers
          can pay in anything — the aggregator handles the conversion.
        </p>
      </div>
      {uensQ.isLoading ? (
        <p className="relative z-10 text-xs text-[var(--muted-soft)]">Loading your registered UENs…</p>
      ) : uens.length === 0 ? (
        <p className="relative z-10 text-sm text-[var(--muted)]">
          You haven&apos;t claimed any UENs yet.{" "}
          <Link href="/merchant/onboard" className="text-[var(--accent)] hover:underline">
            Onboard one →
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
        throw new Error(`Walrus upload failed: ${why}`);
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
            Currently receiving in <span className="text-white font-medium">{receiveLabel(current)}</span>
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
                ? "Uploading profile…"
                : save.kind === "sponsoring"
                ? "Sponsor signing…"
                : save.kind === "signing"
                ? "zkLogin signing…"
                : save.kind === "executing"
                ? "Submitting…"
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
            Quay pays the testnet gas via the sponsor wallet — you don&apos;t need any SUI.
          </p>
        </div>
      )}

      {save.kind === "success" && !editing && (
        <p className="text-[11px] text-[var(--success)]">
          Saved · tx{" "}
          <a
            href={txUrl(save.digest)}
            target="_blank"
            rel="noreferrer"
            className="font-mono hover:underline"
          >
            {save.digest.slice(0, 10)}…{save.digest.slice(-6)} ↗
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
        throw new Error(`Walrus upload failed: ${why}`);
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
            Earn yield
          </p>
          <p className="text-[11px] text-[var(--muted-soft)] mt-0.5 leading-relaxed">
            Incoming USDsui auto-deposits into Scallop in the same tx the
            payer signs. Your balance earns the live supply rate (typically
            3–7% APY). One tap to cash out — same wallet, same address.
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
            : state.kind === "uploading"
              ? "Uploading profile…"
              : state.kind === "sponsoring"
                ? "Sponsor signing…"
                : state.kind === "signing"
                  ? "zkLogin signing…"
                  : "Submitting…"}
        </button>
      </div>

      {state.kind === "error" && (
        <p className="text-[11px] text-red-300 break-words">Error: {state.message}</p>
      )}
      {state.kind === "success" && (
        <div className="space-y-1">
          <p className="text-[11px] text-[var(--success)]">
            {state.summary} · tx{" "}
            <a
              href={txUrl(state.digest)}
              target="_blank"
              rel="noreferrer"
              className="font-mono hover:underline"
            >
              {state.digest.slice(0, 10)}…{state.digest.slice(-6)} ↗
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
      ? "Earning on. Future payments will route through Scallop."
      : "Earning off. Future payments settle as liquid USDsui.";
  }
  if (migration.kind === "mint") {
    const usdsui = formatUsdsuiMinor(migration.total_underlying_minor);
    return `Earning on. Migrated ${usdsui} USDsui (${migration.coin_count ?? 0} coin${
      migration.coin_count === 1 ? "" : "s"
    }) into Scallop.`;
  }
  // redeem
  const feeStr = migration.fee_underlying_minor
    ? formatUsdsuiMinor(migration.fee_underlying_minor)
    : null;
  const feeSuffix =
    feeStr && feeStr !== "0.00" ? ` (net of ${feeStr} USDsui Quay fee)` : "";
  if (migration.partial) {
    const redeemed = formatShareToUsdsui(migration.redeemable_share_minor);
    const leftover = formatShareToUsdsui(migration.leftover_share_minor);
    return `Earning off. Cashed out ${redeemed} USDsui${feeSuffix}; ${leftover} sUSDsui stays earning (pool low — try again later).`;
  }
  const shares = formatShareToUsdsui(migration.total_share_minor);
  return `Earning off. Cashed out ${shares} USDsui${feeSuffix}.`;
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
