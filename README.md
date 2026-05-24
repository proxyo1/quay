# quay

**SGQR-compatible Sui payments — pay in any token, receive in any token.**

Scan any Singapore SGQR sticker. Pay with whatever you hold in your Sui wallet. The merchant receives in the token they picked at onboarding (USDsui by default, plus SUI and future stables). Routing happens atomically in one signature via Cetus Aggregator. The merchant onboards with Google zkLogin — no wallet to install, no SUI to buy first — and Quay's sponsor wallet covers the gas. Every payment emits an on-chain `PaymentReceipt` event with the SGD-equivalent amount and the full Pyth quote that produced it, so the audit trail is replayable.

> **Live on Sui mainnet** (deployed 2026-05-15). Originally a Sui Overflow hackathon submission; now on mainnet, with the testnet artifacts archived (`scripts/deploy-testnet.v{1..4}.json`).

```
┌──────────┐  scan SGQR  ┌──────────────────────────┐   pay  ┌─────────────┐
│  Payer   │ ──────────▶ │  /scan: parse SGQR, look │ ─────▶ │  Merchant   │
│ (wallet) │             │  up merchant, fetch quote│        │  on-chain   │
└──────────┘             │  build PTB (direct OR    │        └─────────────┘
                         │  aggregator swap)        │
                         └──────────┬───────────────┘
                                    │
                                    ▼  payments::pay<MerchantPreferredToken>
                           ┌──────────────────────┐
                           │  MerchantRegistry    │  emits PaymentReceipt
                           │  (shared object)     │  ──────────────────────┐
                           └──────────────────────┘                        │
                                                                           ▼
                                                              ┌────────────────────┐
                                                              │ /merchant/terminal │
                                                              │ live SGD feed +    │
                                                              │ received-token row │
                                                              └────────────────────┘
```

(All authed routes resolve under the `/app` namespace — `/app/scan`, `/app/merchant/terminal`, etc. The diagram uses short names for readability.)

---

## Why this exists

PayNow is free for Singapore merchants and 99% of payers use it. quay isn't trying to replace PayNow for the SGD-only mainstream. It targets the **crypto-native 1%** and the merchants who want to serve them:

- **Payer side**: pay in whatever token your wallet holds. No exchange off-ramp, no exchange KYC, no per-asset cash-out cycle, no card network. One transaction, one tax event, on-chain receipt with the SGD-equivalent.
- **Merchant side**: receive in the token you actually want (USDsui for stable revenue, SUI for native exposure). No Coinhako/StraitsX solvency risk. No PCI compliance. Fees are aggregator spread (<0.1%), well below Visa MDR (2-3%). Lower chargeback risk too — Sui address refunds are deterministic.

**The strategic wedge**: a protocol that takes Singapore's existing SGQR sticker infrastructure and gives it a Sui-native settlement layer. The same code forks cleanly to Malaysia (DuitNow), India (UPI), Indonesia (QRIS), Brazil (PIX) — most of the work is a parser change and a domain-tag swap.

---

## What works today

### Payer surface

| Surface | Status |
|---|---|
| `/app/scan` — paste or camera-scan an SGQR | ✅ end-to-end |
| Live Pyth quote (USD/SGD + SUI/USD) with stale detection | ✅ |
| Dynamic source-token picker showing every coin in the wallet | ✅ |
| Pre-signature trust receipt ("you pay up to X · merchant gets Y · route") | ✅ |
| Direct-transfer fast path when payer and merchant tokens match | ✅ — no aggregator fee |
| Aggregator-routed swap-and-pay (Cetus Aggregator + `partner` referral) | ✅ live on mainnet |
| On-chain `PaymentReceipt` with SGD minor units + Pyth quote metadata | ✅ |
| Walrus-stored receipt blob with hash anchored on chain (direct path) | ✅ |
| `/app/history` — payer-side receipt history for the connected wallet | ✅ |
| `/app/verify/[blobId]` — verify a Walrus receipt blob against the on-chain event | ✅ |
| `/app/m/[uen]` — public merchant page resolved from a UEN | ✅ |

### Merchant surface

