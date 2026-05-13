import Image from "next/image";
import Link from "next/link";

import { QUAY, objectUrl } from "@/lib/sui-config";

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 space-y-10">
      <header className="space-y-3">
        <div className="flex items-center gap-3">
          <Image
            src="/quay.png"
            alt="quay"
            width={56}
            height={56}
            className="rounded-xl"
            priority
          />
          <h1 className="text-4xl font-semibold tracking-tight">quay</h1>
        </div>
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

      <p className="text-sm text-gray-500">
        Already paid through quay?{" "}
        <Link
          href="/history"
          className="text-blue-600 hover:underline"
        >
          View your payment history →
        </Link>
      </p>

      <footer className="text-xs text-gray-500 pt-8 border-t border-gray-100 dark:border-gray-800 space-y-1">
        <p>
          Registry:{" "}
          <a
            href={objectUrl(QUAY.registryId)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-blue-600 hover:underline"
          >
            {QUAY.registryId.slice(0, 10)}…{QUAY.registryId.slice(-6)}
          </a>{" "}
          on Sui {QUAY.network}
        </p>
        <p>
          Package:{" "}
          <a
            href={objectUrl(QUAY.packageId)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-blue-600 hover:underline"
          >
            {QUAY.packageId.slice(0, 10)}…{QUAY.packageId.slice(-6)}
          </a>
        </p>
      </footer>
    </main>
  );
}
