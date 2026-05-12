"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useMerchantSession } from "@/lib/merchant-session";
import { objectUrl } from "@/lib/sui-config";

export default function WalletPage() {
  const { session, hydrated, signOut } = useMerchantSession();
  const router = useRouter();
  const [revealed, setRevealed] = useState(false);

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
          Your suiqr merchant wallet — derived from your sign-in identity and
          fully yours. Export the private key if you want to use this wallet
          in Sui Wallet, Slush, or anywhere else.
        </p>
      </header>

      <section className="rounded-md border border-gray-200 dark:border-gray-700 p-5 space-y-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500">Identity</p>
          <p className="text-sm mt-1">{session.email}</p>
          {session.kind === "email_demo" && (
            <p className="text-[11px] text-gray-500 mt-1">
              email fingerprint{" "}
              <code className="font-mono">{session.fingerprint}</code> · derived
              via blake2b256("SUIQR_MERCHANT_V1" || testnet_salt || email_lower)
            </p>
          )}
        </div>
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

      {session.kind === "email_demo" && (
        <section className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50/40 dark:bg-amber-900/10 p-5 space-y-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-amber-700 dark:text-amber-300">
              Private key
            </p>
            <p className="text-sm font-medium mt-1">
              Full access to this wallet
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
              Anyone who has the bech32 string below can sign as you. Treat it
              like a password. Testnet only.
            </p>
          </div>

          {revealed ? (
            <div className="space-y-2">
              <pre className="text-[11px] font-mono break-all whitespace-pre-wrap rounded bg-white/50 dark:bg-black/30 p-3 border border-amber-200 dark:border-amber-800">
                {session.privateKeyBech32}
              </pre>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => copy(session.privateKeyBech32)}
                  className="text-xs px-2.5 py-1.5 rounded border border-amber-300 dark:border-amber-700 hover:bg-amber-100/50"
                >
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() => setRevealed(false)}
                  className="text-xs px-2.5 py-1.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  Hide
                </button>
              </div>
              <p className="text-[11px] text-gray-500">
                To import into Sui Wallet / Slush: open the wallet, choose
                "Import private key", paste the bech32 string above.
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setRevealed(true)}
              className="w-full rounded-md bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium py-2.5 transition"
            >
              Reveal private key
            </button>
          )}
        </section>
      )}

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
          Signing out clears the local session. Same email signs you back in
          to the same wallet — the keypair is deterministic.
        </p>
      </section>
    </main>
  );
}
