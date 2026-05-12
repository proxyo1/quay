import Link from "next/link";

export default function MerchantHome() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 space-y-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">For merchants</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Claim your UEN on the suiqr registry so payers can scan your existing
          SGQR sticker and settle on Sui.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/merchant/onboard"
          className="rounded-lg border border-gray-200 dark:border-gray-700 p-5 hover:border-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition"
        >
          <div className="text-base font-medium">Onboard a UEN →</div>
          <p className="text-sm text-gray-500 mt-1">
            Connect a Sui wallet, declare your UEN, suiqr signs an attestation,
            you claim on chain.
          </p>
        </Link>

        <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-800 p-5 text-sm text-gray-400">
          <div className="font-medium">Sign in with Google (zkLogin)</div>
          <p className="mt-1">
            Coming once a Google OAuth client is configured. See{" "}
            <code className="font-mono">docs/GOOGLE_OAUTH_SETUP.md</code>.
          </p>
        </div>
      </section>

      <section className="text-xs text-gray-500 pt-6 border-t border-gray-100 dark:border-gray-800 space-y-2">
        <p className="font-medium text-gray-700 dark:text-gray-300">What V0 does NOT do:</p>
        <ul className="list-disc list-inside space-y-1">
          <li>
            Mobile-number PayNow (~70% of SG hawkers) — UEN-based PayNow only.
          </li>
          <li>
            Review SGQR-photo + BizFile+ before issuing an attestation. The V0
            demo auto-issues for any well-shaped UEN; production gates this
            behind a manual review or a NETS-controlled signer.
          </li>
          <li>
            Refund chargebacks, dispute resolution, KYC on payers, fiat
            settlement. All listed as V1+ in the design doc.
          </li>
        </ul>
      </section>
    </main>
  );
}
