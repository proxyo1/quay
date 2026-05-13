# quay

**SGQR-compatible Sui payments.** Scan any Singapore SGQR sticker, pay any Sui
token, settle on chain. Merchants onboard with **Google zkLogin** — one
Gmail account = one Sui address — and the quay-the-company sponsor
wallet covers gas so a brand-new merchant doesn't need a single SUI to
register.

> Internal note: the on-chain Move module is still named `suiqr::payments`
> for V0 (renaming requires a redeploy and would invalidate the existing
> registry). The product brand is **quay** — the Move rename is bundled
> with the next planned redeploy (Move audit / mainnet promotion).

> **Submission for the Sui Overflow hackathon.** Live on Sui testnet. Mainnet
> path documented below.

```
┌──────────┐  scan   ┌─────────────────────────┐  pay  ┌─────────────┐
│  Payer   │ ───────▶│ /scan: parse SGQR, fetch │ ─────▶│  Merchant   │
│ (wallet) │         │ Pyth quote, build PTB    │       │  on-chain   │
└──────────┘         └──────────┬──────────────┘       └─────────────┘
                                │
                                ▼ payments::pay<T>
                       ┌────────────────────┐
                       │ MerchantRegistry   │ emits PaymentReceipt event
                       │   (shared)         │ ─────────────────────────┐
                       └────────────────────┘                          │
                                                                       ▼
                                                          ┌────────────────────┐
                                                          │ /merchant/terminal │
                                                          │   live SGD feed    │
                                                          └────────────────────┘
```

---

## What's live today

| Surface | Status | Notes |
|---|---|---|
| `payments::payments` Move module | ✅ on testnet | `0x46398f...e167e` |
| `MerchantRegistry` shared object | ✅ on testnet | `0x00148a...e5e1` |
| `/scan` — paste SGQR, see live SGD/SUI quote, pay | ✅ end-to-end | Pyth USD/SGD inverted + SUI/USD |
| `/merchant/onboard` — claim a UEN | ✅ Google zkLogin + sponsored gas | Wallet-connect path removed for merchants |
| `/merchant/terminal` — live PaymentReceipt feed | ✅ 2s refresh, SGD-prominent | client-side merchant filter |
| `/api/attest` — issuer signs ed25519 attestations | ✅ server-side, `.secrets`/env keys |
| `/api/sponsor/register` — quay pays merchant onboarding gas | ✅ 5/day per address, 20% balance floor |

