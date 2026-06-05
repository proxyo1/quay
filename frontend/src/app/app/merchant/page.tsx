"use client";

import Link from "next/link";
import { useState } from "react";

import { isZkLoginConfigured, startGoogleZkLogin, useZkLoginSession } from "@/lib/zklogin";

export default function MerchantHome() {
  const { session, hydrated, signOut } = useZkLoginSession();
  const signedIn = hydrated && !!session;
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signInPending, setSignInPending] = useState(false);

  async function handleSignIn() {
    setSignInError(null);
    setSignInPending(true);
    try {
      // Skip the intermediate /merchant/login page entirely — kick straight
      // into Google's OAuth flow. On success the callback lands the user at
      // /merchant/post-signin, which checks their UEN registrations and
      // forwards them to /merchant/onboard (new merchant) or
      // /merchant/terminal (returning merchant).
      await startGoogleZkLogin("/merchant/post-signin");
      // startGoogleZkLogin redirects; the line below only runs if it didn't.
    } catch (e) {
      setSignInError(e instanceof Error ? e.message : String(e));
      setSignInPending(false);
    }
  }

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
          Sign in once with Google. Setup is free — Quay covers the network
          fees so you can start accepting payments right away.
        </p>
      </section>

      {signedIn && session && (
        <section className="glass-card-accent rounded-2xl p-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-[var(--accent)]/20 border border-[var(--accent)]/40 flex items-center justify-center text-[var(--accent-strong)] text-sm font-semibold shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.20)]">
              {session.email?.charAt(0).toUpperCase() ?? "M"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--muted-soft)]">Signed in</p>
              <p className="text-sm text-white truncate">{session.email}</p>
            </div>
            <button
              type="button"
              onClick={signOut}
              className="glass-chip shrink-0"
              aria-label="Sign out"
            >
              Sign out
            </button>
          </div>
        </section>
      )}

      {!signedIn ? (
        <div className="space-y-2">
          {!isZkLoginConfigured() ? (
            <div className="glass-card-warning rounded-2xl p-4 space-y-1">
              <p className="text-sm font-medium text-amber-100">
                Sign-in not configured
              </p>
              <p className="text-xs text-amber-200/80">
                The site is missing its Google OAuth + Enoki credentials.
                Ops: set <code className="font-mono">NEXT_PUBLIC_GOOGLE_CLIENT_ID</code>{" "}
                and <code className="font-mono">NEXT_PUBLIC_ENOKI_API_KEY</code> in Vercel.
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleSignIn}
              disabled={signInPending}
              className="glass-btn-primary group w-full disabled:opacity-60"
            >
              <span className="flex items-center gap-2.5">
                <GoogleIcon />
                {signInPending ? "Redirecting to Google…" : "Sign in with Google"}
              </span>
              <span className="text-white/80 group-hover:text-white transition">→</span>
            </button>
          )}
          {signInError && (
            <p className="text-xs text-red-300 break-words">{signInError}</p>
          )}
        </div>
      ) : (
        <section className="grid grid-cols-2 gap-3">
          <ActionCard
            href="/merchant/onboard"
            title="Add business"
            sub="Register your UEN"
            icon={<QrIcon />}
            accent
          />
          <ActionCard
            href="/merchant/terminal"
            title="Terminal"
            sub="See live payments"
            icon={<TerminalIcon />}
          />
          <ActionCard
            href="/merchant/wallet"
            title="Account"
            sub="Payouts & settings"
            icon={<WalletIcon />}
          />
          <ActionCard
            href="/merchant/history"
            title="History"
            sub="Past receipts"
            icon={<ClockIcon />}
          />
        </section>
      )}

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
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.836.86-3.048.86-2.344 0-4.328-1.583-5.036-3.71H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
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
