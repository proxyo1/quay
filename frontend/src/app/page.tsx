import Link from "next/link";

export default function MarketingHome() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">
        quay<span className="text-[var(--accent)]">.</span>
      </h1>
      <p className="text-[var(--muted)]">SGQR payments on Sui.</p>
      <Link href="http://app.localhost:3000" className="glass-pill px-4 py-2 text-sm">
        Open the app →
      </Link>
    </main>
  );
}
