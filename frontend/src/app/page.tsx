import Link from "next/link";

import { PhoneDemo } from "@/components/PhoneDemo";

const APP_URL = "https://app.quay.cash";

export default function MarketingHome() {
  return (
    <div className="relative z-10">
      <Header />
      <main className="relative">
        <Hero />
        <PhoneDemo />
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
    <header className="landing-header">
      <div className="landing-header-blur" aria-hidden />
      <div className="landing-header-inner">
        <Link href="/" className="landing-brand">
          quay<span style={{ color: "var(--accent)" }}>.</span>
        </Link>
        <nav className="landing-nav">
          <Link href="/docs" className="landing-nav-link">
            Docs
          </Link>
          <Link href={APP_URL} className="glass-btn-primary landing-cta-sm">
            Launch dApp <span aria-hidden>→</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="landing-hero">
      <span className="glass-pill">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] live-dot" />
        Live beta · Singapore
      </span>
      <h1 className="landing-hero-h">
        Any QR. Any token.
        <br />
        <span className="glass-shimmer">One scan.</span>
      </h1>
      <p className="landing-hero-sub">
        The QR rail, on-chain. Shoppers pay in any token they hold. Merchants
        receive stable. Singapore&apos;s SGQR rail is live today — every other
        QR rail is next.
      </p>
      <div className="landing-hero-ctas">
        <Link href={APP_URL} className="glass-btn-primary">
          Launch dApp <span aria-hidden>→</span>
        </Link>
        <a href="#how" className="glass-btn-ghost">
          How it works
        </a>
      </div>
      <div className="landing-hero-meta">
        <span className="mono-label">Sui Overflow 2026</span>
      </div>
      <HeroPartners />
    </section>
  );
}

