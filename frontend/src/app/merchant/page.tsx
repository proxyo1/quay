"use client";

import Link from "next/link";

import { useZkLoginSession } from "@/lib/zklogin";

export default function MerchantHome() {
  const { session, hydrated } = useZkLoginSession();
  const signedIn = hydrated && !!session;

  return (
    <main className="relative z-10 mx-auto w-full max-w-md px-5 py-6 space-y-6">
      <header className="flex items-center justify-between">
        <Link href="/" className="text-[var(--accent)] hover:underline text-sm inline-flex items-center gap-1">
          <span aria-hidden>←</span> home
        </Link>
        <span className="glass-pill">merchant</span>
      </header>

      <section className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">
          {signedIn ? `Welcome back` : `For merchants`}
        </h1>
        <p className="text-sm text-[var(--muted)]">
          Sign in once. Your quay wallet is derived from your identity. Quay
          pays the gas while you onboard.
        </p>
      </section>

      {signedIn && session && (
        <section className="glass-card-accent rounded-2xl p-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-[var(--accent)]/20 border border-[var(--accent)]/40 flex items-center justify-center text-[var(--accent-strong)] text-sm font-semibold shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.20)]">
              {session.email?.charAt(0).toUpperCase() ?? "M"}
            </div>
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">Signed in</p>
              <p className="text-sm text-white truncate">{session.email}</p>
              <p className="text-[11px] font-mono text-[var(--muted-soft)] truncate">
                {session.address.slice(0, 10)}…{session.address.slice(-6)}
              </p>
            </div>
          </div>
        </section>
      )}

      {!signedIn ? (
        <Link href="/merchant/login" className="glass-btn-primary group w-full">
          <span className="flex items-center gap-2.5">
            <GoogleIcon />
            Sign in with Google
          </span>
          <span className="text-white/80 group-hover:text-white transition">→</span>
        </Link>
      ) : (
        <section className="grid grid-cols-2 gap-3">
          <ActionCard
            href="/merchant/onboard"
            title="Onboard UEN"
            sub="Claim your UEN"
            icon={<QrIcon />}
            accent
          />
          <ActionCard
            href="/merchant/terminal"
            title="Terminal"
            sub="Live payment feed"
            icon={<TerminalIcon />}
          />
          <ActionCard
            href="/merchant/wallet"
            title="Wallet"
            sub="Sui address · zkLogin"
            icon={<WalletIcon />}
          />
          <ActionCard
            href="/history"
            title="History"
            sub="Past receipts"
            icon={<ClockIcon />}
          />
        </section>
      )}

      <section className="glass-card rounded-2xl p-4 space-y-2">
        <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">
          What V0 does not do yet
        </p>
        <ul className="text-xs text-[var(--muted)] space-y-1.5 leading-relaxed">
          <li className="flex gap-2">
            <span className="text-[var(--muted-soft)] shrink-0">·</span>
            Mobile-number PayNow (~70% of SG hawkers) — UEN-based only.
          </li>
          <li className="flex gap-2">
            <span className="text-[var(--muted-soft)] shrink-0">·</span>
            Manual SGQR-photo + BizFile+ review before attestation.
          </li>
          <li className="flex gap-2">
            <span className="text-[var(--muted-soft)] shrink-0">·</span>
            Production zkLogin (V0 uses Enoki proof on testnet).
          </li>
        </ul>
      </section>

      <footer className="text-[11px] text-[var(--muted-soft)] pt-4 border-t border-white/5">
        Powered by Sui · Walrus · Pyth
      </footer>
    </main>
  );
}

function ActionCard({
  href,
  title,
  sub,
  icon,
  accent,
}: {
  href: string;
  title: string;
  sub: string;
  icon: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`group rounded-2xl p-4 transition ${
        accent ? "glass-card-accent" : "glass-card hover:bg-white/[0.06]"
      }`}
    >
      <div className="relative z-10 flex items-start justify-between">
        <div
          className={`h-9 w-9 rounded-xl flex items-center justify-center border ${
            accent
              ? "bg-[var(--accent)]/25 border-[var(--accent)]/45 text-[var(--accent-strong)] shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
              : "bg-white/5 border-white/10 text-[var(--accent)] shadow-[inset_0_1px_0_rgba(255,255,255,0.10)]"
          }`}
        >
          {icon}
        </div>
        <span className="text-[var(--muted-soft)] group-hover:text-white transition">→</span>
      </div>
      <p className="relative z-10 mt-3 text-sm font-medium text-white">{title}</p>
      <p className="relative z-10 text-[11px] text-[var(--muted-soft)]">{sub}</p>
    </Link>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#ffffff"
      />
    </svg>
  );
}

function QrIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h7v3M14 21h3M21 17v4" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M7 9l3 2-3 2M13 13h4" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12V8a2 2 0 0 0-2-2H4a2 2 0 0 0 0 4h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6" />
      <path d="M18 12h.01" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
