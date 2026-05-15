import Link from "next/link";

const APP_URL = "http://app.localhost:3000";

export const metadata = {
  title: "Docs — Quay",
  description:
    "How Quay turns the SGQR rail into an on-chain payment terminal. Architecture, flows, security, and merchant onboarding.",
};

export default function DocsPage() {
  return (
    <div className="relative z-10 flex min-h-screen flex-col">
      <Header />

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-24 px-6 pb-32 pt-12 md:flex-row md:gap-16">
        <Sidebar />
        <article className="flex w-full min-w-0 flex-col gap-20">
          <Intro />
          <Section id="overview" eyebrow="01" title="What Quay is">
            <p>
              Quay is a payment terminal that turns Singapore&apos;s SGQR rail
              into an on-chain checkout. A shopper scans the merchant&apos;s
              existing SGQR sticker, picks any token in their wallet, and the
              merchant receives a stablecoin. The QR doesn&apos;t change. The
              merchant&apos;s books don&apos;t change. Only the rail behind it
              does.
            </p>
            <p>
              We are not a wallet. We are not a DEX. We are the thin layer that
              makes an existing QR work for crypto-native shoppers and pays out
              in something a Singapore SME accountant will accept.
            </p>
            <Callout>
              <strong>One-line:</strong> Slush is a wallet. Quay is a payment
              terminal. Merchants want SGD in their books, USDsui in their
              treasury, and a receipt their accountant accepts.
            </Callout>
          </Section>

          <Section id="how-it-works" eyebrow="02" title="How a payment works">
            <p>
              Every Quay transaction is three steps, atomic in a single Sui
              programmable transaction block.
            </p>
            <Steps
              steps={[
                {
                  n: "Scan",
                  body: "Parse the EMVCo TLV payload from the SGQR. Extract the merchant UEN, amount (if present), and currency. Look up the UEN's on-chain merchant record to resolve the payout address and preferred settlement token.",
                },
                {
                  n: "Quote",
                  body: "Fetch a live SGD price from Pyth. Ask Cetus Aggregator for the best route across every Sui DEX from the shopper's chosen input token to the merchant's settlement token. Show net amount, slippage, and gas before the shopper signs.",
                },
                {
                  n: "Settle",
                  body: "One PTB: swap input → settlement token via the aggregator route, transfer to merchant, emit an on-chain receipt event. If the swap or transfer fails, the whole transaction reverts. The shopper either pays exactly the agreed amount or pays nothing.",
                },
              ]}
            />
            <p className="text-sm text-[var(--muted-soft)]">
              The merchant&apos;s phone polls for the receipt event and shows a
              confirmation. Median end-to-end latency on mainnet is currently
              under three seconds from sign to confirmation.
            </p>
          </Section>

          <Section
            id="shoppers"
            eyebrow="03"
            title="For shoppers"
            kicker="Pay with what you already hold."
          >
            <ul className="docs-list">
              <li>
                <strong>Any liquid Sui token.</strong> SUI, USDsui, DEEP,
                CETUS, and anything Cetus Aggregator can route through.
              </li>
              <li>
                <strong>No off-ramp.</strong> Skip the
                exchange-withdraw-bank-card loop. Pay the merchant directly.
              </li>
              <li>
                <strong>No card, no KYC at the till.</strong> You sign with
                your wallet. The merchant sees a receipt, not a card number.
              </li>
              <li>
                <strong>Non-custodial throughout.</strong> Quay never holds
                your funds. The swap and the transfer happen in one
                transaction signed by you.
              </li>
              <li>
                <strong>One tax event.</strong> Disposing of crypto to pay a
                merchant is a single taxable event in most jurisdictions, not
                the two-step off-ramp-then-pay most users do today.
              </li>
            </ul>
          </Section>

          <Section
            id="merchants"
            eyebrow="04"
            title="For merchants"
            kicker="Stablecoin in. Own custody. Books unchanged."
          >
            <ul className="docs-list">
              <li>
                <strong>Settle in USDsui by default.</strong> Switch settlement
                token any time from the merchant dashboard.
              </li>
              <li>
                <strong>90-second onboarding.</strong> Sign in with Google via
                Enoki zkLogin. No seed phrase, no app install, no hardware.
              </li>
              <li>
                <strong>No PCI scope.</strong> You never touch a card number.
                No acquirer, no chargebacks, no monthly terminal rental.
              </li>
              <li>
                <strong>Sponsored gas.</strong> Payer-side gas is sponsored so
                shoppers don&apos;t need SUI to pay you.
              </li>
              <li>
                <strong>Idle-balance yield.</strong> Optional: route idle USDsui
                balances into a vetted Sui yield strategy from the merchant
                dashboard. Toggle off any time.
              </li>
              <li>
                <strong>GST-ready receipts.</strong> Every transaction emits
                an on-chain event with UEN, SGD-equivalent at Pyth quote
                time, token settled, and tx digest. Export to CSV for your
                accountant.
              </li>
            </ul>
            <div className="mt-6">
              <Link
                href={`${APP_URL}/merchant`}
                className="glass-btn-primary rounded-full px-6 py-3 text-sm font-medium"
              >
                Open merchant dashboard →
              </Link>
            </div>
          </Section>

          <Section id="architecture" eyebrow="05" title="Architecture">
            <p>
              Quay sits on three primitives. Each is replaceable; none is
              custom-built where a battle-tested option exists.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <ArchCard
                name="Sui"
                role="Settlement"
                body="Programmable transaction blocks let us bundle swap, transfer, and receipt into one atomic call. Sub-second finality."
              />
              <ArchCard
                name="Cetus Aggregator"
                role="Routing"
                body="Routes the shopper's input token to the merchant's settlement token across every Sui DEX. We don't run a DEX or hold inventory."
              />
              <ArchCard
                name="Pyth"
                role="Oracle"
                body="Live SGD price feed for quoting the QR's fiat amount in tokens. Same feed merchants see — no spread games."
              />
              <ArchCard
                name="Enoki zkLogin"
                role="Auth"
                body="Google sign-in produces a Sui account without a seed phrase. Merchants onboard in under two minutes."
              />
              <ArchCard
                name="EMVCo / SGQR"
                role="QR rail"
                body="The merchant's existing PayNow / SGQR sticker. We parse the TLV payload — the sticker doesn't change."
              />
              <ArchCard
                name="Supabase"
                role="Indexing"
                body="Off-chain merchant directory, receipt indexer, and dashboard reads. All financial state of record is on-chain."
              />
            </div>
          </Section>

          <Section id="security" eyebrow="06" title="Security model">
            <ul className="docs-list">
              <li>
                <strong>Non-custodial.</strong> Quay&apos;s contracts cannot
                hold shopper or merchant funds. The settle PTB transfers the
                output of the swap straight to the merchant in the same call.
              </li>
              <li>
                <strong>Atomic-or-revert.</strong> Swap and transfer share a
                transaction. A failed route or insufficient liquidity reverts
                the whole call — the shopper&apos;s tokens stay where they
                were.
              </li>
              <li>
                <strong>Quoted amount is signed.</strong> The shopper signs the
                exact SGD-equivalent and minimum-out. Front-running or quote
                drift can&apos;t silently change what they pay.
              </li>
              <li>
                <strong>Merchant directory is on-chain.</strong> The UEN →
                payout-address mapping is a Sui object the merchant controls.
                Quay can&apos;t redirect funds.
              </li>
              <li>
                <strong>zkLogin keys.</strong> Merchant accounts are zkLogin
                addresses. Recovery is via the underlying OAuth provider; Quay
                never sees a private key.
              </li>
            </ul>
          </Section>

          <Section id="receipts" eyebrow="07" title="Receipts &amp; accounting">
            <p>
              Every settled payment emits a <code>PaymentReceipt</code> event
              with these fields:
            </p>
            <pre className="docs-pre">
{`{
  merchant_uen: "53123456A",
  payer:        "0x...",
  merchant:     "0x...",
  input_token:  "0x2::sui::SUI",
  input_amount: "1234567890",
  settled_token:"...::usdsui::USDSUI",
  settled_amount:"9_870_000",
  sgd_quote:    "13.42",
  pyth_price_id:"0x...",
  tx_digest:    "...",
  ts_ms:        1731628800000
}`}
            </pre>
            <p>
              The merchant dashboard reads these events and renders a daily
              ledger with SGD totals at quote time, settled-token totals, and
              tx digests for audit. CSV export is one click.
            </p>
          </Section>

          <Section id="roadmap" eyebrow="08" title="What&rsquo;s next">
            <ul className="docs-list">
              <li>
                <strong>DuitNow (MY), QRIS (ID), UPI (IN), PIX (BR).</strong>{" "}
                Same EMVCo-style payload, different country issuer. Each is a
                directory + parser, not a rewrite.
              </li>
              <li>
                <strong>Apple ID and more OAuth providers</strong> for shopper
                accounts who&apos;d rather not install a wallet at all.
              </li>
              <li>
                <strong>Merchant payout schedules</strong> — auto-sweep into
                a treasury wallet, an off-ramp partner, or a yield strategy.
              </li>
              <li>
                <strong>Refunds.</strong> Merchant-signed reverse PTB against
                the original receipt event.
              </li>
            </ul>
          </Section>

          <Section id="faq" eyebrow="09" title="FAQ">
            <FAQ
              q="Do shoppers need SUI for gas?"
              a="No. Gas is sponsored by Quay on the payer side. The shopper signs the PTB; we pay the SUI."
            />
            <FAQ
              q="What if the swap fails or there isn't enough liquidity?"
              a="The whole transaction reverts. The shopper's tokens never leave their wallet. They see an error and can try a different input token."
            />
            <FAQ
              q="What if the SGD price moves between quote and signature?"
              a="The shopper signs a minimum-out denominated in the merchant's settlement token. If realised settlement would fall below that, the PTB reverts."
            />
            <FAQ
              q="Can a merchant change their settlement token?"
              a="Yes, from the merchant dashboard. The change is an on-chain update to their merchant record and applies to the next payment."
            />
            <FAQ
              q="Is this regulated payment service activity in Singapore?"
              a="Quay is non-custodial — funds move directly from shopper to merchant in a single transaction. We're working through the regulatory picture with counsel and will publish more as that solidifies. Nothing on this page is legal advice."
            />
            <FAQ
              q="Does the merchant need to change their QR sticker?"
              a="No. The same SGQR sticker works. Quay reads the standard EMVCo payload."
            />
          </Section>

          <Outro />
        </article>
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
      <div className="relative mx-auto flex w-full max-w-6xl items-center px-6 py-5">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          quay<span className="text-[var(--accent)]">.</span>
        </Link>
      </div>
    </header>
  );
}