| Feature | Status | Why |
|---|---|---|
| Cetus swap-and-pay (any-token → USDC) | 📋 catalog only | Move contract is `Coin<T>`-generic; testnet pool liquidity uncertain; deferred to focused session |
| Cetus swap-and-pay PTB on mainnet | 📋 V0.5 | Move contract is `Coin<T>`-generic; testnet liquidity uncertain |
| Gasless stablecoin retail path (USDsui / USDC) | 📋 V0.5 | Protocol-level gasless via [`0x2::balance::send_funds`](https://docs.sui.io/develop/transaction-payment/gasless-stablecoin-transfers); dual-path with `payments::pay<T>` retained for the receipted path |
| Mobile-number PayNow (~70% of SG hawkers) | 📋 V1 | Domain-tag namespacing (`PAYNOW_UEN_V1` vs future `PAYNOW_MOBILE_V1`) is already on chain |
| SuiNS optional name attach | 📋 V0.5 | Address truncation works for V0 demo |

---

## Architecture

### Move module — `suiqr::payments` (~290 LOC)

[`move/suiqr/sources/payments.move`](move/suiqr/sources/payments.move). Single shared
`MerchantRegistry`, `Coin<T>`-generic `pay`/`refund`, ed25519-attested
`register_merchant`, AdminCap-gated issuer rotation.

### Move API reference

| Function | Purpose | Failure modes |
|---|---|---|
| `init(ctx)` | One-time at publish — creates shared `MerchantRegistry`, transfers `AdminCap` to publisher |  |
| `set_initial_issuer_pubkey(registry, pubkey, chain_id, ctx)` | Admin sets the issuer ed25519 pubkey + chain_id once after publish | `E_NOT_ADMIN`, `E_ISSUER_ALREADY_SET` |
| `rotate_issuer_pubkey(cap, registry, new_pubkey, clock)` | AdminCap holder rotates the issuer key, emits `IssuerKeyRotated` |  |
| `register_merchant(registry, uen, nonce, attestation, expires_at_ms, metadata_uri, clock, ctx)` | Merchant claims a UEN with an issuer-signed `ClaimMessage` | `E_REGISTRY_NOT_INITIALIZED`, `E_ATTESTATION_EXPIRED`, `E_UEN_ALREADY_CLAIMED`, `E_NONCE_REPLAYED`, `E_INVALID_ATTESTATION` |
| `pay<T>(registry, uen, coin, memo, sgd_minor_units, quote_metadata, clock, ctx)` | Pay a registered merchant in `Coin<T>`, emits `PaymentReceipt` | `E_UEN_NOT_REGISTERED`, `E_PAYMENT_BELOW_MIN` |
| `refund<T>(receipt_id, payer, coin, clock, ctx)` | Merchant refunds `Coin<T>` to payer, emits `RefundIssued` | `E_REFUND_AMOUNT_ZERO` |
| `update_merchant_address(registry, uen, new_address, clock, ctx)` | Merchant rotates their payout address | `E_UEN_NOT_REGISTERED`, `E_NOT_MERCHANT_OWNER` |
| `is_registered(registry, uen)` view | Returns `bool` — used by `/scan` via `devInspectTransactionBlock` |  |
| `merchant_address(registry, uen)` view | Returns the merchant's Sui address |  |
| `chain_id(registry)` view | Returns the bound chain_id (`0` testnet) |  |
| `issuer_pubkey(registry)` view | Returns the current issuer pubkey |  |

### Error code mapping

| Code | Meaning |
|---|---|
| 1 | `E_UEN_ALREADY_CLAIMED` |
| 2 | `E_UEN_NOT_REGISTERED` |
| 3 | `E_NOT_MERCHANT_OWNER` |
| 4 | `E_PAYMENT_BELOW_MIN` |
| 5 | `E_INVALID_ATTESTATION` |
| 6 | `E_NONCE_REPLAYED` |
| 7 | `E_NOT_ADMIN` |
| 8 | `E_REGISTRY_NOT_INITIALIZED` |
| 9 | `E_ATTESTATION_EXPIRED` |
| 11 | `E_ISSUER_ALREADY_SET` |
| 12 | `E_REFUND_AMOUNT_ZERO` |

### The novel insight — UEN as registry key

The SGQR spec embeds the merchant's **PayNow proxy** (UEN string, mobile
number, or VPA) inside EMVCo Tag 26's sub-tag 02 — alongside a sub-tag 01
that says which proxy type it is (`0` mobile, `2` UEN, `5` VPA). The UEN is
the merchant's existing public, ACRA-controlled identifier.

Treating that UEN as the on-chain registry key means:
- **Zero new identifiers** — merchants don't get a new "quay ID"; they use
  what they already have on the back of their SGQR sticker.
- **The existing sticker keeps working** — any SGQR scanner (banks, NETS,
  TouchNGo, etc.) ignores fields it doesn't understand; quay is opt-in.
- **Domain-tag namespacing** (`blake2b256("PAYNOW_UEN_V1" || uen)`) leaves
  room for `PAYNOW_MOBILE_V1` and `PAYNOW_VPA_V1` slots without collision.

The on-chain receipt event includes `sgd_minor_units` — the SGD-equivalent
the payer agreed to settle at — plus `quote_metadata` carrying the Pyth
feed IDs, prices, and publish timestamps so any auditor can replay the
rate.

---

## Why not just off-ramp? (the demo Q&A defense)

This is the question every Singaporean hears: "PayNow + Coinhako/StraitsX/
Crypto.com Card already work — what's quay for?"

**Honest answer:** PayNow works for 99% of SG users. quay targets the
crypto-native 1% and the merchants who want to serve them.

**Payer-side differentiators** (crypto-native customer):
- **Non-custodial throughout.** No exchange holds your tokens between
  earning and spending.
- **No exchange KYC at point of sale.** Your Sui wallet stays anonymous.
  Off-ramping to fiat requires KYC; quay doesn't.