| Surface | Status |
|---|---|
| `/app/merchant/login` — Google zkLogin (Enoki prover) | ✅ |
| `/app/merchant/onboard` — claim a UEN, pick receive token, upload logo, attach KYB proof (Bizfile/letterhead, encrypted in-browser) | ✅ sponsored gas + admin review |
| `/app/merchant/onboard/pending` — submission status, polls every 30s, "Complete registration" once approved | ✅ |
| `/app/merchant/wallet` — view identity, **change settlement preference any time** | ✅ sponsored gas |
| `/app/merchant/wallet` — **withdraw USDsui to any address** (non-custodial) | ✅ gasless for the full balance (`0x2::coin::send_funds`); sponsored gas for partial amounts |
| `/app/merchant/wallet` — **opt into Scallop USDsui yield** on idle balances | ✅ sponsored toggle; payments auto-route into the yield position |
| `/app/merchant/wallet` — **cash out USDsui → SGD** via PayNow | ⚠️ manual Wise demo (personal Wise within hackathon scope), custodial-by-treasury, `cashout_enabled`-gated, `WISE_ENV=sandbox` by default. Real non-custodial leg is V2 (see SECURITY.md + TODOS) |
| `/app/merchant/terminal` — live PaymentReceipt feed, SGD-prominent + received-token formatted | ✅ 2s refresh |
| `/app/merchant/history` — incoming-payment history keyed off the zkLogin session | ✅ |
| Multi-UEN ownership (one wallet, many sticker locations) | ✅ |

### Infrastructure

| Surface | Status |
|---|---|
| `quay::payments` Move module (Move 2024) | ✅ live on mainnet (Move source = V4) |
| `MerchantRegistry` shared object | ✅ |
| `/api/attest` — issuer ed25519 attestations (server-only key) | ✅ |
| `/api/kyb/submit` — encrypted KYB doc upload + pending row insert | ✅ |
| `/api/kyb/status` — polling-token-gated status check (no wallet enumeration) | ✅ |
| `/api/kyb/finalize` — post-approval: build evidence_content (JCS), sign attestation, return sponsored tx (5/day per address) | ✅ |
| `/api/admin/*` — wallet-signed admin queue: `challenge`, `auth`, `kyb/list`, `kyb/[id]`, `kyb/[id]/decide` | ✅ |
| `/app/admin/setup` — one-time wallet → X25519 pubkey derivation for `ADMIN_KYB_PUBKEY` | ✅ |
| `/app/admin/kyb` — admin review queue, in-browser decryption via wallet-signature-derived key | ✅ |
| `/api/sponsor/update-metadata` — sponsored settlement-token changes (10/day) | ✅ |
| `/api/sponsor/withdraw` — sponsored partial USDsui withdrawals | ✅ |
| `/api/sponsor/toggle-yield` + `/api/sponsor/earn-move` — sponsored Scallop yield opt-in/out | ✅ |
| `/api/cashout/{quote,initiate,confirm}` — custodial Wise PayNow demo (gated) | ⚠️ demo only |
| `/api/receipts` — receipt lookup for history/verify surfaces | ✅ |
| `/api/cron/scallop-monitor` (weekly) + `/api/cron/scallop-cost-basis-indexer` (daily) | ✅ Vercel cron |
| Walrus integration for logo + receipt + encrypted KYB blobs | ✅ |

---

## How it works (product walkthrough)

### 1. Merchant onboarding (two phases, ~2 minutes of merchant time + admin review)

**Phase 1 — Submit (merchant, ~2 minutes):**

1. Sign in at `/app/merchant/login` with Google → Enoki returns a Groth16 zk-proof binding the Google identity to a deterministic Sui address.
2. Scan their SGQR sticker (or type UEN manually).
3. Optionally upload a logo and business name.
4. Pick **how they want to receive payments**: USDsui (default) or SUI.
5. **Attach a proof of business ownership** (Bizfile from ACRA, or business letterhead): PDF / PNG / JPEG / WebP, ≤ 5 MB. The browser generates a per-doc AES-256-GCM key, encrypts the doc, wraps the key with the admin's X25519 pubkey via NaCl `crypto_box_seal`, and uploads the ciphertext to Walrus. Plaintext bytes never leave the browser.
6. Tap "Submit for review" → row inserted in `kyb_submissions` with `status='pending'`, polling-token JWT returned, merchant redirected to `/app/merchant/onboard/pending` (polls every 30s).

**Phase 2 — Admin review (~1 business day target):**

7. Admin connects their mnemonic-backed Sui wallet at `/app/admin/kyb`, signs a challenge → 1h HttpOnly cookie set.
8. Click a pending row → wallet pops up to sign `"QUAY_KYB_DECRYPT_KEY_V1"` (deterministic ed25519 → HKDF-SHA256 + RFC 7748 clamp → X25519 priv key, in browser memory only). Ciphertext fetched from Walrus, decrypted, doc rendered inline (PDF iframe / image zoom).
9. Admin clicks **Approve** (or Reject with reason). Row flips to `status='approved'`.

**Phase 3 — Finalize (merchant, 1 signature):**