function Sidebar() {
  const items = [
    ["overview", "Overview"],
    ["how-it-works", "How it works"],
    ["shoppers", "For shoppers"],
    ["merchants", "For merchants"],
    ["architecture", "Architecture"],
    ["security", "Security model"],
    ["receipts", "Receipts"],
    ["roadmap", "What's next"],
    ["faq", "FAQ"],
  ];
  return (
    <aside className="md:sticky md:top-24 md:h-fit md:w-56 md:shrink-0">
      <p className="mb-3 text-xs uppercase tracking-[0.18em] text-[var(--muted-soft)]">
        Contents
      </p>
      <nav className="flex flex-col gap-1">
        {items.map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            className="rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] hover:bg-white/[0.04] hover:text-[var(--accent-strong)]"
          >
            {label}
          </a>
        ))}
      </nav>
    </aside>
  );
}

function Intro() {
  return (
    <section className="glass-rise">
      <span className="glass-pill mb-6">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] live-dot" />
        Docs · v0
      </span>
      <h1 className="text-[clamp(36px,6vw,68px)] font-semibold leading-[1.05] tracking-tight">
        The QR rail,
        <br />
        <span className="glass-shimmer">on chain.</span>
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-relaxed text-[var(--muted)]">
        Quay turns a merchant&apos;s existing SGQR sticker into an on-chain
        payment terminal. Shoppers pay in any liquid Sui token; merchants
        settle in a stablecoin they can give to their accountant. This page is
        the technical and product overview.
      </p>
    </section>
  );
}