- **One tax event.** Direct payment with crypto = single disposition.
  Off-ramp + spend = two events to track and report.
- **Multi-token at point of sale.** Pay in whatever you hold; no
  per-asset cash-out cycle.
- **On-chain receipt.** PaymentReceipt event carries `sgd_minor_units`
  for personal accounting; off-ramp + spend leaves no equivalent trail.

**Merchant-side differentiators** (NOT anonymous — UEN is public, ACRA-
registered):
- **Lower fees vs Visa MDR.** Cetus swap spread is <0.1% vs Visa
  2-3% merchant discount rate. PayNow is free for receivers — quay can't
  beat free for SGD merchants, but for merchants who want to receive
  USDC, the cost stack is dramatically lower than card networks.
- **Self-custody of received USDC.** No Coinhako solvency risk; the
  merchant's address holds the coin immediately after settlement.
- **Structured on-chain receipts.** `PaymentReceipt.sgd_minor_units`
  is queryable for GST reporting; bill_number flows through EMVCo
  Tag 62 sub-tag 01.
- **Multi-token receive** (V1 opt-in): incoming USDC auto-deposits into
  Suilend/Navi/Scallop in the same PTB.
- **Brand positioning** for crypto-friendly cafes, co-working spaces, and
  Web3 events.

**Q: Does customer-side anonymity hurt the merchant?** No, for normal
retail.
- Refunds work via the Sui address in `PaymentReceipt` + `refund<T>` —
  no human identity needed.
- No chargeback risk to the merchant (better than Visa's 1-2% chargeback
  cost).
- AML/CFT does NOT require customer KYC on the merchant for retail under
  SGD 5k — the merchant is payee, not a value-transfer agent.
- Tax is per-revenue, not per-customer; `sgd_minor_units` gives GST-ready
  SGD equivalent.
- Loyalty programs work pseudonymously (Sui address = punch-card
  identifier).
- Avoided PCI compliance + customer-data-breach liability.

**Where it IS a problem:** high-value transactions ($1000+) where the
merchant might want voluntary ID, B2B invoicing, and
subscription-with-consumer-protection — all V1+ territory.

**Honest merchant demand caveat:** PayNow is free for receivers in SG.
quay cannot beat free. The real merchant motivation is ideological /
brand (crypto-friendly positioning) or treasury (want USDC for yield).
Target = the 50–500 crypto-friendly merchants in SG who already
informally accept crypto.

**Reframe:** *protocol* (forkable to DuitNow / UPI / QRIS / PIX) vs
*product* (V0 Singapore wedge). Hackathon judges the protocol; the
product is the demo instance.

---

## Forks not taken

