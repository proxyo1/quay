"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { isZkLoginConfigured, startGoogleZkLogin, useZkLoginSession } from "@/lib/zklogin";

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

  const { session } = useZkLoginSession();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const configured = isZkLoginConfigured();

  async function onSignIn() {
    setError(null);
    setPending(true);
    try {
      await startGoogleZkLogin(next);
      // startGoogleZkLogin redirects; the line below only runs if it didn't.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPending(false);
    }
  }

  if (session) {
    if (typeof window !== "undefined") {
      router.replace(next);
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
          One Google account = one Sui address = one merchant entry on chain.
          quay never sees your password; Google does the identity work and
          Enoki binds it to your Sui wallet with a Groth16 zk proof.
        </p>
      </header>

      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-6 space-y-4">
        {!configured ? (
          <div className="text-sm text-amber-700 dark:text-amber-300 space-y-2">
            <p className="font-medium">Google OAuth not configured</p>
            <p className="text-xs">
              Set <code className="font-mono">NEXT_PUBLIC_GOOGLE_CLIENT_ID</code>{" "}
              in <code className="font-mono">frontend/.env.local</code> and
              restart the dev server. See{" "}
              <code className="font-mono">docs/GOOGLE_OAUTH_SETUP.md</code>.
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={onSignIn}
            disabled={pending}
            className="w-full rounded-md bg-white text-gray-800 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed border border-gray-300 font-medium py-3 transition flex items-center justify-center gap-2 shadow-sm"
          >
            <GoogleMark />
            {pending ? "Redirecting to Google…" : "Sign in with Google"}
          </button>
        )}

        {error && (
          <p className="text-xs text-red-700 dark:text-red-300">{error}</p>
        )}

        <ul className="text-[11px] text-gray-500 space-y-1 pt-1">
          <li>1. Browser mints an ephemeral Ed25519 keypair</li>
          <li>2. Google issues an ID token with our ephemeral nonce</li>
          <li>3. Enoki proves the JWT + salt + ephemeral binding in zero knowledge</li>
          <li>4. The proof yields a stable addressSeed → your Sui address</li>
          <li>5. Yours forever — no private key to back up, no seed phrase</li>
        </ul>
      </section>
    </main>
  );
}

function GoogleMark() {
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
