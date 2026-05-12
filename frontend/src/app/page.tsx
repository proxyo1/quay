import Link from "next/link";

import { SUIQR, objectUrl } from "@/lib/sui-config";

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 space-y-10">
      <header className="space-y-2">
        <h1 className="text-4xl font-semibold tracking-tight">suiqr</h1>
        <p className="text-lg text-gray-600 dark:text-gray-400">
          Scan any Singapore SGQR sticker, pay any Sui token, settle as USDC.
        </p>
        <p className="text-sm text-gray-500">Sui Overflow hackathon submission · testnet only.</p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/scan"
          className="rounded-lg border border-gray-200 dark:border-gray-700 p-5 hover:border-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition"
        >
          <div className="text-base font-medium">Scan an SGQR →</div>
          <p className="text-sm text-gray-500 mt-1">
            Paste a payload, extract the UEN, look it up on-chain.
          </p>
        </Link>

        <Link
          href="/merchant"
          className="rounded-lg border border-gray-200 dark:border-gray-700 p-5 hover:border-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition"
        >
          <div className="text-base font-medium">Merchant onboarding →</div>
          <p className="text-sm text-gray-500 mt-1">
            Claim your UEN. Connect a Sui wallet today; Google zkLogin lands
            once an OAuth client is wired.
          </p>
        </Link>
      </section>

      <footer className="text-xs text-gray-500 pt-8 border-t border-gray-100 dark:border-gray-800 space-y-1">
        <p>
          Registry:{" "}
          <a
            href={objectUrl(SUIQR.registryId)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-blue-600 hover:underline"
          >
            {SUIQR.registryId.slice(0, 10)}…{SUIQR.registryId.slice(-6)}
          </a>{" "}
          on Sui {SUIQR.network}
        </p>
        <p>
          Package:{" "}
          <a
            href={objectUrl(SUIQR.packageId)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-blue-600 hover:underline"
          >
            {SUIQR.packageId.slice(0, 10)}…{SUIQR.packageId.slice(-6)}
          </a>
        </p>
      </footer>
    </main>
  );
}