| Choice | Why | Alternative |
|---|---|---|
| SGQR (Singapore) | The spec embeds UEN in a structured way and 200k+ stickers already exist | DuitNow / UPI / QRIS / PIX — same code, different parser |
| UEN as registry key | Public, ACRA-controlled, NOT NETS-controlled (so quay isn't beholden to NETS) | Mobile-number PayNow (V1 — adds `PAYNOW_MOBILE_V1` namespace) |
| Manual ed25519 attestation (V0) | Simplest trust root; rotatable via AdminCap | NETS-controlled signer (mainnet), or trustless self-attestation via BizFile+ federation |
| Pyth (off-chain via Hermes for the UI quote) | Cross-chain feed parity; on-chain Pyth update happens in the swap PTB on V1 | DIA, Switchboard, or self-managed oracle |
| Cetus (planned for V1 swap) | Deepest Sui CLMM liquidity; partner-fee program supports the quay partner cap | DeepBook orderbook, Bluefin, Aftermath |
| Wormhole-bridged USDC initially | Available on testnet today | Circle CCTP-native USDC on mainnet — see USDC note below |
| `Coin<T>` generic instead of fixed-asset | Same code supports SUI / USDC / future stables / future swap | Per-asset entry functions (would explode the API surface) |
| Sui Move 2024 edition | Recommended path; module-label syntax | Legacy edition (no benefit, more boilerplate) |
| blake2b256 for the canonical hash | Sui-native, cross-chain-friendly | keccak256 (also available; blake2b is the Sui-canonical choice) |
| Off-chain rate-limit for sponsored gas | Simplest V0; quay-the-company controls the route | On-chain `SponsorRegistry` with per-day counters (Phase 2) |

---

## USDC clarification

Sui has two USDCs in flight at hackathon time:
- **Wormhole-bridged USDC** — `0x...::usdc::USDC` from Wormhole's portal.
  Available today on both testnet and mainnet. Bridged from Ethereum
  Circle USDC; redemption requires going back through Wormhole.
- **Circle CCTP-native USDC** — Circle's first-party Sui issuance via
  Cross-Chain Transfer Protocol. Going live on Sui mainnet on the
  Sui Foundation's announced timeline.

V0 mainnet pre-CCTP: Wormhole USDC. V0 mainnet post-CCTP: switch to
native USDC (~30 LOC frontend change; no on-chain redeploy because
the contract is `Coin<T>`-generic).

The "MAS-relevant USDC" framing is more honest with native CCTP USDC
than with the bridged version — be precise about which one in the demo.

---

## Issuer key storage policy

The current testnet issuer key is held by quay-the-company in
`.secrets/issuer-testnet.json` (gitignored). For production:

- **V0 mainnet**: air-gapped hardware key (Ledger or YubiHSM2) on a
  single ops machine. Manual signing per merchant approval.
- **V1**: rotate to `2-of-3` multisig (or `m-of-n` with on-chain
  verification) via `rotate_issuer_pubkey(cap, registry, new_pubkey, clock)`.
  AdminCap is held by a separate multisig.
- **V2**: replace centralized issuance with a NETS-controlled signer
  (NETS is the existing operator of SGQR), or a self-attestation scheme
  where the merchant proves UEN ownership via BizFile+ federation.

The on-chain primitive supports all three without redeploy — only the
issuer key holder changes.

---

## Deploy walkthrough

```bash
# 1. Toolchain
brew install sui pnpm
sui client new-env --alias testnet --rpc https://fullnode.testnet.sui.io:443
sui client switch --env testnet
sui client new-address ed25519 dev
# fund via https://faucet.sui.io/?address=<your dev address>

# 2. Build + test
cd move/suiqr
sui move build
sui move test  # 18/18 pass

# 3. Deploy + initialize + register a demo merchant
cd ../../scripts
bun install
bun run day2-deploy.ts        # publishes payments, sets issuer pubkey, registers merchant1
bun run day7-create-sponsor.ts # creates sponsor wallet, funds 0.1 SUI
bun run day11-stage-demo.ts    # 3 demo merchants for the dress rehearsal

# 4. Frontend
cd ../frontend
pnpm install
pnpm dev   # http://localhost:3000

# 5. Browser walk-through
# /scan        → scan an SGQR sticker with the camera, or type a demo UEN
# /merchant/login → "Sign in with Google" (zkLogin)
# /merchant/onboard → claim a UEN with sponsored gas (no SUI required)
# /merchant/terminal → live PaymentReceipt feed for your zkLogin-derived address
```

Full step-by-step demo flow: [`docs/DRESS_REHEARSAL.md`](docs/DRESS_REHEARSAL.md).

---

## Event subscription (TypeScript snippet)

```ts
import { SuiJsonRpcClient as SuiClient, getJsonRpcFullnodeUrl as getFullnodeUrl } from "@mysten/sui/jsonRpc";

const sui = new SuiClient({ network: "testnet", url: getJsonRpcFullnodeUrl("testnet") });
const PKG = "0x70631c59a94e74594af10eabcd20e6cf88564ccca985610c8c1c9b100462a87c";
const merchant = "0x..."; // your address

// Poll every 2s for recent PaymentReceipt events targeting you
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

## Fork this for your country

The quay codebase is structured so a non-SG implementation is mostly a
parser + naming change:

1. **Fork & rename** — `suiqr::payments` → `<country>qr::payments`. Move
   module structure stays the same.
2. **Update the EMVCo MAI parser** — `frontend/src/lib/sgqr/parser.ts`
   already finds the local payment scheme by GUID match across tags
   `02..51`. Change the GUID to `MY.PAYNET` (Malaysia), `IN.UPI`, etc.
3. **Update the domain tag** — `blake2b256("PAYNOW_UEN_V1" || ...)` →
   `blake2b256("PAYNET_NRBC_V1" || ...)`. The structure is the same; only
   the namespace tag changes.
4. **Update the price oracle** — `Pyth.FX.USD/MYR`, `Pyth.FX.USD/INR`,
   etc. The Pyth feed catalog covers all major fiat pairs.
5. **Update the merchant identifier validator** — Malaysia uses NRBC,
   India uses UPI handles, etc. `looksLikeUen` becomes `looksLikeNrbc`.
6. **Deploy fresh** — same `sui move build && publish` flow.

Each country adds ~200 LOC of frontend parser changes; the on-chain code
is essentially country-agnostic.

---

## Known limitations

- **Mobile-number PayNow (proxy type `0`) is not supported in V0.** ~70%
  of SG hawkers use mobile-number PayNow rather than UEN. V1 adds the
  `PAYNOW_MOBILE_V1` namespace; the domain-tag scheme is already in
  place to make this collision-free.
- **The V0 attestation issuer auto-signs for any well-shaped UEN.**
  Production gates issuance behind SGQR-photo + BizFile+ review or a
  NETS-controlled signer.
- **Single-key trust root in V0.** Mitigated by AdminCap rotation; not
  acceptable for mainnet without multisig migration.
- **Cetus swap-and-pay is not in the V0 demo.** Move contract is
  `Coin<T>`-generic; mainnet adds a Cetus swap step in the same PTB.
- **No Singapore counsel opinion on PSA / DPT-SP scope** yet. Required
  before mainnet for legal cover.
- **No Move security audit.** Required before mainnet ($25-50k, 4-6
  week lead time from OtterSec / MoveBit / Zellic).
- **Testnet only.** Mainnet readiness requires the above three +
  Wormhole→CCTP USDC migration + real-merchant pilot.
- **No camera scanning yet.** `/scan` accepts pasted SGQR strings. Real
  camera ships once AD5's ≥20-photo testing pass is done with actual SG
  SGQR stickers.

---

## Testnet deployment

V3 redeploy (2026-05-13) — module renamed to `quay::payments`, canonical
attestation domain tag bumped to `QUAY_CLAIM_V1`. V1 (pre-Walrus) and V2
(Walrus, still `suiqr::payments`) artifacts preserved as
[`scripts/deploy-testnet.v1.json`](scripts/deploy-testnet.v1.json) and
[`scripts/deploy-testnet.v2.json`](scripts/deploy-testnet.v2.json).

```
Network:          testnet (chain_id = 4c78adac)
Package:          0x70631c59a94e74594af10eabcd20e6cf88564ccca985610c8c1c9b100462a87c
MerchantRegistry: 0xa572e59aa755af7a93c2a0b0216639b3debe6b5ecdb4074c763d3484e879645b
AdminCap owner:   0xa91644aa47914b16b73258c1de984e3296ef15e40a838ffd3b8fa533b27def2f
Issuer pubkey:    0x5d44735e96af7d30d245936458efc03f5fdc4ba042046848afc4ad9dd8d115c8
Sponsor wallet:   0xbe085e2a3fedcf5da35c1602ea6278da41e565fbd2edb35971aa4a2da5ebb4ce
```

Demo flow on chain (V3):

- Publish: [`EQAFEAw…X9pZ`](https://suiscan.xyz/testnet/tx/EQAFEAwZcPCUhXnoVfSKU2KzU8YAbkNivpeTsQVvX9pZ)
- Set initial issuer pubkey: [`EynoQ2e…x7sM`](https://suiscan.xyz/testnet/tx/EynoQ2eN1cYJBD5qHZGnxaJVYsh81PyLTgbZ3JEox7sM)
- Register merchant1 (UEN `202412345Z`): [`7NdB95w…g8gY`](https://suiscan.xyz/testnet/tx/7NdB95wjHva8yCuhAnrpEfhjbkELGiEc78Zouv8zg8gY)
- Pay merchant1 $1.50 SGD (1.5M MIST): [`HTK15pc…R385s`](https://suiscan.xyz/testnet/tx/HTK15pcvesY3uiXZZ2yuk8nuR7Lcy83on6jytn8R385s)

---

## Repo layout

```
suiqr/
├── move/suiqr/                    # Move 2024 edition package
│   ├── sources/payments.move      # ~290 LOC, all AD additions applied
│   └── tests/payments_tests.move  # 18 unit tests, all green
├── frontend/                      # Next.js 16 + React 19 + Tailwind 4
│   ├── src/app/
│   │   ├── page.tsx               # home
│   │   ├── scan/page.tsx          # payer flow
│   │   ├── merchant/page.tsx      # merchant landing
│   │   ├── merchant/login/        # Google zkLogin sign-in
│   │   ├── merchant/onboard/      # claim a UEN (zkLogin signs, sponsor pays gas)
│   │   ├── merchant/wallet/       # info + identity claims (no exportable key)
│   │   ├── auth/google/callback/  # OAuth callback: Enoki zk-proof fetch
│   │   ├── api/zklogin/salt/      # POST: server-derived salt (legacy; unused since Enoki migration)
│   │   ├── merchant/terminal/     # live PaymentReceipt feed
│   │   ├── api/attest/route.ts    # POST: issuer signs ClaimMessage
│   │   └── api/sponsor/register/  # POST: sponsor signs gas; rate-limited
│   ├── src/components/
│   │   ├── SuiProviders.tsx       # dapp-kit + react-query + wallet provider
│   │   └── PayPanel.tsx           # Pyth quote + Pay button
│   └── src/lib/
│       ├── sgqr/                  # EMVCo MPM parser + sanitizer + builder
│       ├── pyth/                  # Hermes client + SGD/USD/SUI quote math
│       ├── suiqr/                 # buildPaySuiTx + buildRegisterTx
│       ├── server/                # issuer.ts, sponsor.ts (server-only)
│       └── sui-config.ts          # network IDs (mirrors deploy-testnet.json)
├── scripts/                       # bun-runnable testnet automation
│   ├── deploy-testnet.json        # canonical on-chain IDs
│   ├── cetus-testnet.json         # Cetus IDs (catalog for V0.5)
│   ├── demo-fixtures.json         # SGQR strings + UENs for the demo
│   ├── day2-deploy.ts             # publish + init + register merchant1
│   ├── day5-pay-smoke.ts          # E2E pay flow against testnet
│   ├── day6-onboard-smoke.ts      # E2E merchant register via /api/attest
│   ├── day7-create-sponsor.ts     # sponsor wallet + funding
│   ├── day7-sponsor-smoke.ts      # 0-SUI wallet sponsored register
│   ├── day11-stage-demo.ts        # 3 demo merchants for the dress rehearsal
│   └── gen-test-vectors.ts        # ed25519 test vectors for Move tests
├── docs/
│   ├── GOOGLE_OAUTH_SETUP.md      # zkLogin path setup
│   └── DRESS_REHEARSAL.md         # 5-minute demo runbook
└── .secrets/                      # gitignored — issuer + sponsor + demo keypairs
```

---

## Build status

- [x] Move module + tests (Day 1)
- [x] Testnet deploy + register + pay E2E (Day 2)
- [x] SGQR EMVCo parser + scan page (Day 3)
- [x] Pyth live SGD→SUI quote (Day 4)
- [x] Real `payments::pay<SUI>` Pay button (Day 5)
- [x] Merchant onboarding via Google zkLogin + sponsored gas (Days 6 + 7 collapsed)
- [x] Sponsored-gas merchant signup (Day 7)
- [x] Merchant terminal with live event feed (Day 8)
- [x] PWA manifest + icons (Day 10)
- [x] 3 demo merchants staged + dress rehearsal runbook (Day 11)
- [x] First-class README (Day 12.5)

Deferred to V0.5+:
- Cetus swap-and-pay PTB (catalog ready)
- SuiNS optional name attach
- Mobile-number PayNow proxy
- USDsui mainnet settlement + protocol-level gasless retail path (V0.5)

---

## License

MIT. See [`LICENSE`](LICENSE).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security disclosures: [`SECURITY.md`](SECURITY.md).
