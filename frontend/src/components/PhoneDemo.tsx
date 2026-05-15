"use client";

import { useEffect, useState } from "react";

type AnnotationProps = {
  active: boolean;
  mark: string;
  title: string;
  body: string;
  data: string;
};

function Annotation({ active, mark, title, body, data }: AnnotationProps) {
  return (
    <div className={`anno ${active ? "is-active" : ""}`}>
      <div className="anno-head">
        <span className="anno-mark">{mark}</span>
        <span className="anno-bar" />
        <span className="anno-title">{title}</span>
      </div>
      <p className="anno-body">{body}</p>
      <pre className="anno-data">{data}</pre>
    </div>
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <div className="phone-stat">
      <div className="phone-stat-n">{n}</div>
      <div className="phone-stat-l mono-label">{label}</div>
    </div>
  );
}

export function PhoneDemo() {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setStage((s) => (s + 1) % 3), 2800);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="phone-section">
      <SectionMark mark="00" label="Live demo" />
      <div className="phone-grid">
        <aside className="phone-side phone-side-l">
          <Annotation
            active={stage === 0}
            mark="01"
            title="Scan"
            body="Point at any SGQR sticker. Quay finds the merchant in milliseconds."
            data={"merchant = Koufu Ang Mo Kio\namount   = S$14.20"}
          />
          <Annotation
            active={stage === 1}
            mark="02"
            title="Best rate"
            body="Real-time price. Cetus routes your token into the merchant's currency on Sui."
            data={"pay with = 2.951 SUI\nrate     = 1 SUI = 4.812 SGD"}
          />
        </aside>

        <div className="phone-wrap">
          <PhoneFrame stage={stage} />
          <div className="phone-shadow" aria-hidden />
        </div>

        <aside className="phone-side phone-side-r">
          <Annotation
            active={stage === 2}
            mark="03"
            title="Pay"
            body="One tap. Merchant gets stable. You pay no gas. Receipt saved on-chain."
            data={"paid    = S$14.20\nsettled = 1.42s\nreceipt = on-chain"}
          />
          <div className="phone-stats">
            <Stat n="1.4s" label="time to pay" />
            <Stat n="$0" label="gas fees" />
            <Stat n="0" label="chargebacks" />
          </div>
        </aside>
      </div>
    </section>
  );
}

function PhoneFrame({ stage }: { stage: number }) {
  return (
    <div className="phone">
      <div className="phone-notch" />
      <div className="phone-screen">
        <div className="screen-statusbar">
          <span>9:41</span>
          <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span className="screen-bars" />
            <span>5G</span>
            <span className="screen-batt" />
          </span>
        </div>

        <div
          className={`phone-screen-content screen-scan ${stage === 0 ? "is-on" : ""}`}
        >
          <div className="phone-screen-top">
            <span className="mono-label">SCAN SGQR</span>
            <span className="dot-pulse" />
          </div>
          <div className="scanner">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/sgqr-sample.png" alt="SGQR sticker" className="sgqr-photo" />
            <div className="scanner-corner tl" />
            <div className="scanner-corner tr" />
            <div className="scanner-corner bl" />
            <div className="scanner-corner br" />
            <div className="phone-scan-line" />
          </div>
          <div className="phone-screen-bottom">
            <p className="mono-mute" style={{ fontSize: 11, letterSpacing: "0.08em" }}>
              Point at any SGQR sticker
            </p>
          </div>
        </div>

        <div
          className={`phone-screen-content screen-quote ${stage === 1 ? "is-on" : ""}`}
        >
          <div className="phone-screen-top">
            <span className="mono-label">QUOTE</span>
            <span className="mono-label faint">koufu · #5012</span>
          </div>
          <div className="quote-amount">
            <span className="amount-currency">S$</span>
            <span className="amount-num">14.20</span>
          </div>
          <div className="quote-row">
            <span className="row-key">Pay with</span>
            <span className="row-val">2.951 SUI</span>
          </div>
          <div className="quote-row">
            <span className="row-key">Rate</span>
            <span className="row-val mono-mute">1 SUI = 4.812 SGD</span>
          </div>
          <div className="quote-row">
            <span className="row-key">Settled in</span>
            <span className="row-val">USDsui</span>
          </div>
          <button type="button" className="glass-btn-primary screen-cta">
            <span>Confirm</span>
            <span aria-hidden>→</span>
          </button>
        </div>

        <div
          className={`phone-screen-content screen-paid ${stage === 2 ? "is-on" : ""}`}
        >
          <div className="paid-check">
            <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden>
              <circle
                cx="24"
                cy="24"
                r="22"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                opacity="0.35"
              />
              <path
                d="M14 24l7 7 13-14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <p className="paid-title">Paid · S$14.20</p>
          <p className="paid-meta mono-mute">Settled in 1.42s · receipt on Sui</p>
          <div className="paid-receipt">
            <div className="quote-row">
              <span className="row-key">Merchant</span>
              <span className="row-val">Koufu Ang Mo Kio</span>
            </div>
            <div className="quote-row">
              <span className="row-key">Received</span>
              <span className="row-val">14.20 USDsui</span>
            </div>
            <div className="quote-row">
              <span className="row-key">GST</span>
              <span className="row-val mono-mute">incl. 9%</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionMark({ mark, label }: { mark: string; label: string }) {
  return (
    <div className="section-mark">
      <span className="section-mark-num">{mark}</span>
      <span className="section-mark-rule" />
      <span className="section-mark-label mono-label">{label}</span>
    </div>
  );
}