function Section({
  id,
  eyebrow,
  title,
  kicker,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  kicker?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <p className="mb-3 font-mono text-xs text-[var(--muted-soft)]">
        {eyebrow}
      </p>
      <h2 className="text-[clamp(28px,4vw,44px)] font-semibold leading-tight tracking-tight">
        {title}
      </h2>
      {kicker ? (
        <p className="mt-3 text-base text-[var(--muted)]">{kicker}</p>
      ) : null}
      <div className="docs-prose mt-6 flex flex-col gap-4 text-[var(--muted)]">
        {children}
      </div>
    </section>
  );
}

function Steps({
  steps,
}: {
  steps: { n: string; body: string }[];
}) {
  return (
    <ol className="grid gap-4 sm:grid-cols-3">
      {steps.map((s, i) => (
        <li
          key={s.n}
          className="glass-card flex flex-col gap-3 rounded-2xl p-6"
        >
          <span className="font-mono text-xs text-[var(--muted-soft)]">
            {String(i + 1).padStart(2, "0")}
          </span>
          <h3 className="text-lg font-semibold tracking-tight text-[var(--foreground,white)]">
            {s.n}
          </h3>
          <p className="text-sm leading-relaxed text-[var(--muted)]">
            {s.body}
          </p>
        </li>
      ))}
    </ol>
  );
}

