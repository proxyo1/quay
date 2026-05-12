"use client";

import { decodeJwt } from "@mysten/sui/zklogin";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useZkLoginSession } from "@/lib/zklogin";
import { objectUrl } from "@/lib/sui-config";

export default function WalletPage() {
  const { session, hydrated, signOut } = useZkLoginSession();
  const router = useRouter();

  if (hydrated && !session) {
    if (typeof window !== "undefined") {
      router.replace("/merchant/login?next=/merchant/wallet");
    }
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <p className="text-sm text-gray-500">Redirecting to sign-in…</p>
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
    <main className="mx-auto max-w-2xl px-6 py-10 space-y-8">
      <Link href="/merchant" className="text-xs text-blue-600 hover:underline">
        ← merchant
      </Link>
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold">Wallet</h1>
        <p className="text-sm text-gray-500">
          Your suiqr merchant wallet — bound to your Google identity via Sui
          zkLogin. There&apos;s no private key to lose, no recovery phrase to
          back up. Sign back in with the same Google account from any device
          and your wallet is there.
        </p>
      </header>

      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-5 space-y-2">
        <p className="text-xs uppercase tracking-wide text-gray-500">Identity</p>
        <p className="text-sm">{session.email}</p>
        {claims && (
          <ul className="text-[11px] text-gray-500 font-mono pt-1 space-y-0.5">
            <li>iss: {claims.iss}</li>
            <li>sub: {claims.sub?.slice(0, 24)}…</li>
            <li>aud: {Array.isArray(claims.aud) ? claims.aud[0] : claims.aud}</li>
          </ul>
        )}
      </section>

      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-500">Sui address</p>
            <p className="font-mono text-sm break-all mt-1">{session.address}</p>
          </div>
          <button
            type="button"
            onClick={() => copy(session.address)}
            className="text-xs px-2.5 py-1.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Copy
          </button>
        </div>
        <p className="text-xs text-gray-500">
          View on Sui:{" "}
          <a
            href={objectUrl(session.address)}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline"
          >
            suiscan ↗
          </a>
        </p>
      </section>

      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-5 space-y-3">
        <p className="text-xs uppercase tracking-wide text-gray-500">zkLogin session</p>
        <ul className="text-[11px] text-gray-500 font-mono space-y-1">
          <li>maxEpoch: {session.maxEpoch}</li>
          <li>salt: {session.salt.slice(0, 24)}…</li>
          <li>ephemeral: bech32 stored in localStorage (rotated per session)</li>
        </ul>
        <p className="text-[11px] text-gray-500 leading-relaxed">
          The ephemeral keypair signs transaction bytes; the Mysten-prover
          proof binds those signatures to your Google identity. Once Sui
          advances past <code className="font-mono">maxEpoch</code>, sign in
          again to refresh the proof. No private key for you to back up — the
          source of truth is your Google account.
        </p>
      </section>

      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-5 space-y-3">
        <p className="text-xs uppercase tracking-wide text-gray-500">Session</p>
        <button
          type="button"
          onClick={() => {
            signOut();
            router.replace("/merchant");
          }}
          className="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          Sign out
        </button>
        <p className="text-[11px] text-gray-500">
          Signing out clears the local session. Sign in again with the same
          Google account to land on the same Sui address.
        </p>
      </section>
    </main>
  );
}