function HeroPartners() {
  const items = [
    { name: "Sui", src: "/partners/sui.svg", kind: "mark" as const },
    { name: "Pyth", src: "/partners/pyth.svg", kind: "mark" as const },
    { name: "Cetus", src: "/partners/cetus.png", kind: "raster" as const },
    { name: "Walrus", src: "/partners/walrus.svg", kind: "wordmark" as const },
    { name: "Scallop", src: "/partners/scallop.png", kind: "raster" as const },
  ];
  return (
    <div className="hero-partners" aria-label="Built on">
      <span className="mono-label faint hero-partners-label">Built on</span>
      <ul className="hero-partners-list">
        {items.map((p) => (
          <li key={p.name} className={`hero-partner hero-partner-${p.kind}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.src} alt={p.name} className="hero-partner-logo" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Steps() {
  const items = [
    {
      mark: "01",
      title: "Scan",
      lede: "Read any SGQR. Resolve the merchant on-chain. Quote it with Pyth.",
      detail:
        "Quay parses EMVCo-MPM QR data — SGQR today, with DuitNow, QRIS, UPI and PIX coming next. The merchant UEN resolves to an on-chain record. Pyth streams SUI/SGD in under 400ms.",
      fixture: [
        "qr        = SGQR (EMVCo-MPM)",
        "uen       = 5012345678X",
        "merchant  = Koufu Ang Mo Kio",
        "amount    = S$14.20",
        "price     = 1 SUI = 4.812 SGD  (Pyth)",
      ].join("\n"),
    },
    {
      mark: "02",
      title: "Route",
      lede: "Pick any token. Cetus finds the best path across Sui liquidity.",
      detail:
        "Every swap routes through Cetus, which aggregates across Sui DEXs. Slippage is capped at your ceiling and the Pyth confidence interval guards the quote against stale or wide pricing.",
      fixture: [
        "pay with  = 2.951 SUI",
        "via       = SUI → USDsui",
        "routed by = Cetus",
        "max slip  = 0.30%",
        "guard     = Pyth conf < 0.30%",
      ].join("\n"),
    },
    {
      mark: "03",
      title: "Settle",
      lede: "One PTB. Atomic swap and transfer. On-chain receipt.",
      detail:
        "Both legs happen in a single Programmable Transaction Block — either the merchant gets paid in full or the whole transaction reverts. zkLogin sponsors gas; the receipt lives on Walrus, GST-ready for tax.",
      fixture: [
        "tx        = PTB · 0x9c2a…f01ad",
        "sent      = 14.20 USDsui",
        "recipient = Koufu Ang Mo Kio",
        "gas       = sponsored (zkLogin)",
        "finality  = 1.42s",
      ].join("\n"),
    },
  ];

  return (
    <section id="how" className="steps-section">
      <SectionMark mark="01" label="How it works" />
      <h2 className="section-h">
        Scan. Route. Settle.
        <br />
        <span className="section-h-mute">A single on-chain transaction.</span>
      </h2>
      <div className="steps-grid">
        {items.map((it) => (
          <article key={it.mark} className="step glass-card">
            <header className="step-head">
              <span className="step-mark">{it.mark}</span>
              <h3 className="step-title">{it.title}</h3>
            </header>
            <p className="step-lede">{it.lede}</p>
            <p className="step-detail">{it.detail}</p>
            <pre className="step-fixture">{it.fixture}</pre>
          </article>
        ))}
      </div>
    </section>
  );
}

function TwoSided() {
  return (
    <section className="twosided-section">
      <SectionMark mark="03" label="Two sides, one rail" />
      <h2 className="section-h">
        Pay in any token.
        <br />
        <span className="section-h-mute">Settle in stable.</span>
      </h2>

      <div className="twosided-grid">
        <article className="side glass-card">
          <header className="side-head">
            <span className="mono-label" style={{ color: "var(--accent)" }}>
              For shoppers
            </span>
            <span className="side-num">01</span>
          </header>
          <h3 className="side-title">Spend what you already hold.</h3>
          <dl className="spec">
            <Spec k="Tokens" v="Any liquid Sui asset" />
            <Spec k="Off-ramp" v="None. Pay direct." />
            <Spec k="Custody" v="Non-custodial throughout" />
            <Spec k="Tax" v="One event, not two" />
            <Spec k="KYC" v="Not required" />
          </dl>
        </article>

        <article className="side glass-card">
          <header className="side-head">
            <span className="mono-label" style={{ color: "var(--accent)" }}>
              For merchants
            </span>
            <span className="side-num">02</span>
          </header>
          <h3 className="side-title">Receive stable. Custody yourself.</h3>
          <dl className="spec">
            <Spec k="Settlement" v="USDsui · switchable" />
            <Spec k="Yield" v="Idle USDsui earns automatically" />
            <Spec k="Onboard" v="90s via Google · zkLogin" />
            <Spec k="PCI" v="N/A — non-custodial" />
            <Spec k="Chargebacks" v="Impossible at settlement" />
            <Spec k="Receipts" v="On-chain · GST-ready" />
          </dl>
        </article>
      </div>
    </section>
  );
}

function Spec({ k, v }: { k: string; v: string }) {
  return (
    <div className="spec-row">
      <dt className="spec-k mono-label">{k}</dt>
      <dd className="spec-v">{v}</dd>
    </div>
  );
}

function Outro() {
  return (
    <section className="outro-section">
      <div className="outro-glow" aria-hidden />
      <SectionMark mark="04" label="Roadmap" centered />
      <h2 className="outro-h">
        Live in Singapore.
        <br />
        <span style={{ color: "var(--accent)" }}>Always shipping.</span>
      </h2>
      <Roadmap />
      <div className="outro-cta">
        <Link href={APP_URL} className="glass-btn-primary">
          Launch dApp <span aria-hidden>→</span>
        </Link>
        <Link href="/docs" className="glass-btn-ghost">
          Read the docs
        </Link>
      </div>
    </section>
  );
}

type MilestoneState = "live" | "now" | "planned";
type Milestone = { num: string; name: string; state: MilestoneState };

function Roadmap() {
  const milestones: Milestone[] = [
    { num: "01", name: "SGQR pay-in", state: "live" },
    { num: "02", name: "Merchant yield", state: "live" },
    { num: "03", name: "UEN verification", state: "now" },
    { num: "04", name: "Fiat off-ramp", state: "planned" },
    { num: "05", name: "Switchable settlement", state: "planned" },
    { num: "06", name: "Regional expansion", state: "planned" },
  ];
  const total = milestones.length;
  // The accent "completed" fill on the track extends to the last live OR now stop.
  const activeIndex = milestones
    .map((m) => m.state === "live" || m.state === "now")
    .lastIndexOf(true);
  const style = {
    ["--roadmap-total" as string]: total,
    ["--roadmap-live" as string]: activeIndex >= 0 ? activeIndex + 0.5 : 0,
  } as React.CSSProperties;
  return (
    <div className="roadmap" aria-label="Quay product roadmap" style={style}>
      <div className="roadmap-track" aria-hidden />
      <div className="roadmap-track-fill" aria-hidden />
      {milestones.map((m) => (
        <div key={m.num} className={`roadmap-stop is-${m.state}`}>
          <span className="roadmap-tag mono-label">
            {m.state === "live" ? "Live" : m.state === "now" ? "Now" : "Soon"}
          </span>
          <span className="roadmap-dot" />
          <span className="roadmap-name">{m.name}</span>
        </div>
      ))}
    </div>
  );
}

function Footer() {
  return (
    <footer className="landing-footer">
      <div className="landing-footer-rule" />
      <div className="landing-footer-row">
        <div className="landing-footer-brand">
          <span className="landing-brand">
            quay<span style={{ color: "var(--accent)" }}>.</span>
          </span>
          <span className="mono-label faint">The QR rail, on-chain</span>
        </div>
        <div className="landing-footer-cols">
          <div>
            <span className="mono-label faint">Product</span>
            <Link href={APP_URL}>App</Link>
            <Link href="/docs">Docs</Link>
            <a href="#how">How it works</a>
          </div>
        </div>
      </div>
      <div className="landing-footer-bottom">
        <span className="mono-label faint">© quay · 2026</span>
        <span className="mono-label faint">Sui Overflow 2026</span>
      </div>
    </footer>
  );
}

function SectionMark({
  mark,
  label,
  centered,
}: {
  mark: string;
  label: string;
  centered?: boolean;
}) {
  return (
    <div className={`section-mark ${centered ? "is-center" : ""}`}>
      <span className="section-mark-num">{mark}</span>
      <span className="section-mark-rule" />
      <span className="section-mark-label mono-label">{label}</span>
    </div>
  );
}

