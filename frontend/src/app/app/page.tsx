import { headers } from "next/headers";
import Link from "next/link";

import { QUAY, objectUrl } from "@/lib/sui-config";

async function marketingUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("host");
  if (!host) return "https://quay.cash";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.includes(":") ? "http" : "https");
  const hostname = host.replace(/^app\./, "");
  return `${proto}://${hostname}`;
}

export default async function Home() {
  const home = await marketingUrl();
  return (
    <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-md flex-col px-5 py-8">
      <header className="flex items-center justify-between glass-rise">
        <a href={home} className="text-base font-semibold tracking-tight" aria-label="quay">
          quay<span className="text-[var(--accent)]">.</span>
        </a>
        <span className="glass-pill">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] live-dot" />
          mainnet
        </span>
      </header>

      <section className="flex-1 flex flex-col justify-center space-y-10 py-12 glass-rise" style={{ animationDelay: "120ms" }}>
        <ScanMark />
        <div className="space-y-3">
          <h1 className="text-[44px] leading-[1.04] font-semibold tracking-tight">
            SGQR meets Sui.
            <br />
            <span className="glass-shimmer">One scan to pay.</span>
          </h1>
          <p className="text-base text-[var(--muted)] leading-relaxed">
            Scan any Singapore SGQR sticker. Pay any Sui token. Settle as USDC.
          </p>
        </div>
      </section>

      <section className="space-y-2.5 glass-rise" style={{ animationDelay: "260ms" }}>
        <Link href="/scan" className="glass-btn-primary group w-full">
          <span>Scan SGQR</span>
          <span className="text-white/80 group-hover:text-white transition">→</span>
        </Link>

        <Link href="/merchant" className="glass-btn-ghost group w-full">
          <span>I&apos;m a merchant</span>
          <span className="text-[var(--muted)] group-hover:text-white transition">→</span>
        </Link>

        <Link
          href="/history"
          className="block text-center text-sm text-[var(--muted)] hover:text-white py-3 transition"
        >
          View payment history →
        </Link>
      </section>

      <footer className="text-[11px] text-[var(--muted-soft)] pt-8 mt-4 border-t border-white/5">
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
    <div className="relative mx-auto h-36 w-36">
      {/* outer iridescent halo */}
      <div className="absolute inset-0 -z-10 rounded-full bg-[var(--accent)]/25 blur-3xl" />
      <div className="absolute -inset-4 -z-10 rounded-full bg-[radial-gradient(circle_at_30%_30%,rgba(168,85,247,0.20),transparent_60%)] blur-2xl" />
      {/* frosted glass disc holding the QR mark */}
      <div className="relative h-full w-full rounded-3xl glass-card flex items-center justify-center">
        <svg viewBox="0 0 100 100" className="h-3/4 w-3/4" aria-hidden>
          <g stroke="var(--accent-strong)" strokeWidth="3" strokeLinecap="round" fill="none">
            <path d="M8 22 L8 8 L22 8" />
            <path d="M92 22 L92 8 L78 8" />
            <path d="M8 78 L8 92 L22 92" />
            <path d="M92 78 L92 92 L78 92" />
          </g>
          <g fill="var(--accent)">
            <rect x="28" y="28" width="14" height="14" rx="1.5" />
            <rect x="32" y="32" width="6" height="6" fill="rgba(2,3,10,0.85)" />
            <rect x="58" y="28" width="14" height="14" rx="1.5" />
            <rect x="62" y="32" width="6" height="6" fill="rgba(2,3,10,0.85)" />
            <rect x="28" y="58" width="14" height="14" rx="1.5" />
            <rect x="32" y="62" width="6" height="6" fill="rgba(2,3,10,0.85)" />
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
    </div>
  );
}
