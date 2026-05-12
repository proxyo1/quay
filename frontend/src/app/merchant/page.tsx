"use client";

import Link from "next/link";

import { useMerchantSession } from "@/lib/merchant-session";

export default function MerchantHome() {
  const { session, hydrated } = useMerchantSession();
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 space-y-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">For merchants</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Sign in once. Your suiqr wallet is derived from your identity — same
          email, same Sui address, same merchant entry on chain. Suiqr pays
          the gas while you onboard.
        </p>
      </header>

      {hydrated && session && (
        <section className="rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10 p-4 text-sm">
          <p className="font-medium">Signed in</p>
          <p className="text-xs text-gray-600 dark:text-gray-400 font-mono mt-1">
            {session.email} · {session.address.slice(0, 10)}…{session.address.slice(-6)}
          </p>
        </section>
      )}

      <section className="grid gap-4 sm:grid-cols-2">
        {!session ? (
          <Link
            href="/merchant/login"
            className="rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50/40 dark:bg-emerald-900/10 p-5 hover:border-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition sm:col-span-2"
          >
            <div className="text-base font-medium">Sign in →</div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Google zkLogin (recommended; needs OAuth client) or email-derived
              browser wallet (testnet only).
            </p>
          </Link>
        ) : (
          <>
            <Link
              href="/merchant/onboard"
              className="rounded-lg border border-gray-200 dark:border-gray-700 p-5 hover:border-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition"
            >
              <div className="text-base font-medium">Onboard a UEN →</div>
              <p className="text-sm text-gray-500 mt-1">
                Declare a Singapore UEN. Sponsored gas means no SUI needed.
              </p>
            </Link>

            <Link
              href="/merchant/terminal"
              className="rounded-lg border border-gray-200 dark:border-gray-700 p-5 hover:border-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition"
            >
              <div className="text-base font-medium">Terminal →</div>
              <p className="text-sm text-gray-500 mt-1">
                Live PaymentReceipt feed for your wallet. SGD-prominent, ~2s
                after on-chain finality.
              </p>
            </Link>

            <Link
              href="/merchant/wallet"
              className="rounded-lg border border-gray-200 dark:border-gray-700 p-5 hover:border-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition sm:col-span-2"
            >
              <div className="text-base font-medium">Wallet & backup →</div>
              <p className="text-sm text-gray-500 mt-1">
                Your Sui address, private key, and how to import into Sui
                Wallet / Slush if you want to use it elsewhere.
              </p>
            </Link>
          </>
        )}
      </section>

      <section className="text-xs text-gray-500 pt-6 border-t border-gray-100 dark:border-gray-800 space-y-2">
        <p className="font-medium text-gray-700 dark:text-gray-300">What V0 does NOT do:</p>
        <ul className="list-disc list-inside space-y-1">
          <li>Mobile-number PayNow (~70% of SG hawkers) — UEN-based only.</li>
          <li>
            Review SGQR-photo + BizFile+ before issuing an attestation. V0
            auto-issues; production gates this behind manual review or a
            NETS-controlled signer.
          </li>
          <li>
            Real Google zkLogin yet. The login page wires email-derived
            wallets today; zkLogin lands when an OAuth client is configured
            (see <code className="font-mono">docs/GOOGLE_OAUTH_SETUP.md</code>).
          </li>
        </ul>
      </section>
    </main>
  );
}