10. Merchant's pending page polls, sees status flip to "Approved", clicks **Complete registration**.
11. Server builds canonical `evidence_content` JSON (JCS, RFC 8785) binding UEN + business_name + `kyb_doc_hash_hex` + `kyb_doc_blob_id` + timestamps + claimer address, hashes it to `evidence_hash`, issuer signs an ed25519 attestation, sponsor co-signs gas, returns sponsored tx bytes.
12. Merchant signs as sender via zkLogin, `register_merchant` lands on chain with `evidence_hash` committing to the KYB doc.

Total wallet balance required: **zero SUI**. The chain commits a 32-byte hash that anyone can verify against the Walrus blob — KYB proof becomes tamper-evident without leaking the document.

### 2. Settlement-preference change (any time after onboarding)

Open `/app/merchant/wallet`, scroll to *Settlement preference*, tap *Change* on the UEN, pick the new token, tap *Save*. Behind the scenes: re-upload the v1 profile blob (preserving logo + name), sponsor co-signs gas, zkLogin signs `update_merchant_metadata`, the on-chain pointer flips. Next scan→pay delivers in the new token.

Total wallet balance required: **zero SUI** (sponsor pays, 10/day per address).

### 3. Payer flow (~15 seconds, 1 signature)

1. Scan an SGQR sticker at `/app/scan` (or paste the UEN).
2. quay looks up the merchant on chain, fetches their preferred receive token from their Walrus profile.
3. Enter the SGD amount → Pyth gives a live USD/SGD + SUI/USD quote.
4. Pick a source token from the wallet (every coin with a balance shows up; the merchant's preferred token is tagged *direct* = no routing fee).
5. Pre-signature trust receipt shows: *"you pay up to X · merchant receives Y · routed via Cetus Aggregator (≤1% slippage)"* OR *"direct transfer (no routing fee)"*.
6. Tap pay → one signature → `payments::pay<MerchantPreferredToken>` lands → terminal feed updates within 2 seconds. If the merchant has yield enabled, the payment routes into their Scallop USDsui position in the same PTB.

---

## Architecture

### Move module — `quay::payments`

Single shared `MerchantRegistry`, `Coin<T>`-generic `pay` and `refund` so the same contract supports SUI, USDsui, future stables, future swap outputs. ed25519-attested `register_merchant` with replay-nonce protection. AdminCap-gated issuer rotation. ~517 LOC including the metadata-update primitive.

See [`move/quay/sources/payments.move`](move/quay/sources/payments.move) for the full module and [`move/quay/tests/payments_tests.move`](move/quay/tests/payments_tests.move) for the 24 unit tests.

**Move API:**

| Function | Purpose | Key abort codes |
|---|---|---|
| `init(ctx)` | One-time at publish — creates shared `MerchantRegistry`, transfers `AdminCap` to publisher | |
| `set_initial_issuer_pubkey(registry, pubkey, chain_id, ctx)` | Admin sets the issuer ed25519 pubkey + chain_id once after publish | `E_NOT_ADMIN`, `E_ISSUER_ALREADY_SET` |
| `rotate_issuer_pubkey(cap, registry, new_pubkey, clock)` | AdminCap holder rotates the issuer key | |
| `register_merchant(registry, uen, nonce, attestation, expires_at_ms, metadata_uri, evidence_hash, clock, ctx)` | Merchant claims a UEN with an issuer-signed `ClaimMessage` | `E_UEN_ALREADY_CLAIMED`, `E_NONCE_REPLAYED`, `E_ATTESTATION_EXPIRED`, `E_INVALID_ATTESTATION` |
| `pay<T>(registry, uen, coin, memo, sgd_minor_units, quote_metadata, clock, ctx)` | Pay a registered merchant in `Coin<T>`, emits `PaymentReceipt` | `E_UEN_NOT_REGISTERED`, `E_PAYMENT_BELOW_MIN` |
| `refund<T>(receipt_id, payer, coin, clock, ctx)` | Merchant refunds `Coin<T>` to payer, emits `RefundIssued` | `E_REFUND_AMOUNT_ZERO` |
| `update_merchant_address(registry, uen, new_address, clock, ctx)` | Merchant rotates their payout address | `E_NOT_MERCHANT_OWNER` |
| `update_merchant_metadata(registry, uen, new_metadata_uri, clock, ctx)` | Merchant changes settlement preference (or logo) | `E_NOT_MERCHANT_OWNER` |
| `is_registered(registry, uen)` view | `bool` — used by `/app/scan` |
| `merchant_address(registry, uen)` view | Resolved payout address |
| `chain_id(registry)` / `issuer_pubkey(registry)` views | Registry state |

### DEX integration — Cetus Aggregator

Cross-token swap-and-pay routes through Cetus Aggregator ([`frontend/src/lib/dex/aggregator.ts`](frontend/src/lib/dex/aggregator.ts)). The aggregator falls through DeepBook v3, Cetus CLMM, KriyaDEX, FlowX, Turbos, and every other Sui DEX automatically, picks the best route, returns a `Coin<T>` that flows straight into `payments::pay<T>`. Quay's treasury passes as the `partner` parameter on every routed swap, so Cetus splits a slice of its swap fee back — that's the V0 revenue model with **zero capital deployed**.

Same-token payments bypass the aggregator entirely via direct transfer — no routing fee, no slippage exposure. Decision happens in [`buildPayAnyTokenPtb`](frontend/src/lib/quay/pay.ts).

`Coin<T>`-generic `payments::pay<T>` means the Move contract doesn't care which path the PTB took, only that a coin of the merchant's preferred type lands on the call. **No on-chain change between V0 and any future routing decision.**

### Yield routing — Scallop

Merchants can opt idle USDsui into a Scallop lending position from `/app/merchant/wallet` (sponsored toggle via `/api/sponsor/toggle-yield` + `/api/sponsor/earn-move`). When enabled, the pay PTB mints the settled `Coin<USDsui>` into Scallop and the merchant holds the wrapped sCoin instead — `payments::pay<T>` stays type-generic, so this is a frontend/PTB change, not a Move change. Cost basis is tracked off-chain by two Vercel crons (`scallop-cost-basis-indexer` daily, `scallop-monitor` weekly). See [`frontend/src/lib/quay/scallop.ts`](frontend/src/lib/quay/scallop.ts).

### Off-chain services

- **Issuer**: ed25519 keypair held by Quay-the-company in `.secrets/issuer-testnet.json` (gitignored). The key is network-agnostic — the same pubkey is committed on both testnet and mainnet, and the registry's `chain_id` (1 on mainnet, never reused) is what prevents cross-network attestation replay. Signs `ClaimMessage` attestations server-side via `/api/attest`. Production path: air-gapped hardware key → 2-of-3 multisig → NETS-controlled signer / BizFile+ federation. Rotation is a single `rotate_issuer_pubkey` call, no redeploy.
- **Sponsor**: separate ed25519 keypair that covers gas for onboarding, settlement-preference updates, partial withdrawals, and yield toggles. Rate-limited per address (5 onboardings/day, 10 metadata-updates/day). Refuses to sign if its own balance falls below 20% of the funding target.
- **Treasury** (`.secrets/treasury-mainnet.json`): used **only** by the cash-out demo — the one custodial path in the app. Briefly holds USDsui between the on-chain transfer and the Wise PayNow SGD payout. Off by default behind `cashout_enabled` + `WISE_ENV=sandbox`.
- **Walrus**: stores merchant profile JSON (logo blob ID + preferred receive token + name), full payment receipts, **and encrypted KYB documents** (AES-256-GCM ciphertext, plaintext never touches the server). Operator audit log records the `(evidence_hash, walrus_blob_id)` mapping in Supabase so the issuer-signed evidence is recoverable.
- **KYB admin (`ADMIN_WALLETS`, `ADMIN_KYB_PUBKEY`, `ADMIN_JWT_SECRET`)**: mnemonic-backed Sui wallet whose ed25519 signature over `"QUAY_KYB_DECRYPT_KEY_V1"` deterministically derives the X25519 decryption key. The private key is **never stored** — re-derived in the admin's browser each session. Loss of the wallet seed = inability to decrypt pending docs. See [`SECURITY.md`](SECURITY.md) for the full threat model.

### Frontend — Next.js 16 + React 19 + Tailwind 4

The authed app surface lives under the `/app` namespace (`app.quay.cash`). Library code is organized by domain:

- `frontend/src/lib/quay/` — pay + register + lookup + indexer + Walrus profile fetch + Scallop yield + transfer (withdraw)
- `frontend/src/lib/dex/` — Cetus Aggregator wrapper, user balances hook, partner config
- `frontend/src/lib/walrus/` — publisher + aggregator client, v1 profile schema
- `frontend/src/lib/pyth/` — Hermes client, USD/SGD inversion, SUI/USD pull
- `frontend/src/lib/sgqr/` — EMVCo MPM parser + builder + CRC16 + quote-metadata codec
- `frontend/src/lib/zklogin/` — Enoki session, sign helpers
- `frontend/src/lib/server/` — server-only issuer, sponsor, treasury, Wise, cashout-store

---

## The novel insight: UEN as registry key

The SGQR spec embeds the merchant's **PayNow proxy** (UEN string, mobile number, or VPA) inside EMVCo Tag 26's sub-tag 02 — alongside a sub-tag 01 that says which proxy type it is (`0` mobile, `2` UEN, `5` VPA). The UEN is the merchant's existing public, ACRA-controlled identifier.

Treating that UEN as the on-chain registry key means:

- **Zero new identifiers.** Merchants don't get a new "quay ID"; they use what they already have on the back of their SGQR sticker.
- **The existing sticker keeps working.** Any SGQR scanner (banks, NETS, TouchNGo) ignores fields it doesn't understand; quay is opt-in.
- **Domain-tag namespacing** (`blake2b256("PAYNOW_UEN_V1" || uen)`) leaves room for `PAYNOW_MOBILE_V1` and `PAYNOW_VPA_V1` without collision. The on-chain key derivation is forward-compatible by construction.

The on-chain `PaymentReceipt` event carries `sgd_minor_units` (the SGD-equivalent the payer agreed to) plus `quote_metadata` (Pyth feed IDs, prices, publish timestamps, DEX routing breadcrumb). Any auditor can replay the rate. The `quote_metadata` field has a hard 2 KB cap enforced client-side to keep event emission costs sane.

---

## Why not just off-ramp?

This is the question every Singaporean asks: *"PayNow + Coinhako/StraitsX/Crypto.com Card already work — what's quay for?"*

**Honest answer**: PayNow works for 99% of SG users. quay targets the **crypto-native 1%** and the merchants who want to serve them.

**Payer-side differentiators:**
- Non-custodial throughout. No exchange holds your tokens.
- No exchange KYC at point of sale. Your Sui wallet stays pseudonymous.
- One tax event per payment. Off-ramp + spend = two events to track.
- Multi-token at point of sale. Pay in whatever you hold; aggregator routes.
- On-chain receipt with SGD equivalent + replayable Pyth quote.

**Merchant-side differentiators** (UEN is public, ACRA-registered — merchants are not anonymous):
- Lower fees vs Visa MDR. Aggregator spread <0.1% vs 2-3% MDR + 1-2% chargeback risk.
- Self-custody of received tokens. No Coinhako solvency risk.
- Structured on-chain receipts queryable for GST reporting.
- Multi-token receive (USDsui for stability, SUI for crypto exposure) — flip any time via `/app/merchant/wallet`.
- Optional Scallop yield on idle balances without leaving self-custody.
- Avoided PCI compliance + customer-data-breach liability.
- Brand positioning for crypto-friendly cafes, co-working spaces, Web3 events.

**Where this doesn't compete**: PayNow is free for receivers, and Quay can't beat free for SGD-only flows. The real customer base is the 50-500 crypto-friendly merchants in SG who already informally accept crypto.

**Reframe**: *protocol* (forkable to DuitNow / UPI / QRIS / PIX) vs *product* (Singapore wedge). The protocol is the durable thing; the SG deployment is the first product instance.

---

## Deploy walkthrough

Production runs on **mainnet** (IDs below). The walkthrough below targets **testnet** — the safe path for local dev and forks; switch the active network in `frontend/src/lib/sui-config.ts` (`SUI_NETWORK`) plus the matching deploy artifact.

```bash
# 1. Toolchain
brew install sui pnpm
sui client new-env --alias testnet --rpc https://fullnode.testnet.sui.io:443
sui client switch --env testnet
sui client new-address ed25519 dev
# fund via https://faucet.sui.io/?address=<your dev address>

# 2. Move build + test
cd move/quay
sui move build
sui move test                # 24/24 pass

# 3. Deploy + initialize + register a demo merchant
cd ../../scripts
bun install
bun run day2-deploy.ts       # publishes, sets issuer pubkey, registers merchant1
bun run day7-create-sponsor.ts  # sponsor wallet + funding
bun run day11-stage-demo.ts  # 3 demo merchants for the dress rehearsal

# 4. Aggregator smoke (verifies Cetus Aggregator integration)
bun run day13-cetus-aggregator-smoke.ts

# 5. Frontend
cd ../frontend
pnpm install
bun test src/lib             # 234/234 pass
pnpm dev                     # http://localhost:3000

# 6. Browser walk-through
# /app/scan              → scan an SGQR sticker, or "try demo" with a registered UEN
# /app/merchant/login    → "Sign in with Google" (zkLogin via Enoki)
# /app/merchant/onboard  → claim a UEN, pick receive token, sponsored gas
# /app/merchant/wallet   → change settlement preference, withdraw, opt into yield
# /app/merchant/terminal → live PaymentReceipt feed for your zkLogin-derived address
```

Full step-by-step demo flow: [`docs/DRESS_REHEARSAL.md`](docs/DRESS_REHEARSAL.md).

---

## Event subscription (TypeScript snippet)

```ts
import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";

const sui = new SuiClient({ network: "mainnet", url: getJsonRpcFullnodeUrl("mainnet") });
const PKG = "0xdf4f409344e5e90cb284a9b62b52504817afbecb432dce59cb1bbf08f69296dd";
const merchant = "0x..."; // your address

setInterval(async () => {
  const res = await sui.queryEvents({
    query: { MoveEventType: `${PKG}::payments::PaymentReceipt` },
    order: "descending",
    limit: 50,
  });
  for (const ev of res.data) {
    const p = ev.parsedJson as { merchant: string; payer: string; amount: string; sgd_minor_units: string };
    if (p.merchant === merchant) {
      console.log(`+ $${(Number(p.sgd_minor_units) / 100).toFixed(2)} SGD from ${p.payer}`);
    }
  }
}, 2000);
```

---

## Deployment

### Mainnet (live)

```
Network:          mainnet (chain_id = 1)
Deployed:         2026-05-15
Package:          0xdf4f409344e5e90cb284a9b62b52504817afbecb432dce59cb1bbf08f69296dd
MerchantRegistry: 0x50e3d1a6520b052ee06636808715a336b3d0c9a7cf3e5a7632031629939ddbf1
AdminCap:         0xa5c389b37aa21a5d9e033dd76a083319de43f8b8b7147f140050cc3162027e7e
UpgradeCap:       0xdb6cdc4b396391e8eecde81c94bb36f655439138d64fefe44f240d300268d67d
Admin address:    0xa91644aa47914b16b73258c1de984e3296ef15e40a838ffd3b8fa533b27def2f
Issuer pubkey:    0x5d44735e96af7d30d245936458efc03f5fdc4ba042046848afc4ad9dd8d115c8
Settlement token: USDsui (0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI)
```

- Publish: [`Gm74skA…ZmT2b`](https://suiscan.xyz/mainnet/tx/Gm74skAEfL5mocQ2q8TWWSmP7MbcvJVyt9Ui7nFZmT2b)

Canonical artifact: [`scripts/deploy-mainnet.json`](scripts/deploy-mainnet.json). `frontend/src/lib/sui-config.ts` mirrors these IDs and is the single source of truth for the active build.

### Testnet (archived)

The testnet deployment (`chain_id = 4c78adac`, package `0x69297daea3fb456381cc60684d5b9055fff58c7e13f9848943590e62a4ff55eb`) reached V4 before mainnet launch. Prior releases are archived as [`scripts/deploy-testnet.v1.json`](scripts/deploy-testnet.v1.json), [`v2.json`](scripts/deploy-testnet.v2.json), [`v3.json`](scripts/deploy-testnet.v3.json), and the V4 block in [`scripts/deploy-testnet.json`](scripts/deploy-testnet.json). Restore the matching block and set `SUI_NETWORK = "testnet"` to switch back.

---

## Fork this for your country

The quay codebase is structured so a non-SG implementation is mostly a parser change and a domain-tag swap:

1. **Rename**: `quay::payments` → `<country>qr::payments`. Module structure stays the same.
2. **Update the EMVCo MAI parser** ([`frontend/src/lib/sgqr/parser.ts`](frontend/src/lib/sgqr/parser.ts)): already finds the local payment scheme by GUID match across tags `02..51`. Change the GUID to `MY.PAYNET`, `IN.UPI`, `BR.GOV.BCB.PIX`, etc.
3. **Update the domain tag**: `blake2b256("PAYNOW_UEN_V1" || ...)` → `blake2b256("PAYNET_NRBC_V1" || ...)` for Malaysia, etc. Structure stays the same.
4. **Update the price oracle**: Pyth `FX.USD/MYR`, `FX.USD/INR`, `FX.USD/BRL` — the Pyth catalog covers every major fiat pair.
5. **Update the identifier validator**: Malaysia uses NRBC, India uses UPI handles. `looksLikeUen` becomes `looksLikeNrbc`.
6. **Deploy fresh** with the same `sui move build && publish` flow.

Each country adds ~200 LOC of frontend parser changes. The on-chain code is essentially country-agnostic.

---

## Tokens: USDsui settlement, any-token source

The default merchant payout token is **USDsui** (Bridge/Stripe's Sui-native stablecoin). Payers can *source* the payment from any token in their wallet — the aggregator swaps to the merchant's preferred type on the way into `payments::pay<T>`.

USDC remains a relevant *source* token, and Sui has two of them:

- **Wormhole-bridged USDC** (`0xa1ec7fc…::usdc::USDC` on testnet) — used in local dev; bridged from Ethereum Circle USDC.
- **Circle CCTP-native USDC** — Circle's first-party Sui issuance, live on mainnet, with full aggregator coverage.

Because the contract is `Coin<T>`-generic, changing the settled or accepted tokens is a frontend constants change in `frontend/src/lib/quay/pay.ts` — no Move redeploy. The testnet aggregator gap (no Quay-USDC ↔ SUI route, because Cetus's testnet subgraph doesn't index the bridged stable) is a dev-only artifact; mainnet has full coverage.

---

## Issuer key storage policy

The issuer key is held by Quay-the-company in `.secrets/issuer-testnet.json` (gitignored). It is network-agnostic — the same pubkey is committed on testnet and mainnet, and the registry's `chain_id` prevents cross-network replay. For production:

- **Now (mainnet V0)**: single ops-held key, manual signing per merchant approval. Mitigated by AdminCap rotation; not the end state.
- **V1**: `2-of-3` multisig (or `m-of-n` with on-chain verification) via `rotate_issuer_pubkey`. AdminCap held by a separate multisig.
- **V2**: replace centralized issuance with a NETS-controlled signer (NETS already operates SGQR), or self-attestation via BizFile+ federation where the merchant proves UEN ownership cryptographically.

The on-chain primitive supports all three without redeploy — only the issuer key holder changes.

---

## Roadmap

| | Status | Notes |
|---|---|---|
| **Mainnet deployment** | ✅ Shipped | Live since 2026-05-15. IDs above; canonical artifact `scripts/deploy-mainnet.json`. |
| **Gasless stablecoin transfers** | ✅ partial (withdraw) | Live on mainnet (v125, 2026-05-20), USDsui allowlisted. Withdraw-everything ships gasless via [`0x2::coin::send_funds`](https://docs.sui.io/develop/transaction-payment/gasless-stablecoin-transfers) (zero fee, no SUI). Remaining: a no-receipt gasless quick-pay. `payments::pay<T>` stays sponsored+receipted — a custom event disqualifies gasless. |
| **Scallop USDsui yield** | ✅ shipped | Sponsored opt-in from the wallet; payments auto-route into the yield position. Cost basis tracked by Vercel crons. |
| **Licensed non-custodial cash-out leg** | 📋 V2 | Replace the personal-Wise demo with a licensed PayNow settlement leg (StraitsX) or Bridge/Stripe issuer redemption; delete the custodial demo. |
| **LP-mode inventory market-making** | 📋 V0.5 | Aggregator referral covers V0 revenue with $0 capital. Inventory mode adds spread capture once volume justifies $10k–$50k seed. |
| **Mobile-number PayNow** (proxy type `0`) | 📋 V0.5 | ~70% of SG hawkers use mobile-number PayNow rather than UEN. Domain-tag namespacing (`PAYNOW_MOBILE_V1`) is already designed in; needs frontend parser + a new attestation flow. |
| **SuiNS optional name attach** | 📋 V0.5 | Address truncation works for V0; SuiNS lookup adds a human-readable label in the terminal feed. |
| **DeepBook rate-lock** (post-only limit orders for B2B) | 🤔 If demand | Cetus Aggregator's `minOut` already protects retail slippage. Rate-lock only makes sense for high-value SGD payments where precision matters. Revisit if Quay serves B2B. |
| **NETS-controlled issuer signer** | 📋 V1 | Replace centralized issuance with NETS as the trust root, or self-attestation via BizFile+. |

---

## Known limitations

- **Mobile-number PayNow not supported in V0.** Domain-tag scheme is in place; needs frontend wiring + attestation policy.
- **The V0 attestation issuer is single-key and ops-controlled.** Mitigated by AdminCap rotation; V1 migrates to multisig, V2 to a NETS-controlled signer or BizFile+ self-attestation.
- **Cash-out is a custodial demo on a personal Wise account** within hackathon scope. Off by default (`cashout_enabled`, `WISE_ENV=sandbox`); the licensed non-custodial settlement leg is V2. No Singapore PSA/DPT-SP counsel opinion has been obtained — do not treat the cash-out path as production-ready.
- **Testnet (dev) has no Quay-USDC ↔ SUI aggregator route.** A side effect of the bridged testnet stable Cetus's subgraph doesn't index; mainnet does not have this gap.
- **No camera-scan support for non-SGQR formats.** Other countries' QR formats need separate parsers (see "Fork this for your country").

---

## Repo layout

```
quay/
├── move/quay/                     # Move 2024 edition package
│   ├── sources/payments.move      # ~517 LOC including update_merchant_metadata
│   └── tests/payments_tests.move  # 24 unit tests, all green
├── frontend/                      # Next.js 16 + React 19 + Tailwind 4 PWA (app + API)
│   ├── src/app/
│   │   ├── app/                   # authed surface (resolves on app.quay.cash)
│   │   │   ├── scan/              # payer flow
│   │   │   ├── history/           # payer receipt history
│   │   │   ├── verify/[blobId]/   # receipt-blob verification
│   │   │   ├── m/[uen]/           # public merchant page
│   │   │   ├── merchant/login/    # Google zkLogin sign-in
│   │   │   ├── merchant/onboard/  # claim UEN + pick receive token (+ /pending)
│   │   │   ├── merchant/wallet/   # identity + settlement change + withdraw + yield
│   │   │   ├── merchant/terminal/ # live PaymentReceipt feed
│   │   │   ├── merchant/history/  # incoming-payment history
│   │   │   ├── admin/kyb/         # admin review queue
│   │   │   └── admin/setup/       # one-time admin X25519 pubkey derivation
│   │   ├── docs/                  # public docs page
│   │   ├── embed/                 # embeddable widgets
│   │   └── api/
│   │       ├── attest/            # POST: issuer signs ClaimMessage
│   │       ├── kyb/               # submit / status / finalize / admin-pubkey
│   │       ├── admin/             # wallet-signed admin queue
│   │       ├── sponsor/           # update-metadata / withdraw / toggle-yield / earn-move
│   │       ├── cashout/           # quote / initiate / confirm (custodial demo)
│   │       ├── cron/              # Scallop monitor + cost-basis indexer
│   │       ├── receipts/          # receipt lookup
│   │       └── zklogin/salt/      # zkLogin salt service
│   └── src/lib/
│       ├── dex/                   # Cetus Aggregator + balances + partner config
│       ├── pyth/                  # Hermes client + SGD/USD/SUI quote math
│       ├── quay/                  # pay + register + lookup + indexer + scallop + transfer
│       ├── sgqr/                  # EMVCo MPM parser + builder + quote-metadata codec
│       ├── walrus/                # client + v1 merchant profile schema
│       ├── zklogin/               # Enoki integration + ephemeral key handling
│       ├── server/                # issuer, sponsor, treasury, wise, cashout-store (server-only)
│       └── sui-config.ts          # active network + deployed IDs (mirrors deploy-mainnet.json)
├── scripts/                       # bun-runnable ops + smoke tooling
│   ├── deploy-mainnet.json        # canonical mainnet IDs
│   ├── deploy-testnet.json        # archived V4 testnet block
│   ├── deploy-testnet.v{1,2,3}.json  # archived prior testnet versions
│   ├── day0-validate.ts           # env/config preflight
│   ├── day2-deploy.ts             # publish + init + register merchant1
│   ├── day5-pay-smoke.ts          # E2E pay smoke
│   ├── day6-onboard-smoke.ts      # onboarding smoke
│   ├── day7-create-sponsor.ts     # sponsor wallet + funding
│   ├── day7-sponsor-smoke.ts      # sponsor signing smoke
│   ├── day11-stage-demo.ts        # 3 demo merchants
│   ├── day13-cetus-aggregator-smoke.ts  # aggregator route + PTB devInspect
│   ├── gasless-withdraw-spike.ts  # verifies 0x2::coin::send_funds gasless path
│   ├── cashout-redrive.ts         # recover stuck Wise payouts
│   ├── wise-smoke.ts / wise-payout-probe.ts  # Wise sandbox probes
│   └── gen-test-vectors.ts        # ed25519 test vectors for Move tests
├── supabase/migrations/           # Postgres schema (KYB, audit log, flags, yield cost basis)
├── docs/
│   ├── GOOGLE_OAUTH_SETUP.md      # zkLogin path setup
│   └── DRESS_REHEARSAL.md         # demo runbook
├── SECURITY.md                    # threat model + custody disclosure
├── TODOS.md
├── CONTRIBUTING.md
└── .secrets/                      # gitignored — issuer + sponsor + treasury + demo keys
```

---

## License

MIT. See [`LICENSE`](LICENSE).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security disclosures: [`SECURITY.md`](SECURITY.md).
