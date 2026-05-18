"use client";

import {
  ConnectButton,
  useCurrentAccount,
  useSignPersonalMessage,
} from "@mysten/dapp-kit";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  adminAuth,
  adminChallenge,
  adminListSubmissions,
  KybClientError,
} from "@/lib/kyb/client";
import type { KybAdminListItem, KybStatus } from "@/lib/kyb/types";

const TABS: { key: KybStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved-awaiting" },
  { key: "rejected", label: "Rejected" },
  { key: "finalized", label: "Live" },
  { key: "collision", label: "Collision" },
];

type AuthState =
  | { kind: "unknown" }
  | { kind: "authed" }
  | { kind: "needs-auth" }
  | { kind: "authing" }
  | { kind: "auth-error"; message: string };

export default function AdminKybQueuePage() {
  const account = useCurrentAccount();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();

  const [tab, setTab] = useState<KybStatus>("pending");
  const [items, setItems] = useState<KybAdminListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [auth, setAuth] = useState<AuthState>({ kind: "unknown" });

  const refresh = useCallback(async () => {
    try {
      const result = await adminListSubmissions(tab);
      setItems(result);
      setListError(null);
      setAuth({ kind: "authed" });
    } catch (e) {
      if (e instanceof KybClientError && (e.status === 401 || e.status === 403)) {
        setAuth({ kind: "needs-auth" });
        setItems(null);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        setListError(msg);
      }
    }
  }, [tab]);

  useEffect(() => {
    if (auth.kind === "authed" || auth.kind === "unknown") {
      void refresh();
    }
  }, [refresh, auth.kind]);

  async function handleAuth() {
    if (!account) return;
    setAuth({ kind: "authing" });
    try {
      const { nonce, ts } = await adminChallenge();
      const message = new TextEncoder().encode(
        `QUAY_ADMIN_LOGIN_V1\nnonce=${nonce}\nts=${ts}`,
      );
      const { signature } = await signPersonalMessage({ message });
      await adminAuth(account.address, signature, nonce, ts);
      setAuth({ kind: "authed" });
      await refresh();
    } catch (e) {
      setAuth({
        kind: "auth-error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-6 py-8 text-[var(--foreground)]">
      <header className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--muted-soft)]">
            KYB admin
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Review queue</h1>
        </div>
        {account ? (
          <p className="font-mono text-xs text-[var(--muted)]">
            {account.address.slice(0, 8)}…{account.address.slice(-6)}
          </p>
        ) : null}
      </header>

      {!account ? (
        <section className="rounded-2xl border border-white/15 bg-white/[0.03] p-6 space-y-3">
          <p className="text-sm text-[var(--muted)]">
            Connect your admin wallet to view the queue.
          </p>
          <ConnectButton />
        </section>
      ) : auth.kind === "needs-auth" || auth.kind === "auth-error" ? (
        <section className="rounded-2xl border border-white/15 bg-white/[0.03] p-6 space-y-3">
          <p className="text-sm text-[var(--muted)]">
            Sign in to the admin queue with your wallet. The server checks that
            your address is in <code className="font-mono text-[var(--accent)]">ADMIN_WALLETS</code>{" "}
            and sets a 1-hour session cookie.
          </p>
          <button
            type="button"
            onClick={handleAuth}
            className="self-start rounded-full bg-[var(--accent)] px-6 py-2 text-sm font-medium text-white shadow-[0_0_16px_-2px_var(--accent-glow),inset_0_1px_0_rgba(255,255,255,0.32)]"
          >
            Sign challenge
          </button>
          {auth.kind === "auth-error" && (
            <p className="text-xs text-[var(--danger)]">{auth.message}</p>
          )}
        </section>
      ) : auth.kind === "authing" ? (
        <p className="text-sm text-[var(--muted-soft)]">Awaiting wallet signature…</p>
      ) : (
        <>
          <Tabs current={tab} onChange={(t) => setTab(t)} />
          <QueueTable items={items} loading={items === null && !listError} error={listError} />
        </>
      )}
    </main>
  );
}

function Tabs({
  current,
  onChange,
}: {
  current: KybStatus;
  onChange: (status: KybStatus) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-full border border-white/10 bg-white/[0.03] p-1">
      {TABS.map((t) => {
        const selected = current === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={`rounded-full px-4 py-1.5 text-xs uppercase tracking-[0.12em] transition ${
              selected
                ? "bg-[var(--accent)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.32)]"
                : "text-[var(--muted)] hover:text-white"
            }`}
            aria-pressed={selected}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function QueueTable({
  items,
  loading,
  error,
}: {
  items: KybAdminListItem[] | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <section className="rounded-2xl border border-white/15 bg-white/[0.03] p-6">
        <p className="text-sm text-[var(--muted-soft)]">Loading…</p>
      </section>
    );
  }
  if (error) {
    return (
      <section className="rounded-2xl border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-6">
        <p className="text-sm text-[var(--danger)]">{error}</p>
      </section>
    );
  }
  if (!items || items.length === 0) {
    return (
      <section className="rounded-2xl border border-white/15 bg-white/[0.03] p-10 text-center">
        <p className="text-sm text-[var(--muted)]">Queue clear ✓</p>
        <p className="mt-1 text-xs text-[var(--muted-soft)]">Nothing to review here.</p>
      </section>
    );
  }
  return (
    <section className="overflow-hidden rounded-2xl border border-white/15">
      <table className="w-full text-sm">
        <thead className="bg-white/[0.03] text-[10px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">
          <tr>
            <th className="px-4 py-3 text-left font-medium">UEN</th>
            <th className="px-4 py-3 text-left font-medium">Business</th>
            <th className="px-4 py-3 text-left font-medium">Wallet</th>
            <th className="px-4 py-3 text-right font-medium">Submitted</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {items.map((row) => (
            <tr key={row.id} className="bg-white/[0.01] hover:bg-white/[0.04] transition">
              <td className="px-4 py-3">
                <Link
                  href={`/admin/kyb/${row.id}`}
                  className="font-mono text-[var(--accent)] hover:underline"
                >
                  {row.uen}
                </Link>
              </td>
              <td className="px-4 py-3 text-[var(--foreground)]">
                {row.business_name ?? <span className="text-[var(--muted-soft)]">—</span>}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">
                {row.wallet_address.slice(0, 8)}…{row.wallet_address.slice(-6)}
              </td>
              <td className="px-4 py-3 text-right text-xs text-[var(--muted-soft)]">
                {relativeTime(row.submitted_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "moments ago";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
