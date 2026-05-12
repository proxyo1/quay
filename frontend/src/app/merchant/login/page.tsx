"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { useMerchantSession } from "@/lib/merchant-session";

export default function MerchantLoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next") ?? "/merchant/onboard";

  const { session, signIn } = useMerchantSession();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const googleConfigured = !!process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  function onEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      signIn(email);
      router.push(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="mx-auto max-w-md px-6 py-16 space-y-8">
      <Link href="/merchant" className="text-xs text-blue-600 hover:underline">
        ← merchant
      </Link>
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-gray-500">
          Your suiqr merchant wallet is derived from your sign-in identity.
          One identity = one Sui address = one merchant entry on chain.
        </p>
      </header>

      {session && (
        <section className="rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/30 p-4 text-sm space-y-2">
          <p className="font-medium">You&apos;re signed in.</p>
          <p className="text-xs text-gray-600 dark:text-gray-400 font-mono">
            {session.email} · {session.address.slice(0, 10)}…{session.address.slice(-6)}
          </p>
          <div className="flex gap-2 pt-1">
            <Link
              href="/merchant/onboard"
              className="text-xs px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-medium"
            >
              Onboard a UEN
            </Link>
            <Link
              href="/merchant/terminal"
              className="text-xs px-3 py-1.5 rounded border border-emerald-300 dark:border-emerald-700 hover:bg-emerald-100/50 dark:hover:bg-emerald-900/30"
            >
              Open terminal
            </Link>
          </div>
        </section>
      )}

      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-5 space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500">Recommended</p>
          <p className="text-sm font-medium mt-1">Sign in with Google (zkLogin)</p>
        </div>
        <button
          type="button"
          disabled
          title={
            googleConfigured
              ? "wiring this up next"
              : "Set NEXT_PUBLIC_GOOGLE_CLIENT_ID in frontend/.env.local — see docs/GOOGLE_OAUTH_SETUP.md"
          }
          className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-gray-100/50 dark:bg-gray-800/50 disabled:cursor-not-allowed text-gray-500 dark:text-gray-400 font-medium py-3 transition flex items-center justify-center gap-2"
        >
          <GoogleMark />
          Sign in with Google
        </button>
        <p className="text-[11px] text-gray-500">
          {googleConfigured
            ? "Mysten salt service + ZK proof flow — coming next."
            : "Needs a Google OAuth client ID. See docs/GOOGLE_OAUTH_SETUP.md."}
        </p>
      </section>

      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-5 space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500">Alternative</p>
          <p className="text-sm font-medium mt-1">Email-derived browser wallet</p>
          <p className="text-xs text-gray-500 mt-1">
            For testing: your wallet is a deterministic Sui keypair derived from
            your email + a public testnet salt. Same email = same address. You
            control the private key (export it from{" "}
            <code className="font-mono">/merchant/wallet</code>).
          </p>
        </div>

        <form onSubmit={onEmailSubmit} className="space-y-3">
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@hawker.sg"
            className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-sm"
          />
          {error && <p className="text-xs text-amber-600">{error}</p>}
          <button
            type="submit"
            className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-2.5 transition"
          >
            Sign in with email
          </button>
        </form>

        <p className="text-[11px] text-gray-500 leading-relaxed">
          This is a testnet-only convenience. The threat model assumes anyone
          who knows your email can derive your testnet wallet — fine for
          demoing, not OK for real funds. Mainnet uses Google zkLogin where
          Google controls the identity.
        </p>
      </section>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="currentColor"
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="currentColor"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.836.86-3.048.86-2.344 0-4.328-1.583-5.036-3.71H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="currentColor"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="currentColor"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}
