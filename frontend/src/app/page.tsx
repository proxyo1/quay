import Link from "next/link";

const APP_URL = "https://app.quay.cash";

export default function MarketingHome() {
  return (
    <div className="relative z-10 flex min-h-screen flex-col">
      <Header />

      <main className="flex flex-col gap-32 pb-32">
        <Hero />
        <VideoPlaceholder />
        <Steps />
        <TwoSided />
        <Outro />
      </main>

      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-20 w-full">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[180%] backdrop-blur-md"
        style={{
          WebkitMaskImage:
            "linear-gradient(to bottom, black 20%, transparent 100%)",
          maskImage:
            "linear-gradient(to bottom, black 20%, transparent 100%)",
        }}
      />
      <div className="relative mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          quay<span className="text-[var(--accent)]">.</span>
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href="/docs"
            className="glass-btn-ghost rounded-full px-4 py-2 text-sm font-medium"
          >
            Documentation
          </Link>
          <Link
            href={APP_URL}
            className="glass-btn-primary rounded-full px-5 py-2 text-sm font-medium"
          >
            Launch dApp
          </Link>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col items-center px-6 pt-20 text-center glass-rise">
      <span className="glass-pill mb-8">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] live-dot" />
        Live beta · Singapore
      </span>
      <h1 className="text-[clamp(44px,8vw,96px)] font-semibold leading-[1.02] tracking-tight">
        Any QR. Any token.
        <br />
        <span className="glass-shimmer">One scan.</span>
      </h1>
      <p className="mt-8 max-w-2xl text-lg leading-relaxed text-[var(--muted)] sm:text-xl">
        The QR rail, on-chain. Shoppers pay in any token they hold. Merchants
        receive stable. Singapore's SGQR rail is live today — every other QR
        rail is next.
      </p>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <Link
          href={APP_URL}
          className="glass-btn-primary rounded-full px-6 py-3 text-sm font-medium"
        >
          Launch dApp →
        </Link>
        <a
          href="#how-it-works"
          className="glass-btn-ghost rounded-full px-6 py-3 text-sm font-medium"
        >
          How it works
        </a>
      </div>
      <p className="mt-8 text-xs uppercase tracking-[0.18em] text-[var(--muted-soft)]">
        Proudly participating in{" "}
        <span className="text-[var(--accent)]">Sui Overflow 2026</span>
      </p>
    </section>
  );
}

function VideoPlaceholder() {
  return (
    <section className="mx-auto w-full max-w-5xl px-6">
      <div className="glass-card relative aspect-video w-full overflow-hidden rounded-2xl">
        {/* TODO: replace with <video> or embed when demo is ready */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full border border-white/15 bg-white/[0.04] backdrop-blur-md">
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="ml-1 h-6 w-6 fill-[var(--accent)]"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
          <p className="text-sm uppercase tracking-[0.18em] text-[var(--muted-soft)]">
            Product video — coming soon
          </p>
        </div>
      </div>
    </section>
  );
}

function Steps() {
  const steps = [
    {
      n: "01",
      title: "Scan",
      body: "Parse the EMVCo payload. Look up the UEN on chain. Live Pyth quote.",
    },
    {
      n: "02",
      title: "Route",
      body: "Pick any token in your wallet. Cetus Aggregator finds the route across every Sui DEX.",
    },
    {
      n: "03",
      title: "Settle",
      body: "Atomic swap and transfer in one transaction. On-chain receipt, audit-ready.",
    },
  ];
  return (
    <section id="how-it-works" className="mx-auto w-full max-w-6xl px-6">
      <div className="mb-12 text-center">
        <p className="mb-3 text-sm uppercase tracking-[0.18em] text-[var(--accent)]">
          How it works
        </p>
        <h2 className="text-[clamp(32px,5vw,56px)] font-semibold leading-tight tracking-tight">
          Scan. Route. Settle.
        </h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {steps.map((s) => (
          <div
            key={s.n}
            className="glass-card flex flex-col gap-3 rounded-2xl p-6"
          >
            <span className="font-mono text-xs text-[var(--muted-soft)]">
              {s.n}
            </span>
            <h3 className="text-xl font-semibold tracking-tight">{s.title}</h3>
            <p className="text-sm leading-relaxed text-[var(--muted)]">
              {s.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function TwoSided() {
  return (
    <section className="mx-auto w-full max-w-6xl px-6">
      <div className="mb-12 text-center">
        <h2 className="text-[clamp(32px,5vw,56px)] font-semibold leading-tight tracking-tight">
          Crypto-native at the till.
          <br />
          <span className="text-[var(--muted)]">Fiat-stable in the books.</span>
        </h2>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="glass-card flex flex-col gap-4 rounded-2xl p-7">
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--accent)]">
            For shoppers
          </p>
          <h3 className="text-2xl font-semibold tracking-tight">
            Spend what you already hold.
          </h3>
          <ul className="space-y-2 text-sm text-[var(--muted)]">
            <li>— Pay in any liquid Sui token.</li>
            <li>— No off-ramp. No KYC. No card.</li>
            <li>— One tax event, not two.</li>
            <li>— Non-custodial throughout.</li>
          </ul>
        </div>
        <div className="glass-card flex flex-col gap-4 rounded-2xl p-7">
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--accent)]">
            For merchants
          </p>
          <h3 className="text-2xl font-semibold tracking-tight">
            Receive stable. Custody yourself.
          </h3>
          <ul className="space-y-2 text-sm text-[var(--muted)]">
            <li>— Settle in USDsui. Switch any time.</li>
            <li>— Onboard in 90 seconds with Google.</li>
            <li>— No PCI. No chargebacks. No acquirer.</li>
            <li>— On-chain receipts, GST-ready.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function Outro() {
  return (
    <section className="mx-auto w-full max-w-4xl px-6 text-center">
      <h2 className="text-[clamp(28px,4.5vw,48px)] font-semibold leading-tight tracking-tight">
        SGQR today.
        <br />
        <span className="text-[var(--accent)]">Any QR rail tomorrow.</span>
      </h2>
      <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-[var(--muted)]">
        DuitNow, QRIS, UPI, PIX — if a business prints a QR, Quay can wire it.
      </p>
      <div className="mt-10">
        <Link
          href={APP_URL}
          className="glass-btn-primary rounded-full px-6 py-3 text-sm font-medium"
        >
          Launch dApp →
        </Link>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-8 text-xs text-[var(--muted-soft)]">
      <span>© quay</span>
      <span>Sui Overflow 2026</span>
    </footer>
  );
}