function ArchCard({
  name,
  role,
  body,
}: {
  name: string;
  role: string;
  body: string;
}) {
  return (
    <div className="glass-card flex flex-col gap-2 rounded-2xl p-5">
      <p className="text-xs uppercase tracking-[0.16em] text-[var(--accent)]">
        {role}
      </p>
      <h3 className="text-base font-semibold tracking-tight">{name}</h3>
      <p className="text-sm leading-relaxed text-[var(--muted)]">{body}</p>
    </div>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="glass-card-accent rounded-2xl p-5 text-sm leading-relaxed text-[var(--muted)]">
      {children}
    </div>
  );
}

function FAQ({ q, a }: { q: string; a: string }) {
  return (
    <details className="glass-card group rounded-2xl p-5 open:bg-white/[0.03]">
      <summary className="flex cursor-pointer items-center justify-between gap-4 text-base font-medium tracking-tight text-white/90 marker:hidden [&::-webkit-details-marker]:hidden">
        <span>{q}</span>
        <span className="text-[var(--accent)] transition group-open:rotate-45">
          +
        </span>
      </summary>
      <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">{a}</p>
    </details>
  );
}

function Outro() {
  return (
    <section className="mt-12 text-center">
      <h2 className="text-[clamp(24px,3.5vw,38px)] font-semibold leading-tight tracking-tight">
        Ready to try it?
      </h2>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[var(--muted)]">
        Launch the dApp on mainnet, scan any SGQR sticker, and settle in
        seconds.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link
          href={APP_URL}
          className="glass-btn-primary rounded-full px-6 py-3 text-sm font-medium"
        >
          Launch dApp →
        </Link>
        <Link
          href={`${APP_URL}/merchant`}
          className="glass-btn-ghost rounded-full px-6 py-3 text-sm font-medium"
        >
          Merchant dashboard
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
