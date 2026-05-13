import Image from "next/image";
import Link from "next/link";

import { QUAY, objectUrl } from "@/lib/sui-config";

export default function Home() {
  return (
    <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-md flex-col px-5 py-8">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Image
            src="/quay.png"
            alt="quay"
            width={28}
            height={28}
            className="rounded-md"
            priority
          />
          <span className="text-base font-semibold tracking-tight">quay</span>
        </div>
        <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] uppercase tracking-wider text-neutral-400">
          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] live-dot align-middle" />
          testnet
        </span>
      </header>

      <section className="flex-1 flex flex-col justify-center space-y-8 py-10">
        <ScanMark />
        <div className="space-y-3">
          <h1 className="text-[44px] leading-[1.05] font-semibold tracking-tight">
            SGQR meets Sui.
            <br />
            <span className="text-[var(--accent)]">One scan to pay.</span>
          </h1>
          <p className="text-base text-neutral-400 leading-relaxed">
            Scan any Singapore SGQR sticker. Pay any Sui token. Settle as USDC.
          </p>
        </div>
      </section>

      <section className="space-y-2.5">
        <Link
          href="/scan"
          className="group flex items-center justify-between rounded-2xl bg-[var(--accent)] hover:bg-[var(--accent-strong)] text-white font-medium py-4 px-5 transition"
        >
          <span>Scan SGQR</span>
          <span className="text-white/70 group-hover:text-white transition">→</span>
        </Link>

        <Link
          href="/merchant"
          className="group flex items-center justify-between rounded-2xl border border-white/15 hover:border-white/30 hover:bg-white/[0.03] text-white font-medium py-4 px-5 transition"
        >
          <span>I&apos;m a merchant</span>
          <span className="text-neutral-400 group-hover:text-white transition">→</span>
        </Link>

        <Link
          href="/history"
          className="block text-center text-sm text-neutral-400 hover:text-white py-3 transition"
        >
          View payment history →
        </Link>
      </section>

      <footer className="text-[11px] text-neutral-600 pt-8 mt-4 border-t border-white/5">
        <a
          href={objectUrl(QUAY.registryId)}
          target="_blank"
          rel="noreferrer"
          className="font-mono hover:text-[var(--accent)]"
        >
          registry {QUAY.registryId.slice(0, 6)}…{QUAY.registryId.slice(-4)}
        </a>
        {" · "}
        <a
          href={objectUrl(QUAY.packageId)}
          target="_blank"
          rel="noreferrer"
          className="font-mono hover:text-[var(--accent)]"
        >
          pkg {QUAY.packageId.slice(0, 6)}…{QUAY.packageId.slice(-4)}
        </a>
        {" · "}
        {QUAY.network}
      </footer>
    </main>
  );
}

function ScanMark() {
  return (
    <div className="relative mx-auto h-28 w-28">
      {/* soft accent glow behind */}
      <div className="absolute inset-0 -z-10 rounded-full bg-[var(--accent)]/20 blur-2xl" />
      {/* corner brackets + QR mark */}
      <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden>
        <g stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" fill="none">
          <path d="M8 22 L8 8 L22 8" />
          <path d="M92 22 L92 8 L78 8" />
          <path d="M8 78 L8 92 L22 92" />
          <path d="M92 78 L92 92 L78 92" />
        </g>
        <g fill="var(--accent)">
          {/* three finder squares */}
          <rect x="28" y="28" width="14" height="14" rx="1.5" />
          <rect x="32" y="32" width="6" height="6" fill="#000" />
          <rect x="58" y="28" width="14" height="14" rx="1.5" />
          <rect x="62" y="32" width="6" height="6" fill="#000" />
          <rect x="28" y="58" width="14" height="14" rx="1.5" />
          <rect x="32" y="62" width="6" height="6" fill="#000" />
          {/* a few data modules */}
          <rect x="48" y="30" width="4" height="4" />
          <rect x="48" y="38" width="4" height="4" />
          <rect x="46" y="48" width="4" height="4" />
          <rect x="54" y="48" width="4" height="4" />
          <rect x="62" y="48" width="4" height="4" />
          <rect x="70" y="48" width="4" height="4" />
          <rect x="48" y="56" width="4" height="4" />
          <rect x="48" y="64" width="4" height="4" />
          <rect x="58" y="62" width="4" height="4" />
          <rect x="66" y="58" width="4" height="4" />
          <rect x="66" y="66" width="4" height="4" />
        </g>
      </svg>
    </div>
  );
}
