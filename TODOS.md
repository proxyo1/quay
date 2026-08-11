# quay TODOs

Generated 2026-05-12 from office-hours design session + hackathon scoping.

## In scope for hackathon submission

### Move module (quay::payments)
- [ ] Write module per design doc sketch (~250 LOC, Sui framework 1.20+)
- [ ] Registry keyed on `blake2b256("PAYNOW_UEN_V1" || uen_bytes)` (NOT raw UEN — privacy)
- [ ] Domain-tag namespacing in key derivation so future mobile-number support doesn't collide
- [ ] On-chain ed25519 attestation verification in `register_merchant` over canonical message `blake2b256("QUAY_CLAIM_V1" || uen_bytes || bcs(claimer_addr) || nonce)`
- [ ] Replay-nonce table to prevent attestation reuse
- [ ] `pay<T>` generic over Coin<T>; takes raw `uen_bytes`, re-hashes on chain; emits PaymentReceipt with deterministic receipt_id
- [ ] `refund<T>` entry function with original_receipt_id linkage
- [ ] `update_merchant_address` for wallet rotation
- [ ] `AdminCap` for issuer pubkey rotation
- [ ] Unit tests for each entry function, including failure paths (bad attestation, replayed nonce, unclaimed UEN, etc.)

### Frontend (Next.js PWA)
- [ ] SGQR EMVCo TLV parser (~200 LOC, hand-rolled or open source) — extract UEN from PayNow subtag (proxy type `2`)
- [ ] Fallback path for mobile-number PayNow proxies (proxy type `0`) — show "not supported in V0" message gracefully
- [ ] Camera-based QR scanner via `@zxing/browser`
- [ ] Wallet connect via `@mysten/dapp-kit` (Sui Wallet, Slush, Suiet)
- [ ] Merchant lookup screen with name + amount entry (SGD)
- [ ] Pyth oracle integration for SGD/USD + SUI/USD price feeds
- [ ] Cetus router integration for any-token → USDC quotes
- [ ] Atomic swap-and-pay PTB builder for non-USDC sources
- [ ] zkLogin merchant onboarding via Google OAuth (Mysten hosted salt service) — MERCHANTS ONLY (payers use their existing Sui wallet)
- [ ] Sponsored-transaction wiring for Sui-wallet-holders with stablecoin balance but zero SUI (detect via `getBalance(0x2::sui::SUI) === 0`)
- [ ] Daily cap enforcement on sponsored txns per wallet address (off-chain rate limit)
- [ ] Merchant terminal PWA: WebSocket subscription to PaymentReceipt events
- [ ] Merchant terminal SGD-prominent display
- [ ] SuiNS optional name attach during merchant onboarding
- [ ] PWA manifest + install prompt
- [ ] Mobile testing on real iPhone + Android

### Submission deliverables
- [ ] Public GitHub repo, MIT license, clean commit history
- [ ] README: architecture explanation, UEN-from-PayNow-subtag-as-registry-key insight, what's deferred
- [ ] README: "Why not just off-ramp?" section (the demand-defense answer for demo Q&A — 5 differentiators + protocol-vs-product reframe)
- [ ] Demo video (90-150s) showing full flow with real SGQR
- [ ] Live PWA deployed to Vercel
- [ ] Testnet contract address documented in README

## Backlog (post-hackathon, only if submission earns it)

### Programmable-money extensions (judges may love these even as backlog items in the README)
- [ ] **Split-payment / bill-splitting PTB** — multiple payers contribute atomically to one merchant payment. Singapore-resonant (hawker bills with friends). ~80 LOC Move + significant frontend coordination.
- [ ] **Conditional refund escrow** — payments land in 30-min escrow before final delivery; payer can dispute within window for auto-refund. Uses Sui Clock. Trust-minimized finance category. ~80 LOC Move + dispute UI. Make opt-in per payment to preserve instant UX.
- [ ] **Yield routing on merchant receive** — merchant opt-in flag: incoming USDC auto-deposits to Suilend/Navi/Scallop in same PTB. Earn yield while waiting to off-ramp. ~50 LOC Move + 30 LOC frontend. Note: USDC yield on Sui depends on lending market depth.
- [ ] **NFT receipt minting** — each `pay` also mints a non-transferable receipt NFT to payer's wallet. Loyalty / tax / refund-proof. ~40 LOC Move.
- [ ] **Subscription / streaming payments** — `subscribe()` entry function authorizes recurring micro-payments within budget. Programmable money in the most literal sense. ~150 LOC + significant frontend.
- [ ] **Stamp card loyalty** — merchant-issued NFT collection; each `pay` mints a stamp to payer; after N stamps, redeemable.

### Production path (only if hackathon wins / places / draws Sui Foundation interest)
- [ ] Engage Singapore counsel (Drew & Napier or Allen & Gledhill) for PSA/DPT-SP opinion
- [ ] Engage Move audit firm (OtterSec / MoveBit / Zellic), 4-6 week lead time, $25-50k
- [ ] NETS SGQR terms-of-service legal opinion — risk is reduced by using UEN (ACRA-controlled) rather than NETS-controlled keys, but a formal opinion is still prudent before mainnet
- [ ] Mobile-number PayNow proxy support (proxy type `0`) for sole-proprietor merchants without a UEN
- [x] Manual KYB doc review gate before issuer attestation (`/admin/kyb` flow, shipped)
- [ ] CorpPass federation for automatic UEN ownership verification (replaces the current manual Bizfile review at `/admin/kyb`)
- [ ] Retroactive KYB review for grandfathered merchants registered before the KYB gate landed — admin tool to flag a wallet "needs KYB" and surface a banner in their terminal until they submit
- [ ] v1.1: "Remember key on this device for 24h" password-wrapped storage for the admin X25519 key, to avoid re-signing the derive-key prompt on every session once daily review volume warrants it
- [ ] v2: WebAuthn / Touch ID-derived unlock as an alternative to wallet-signature derivation
- [ ] Real-merchant pilot: 5+ named SG crypto-friendly merchants signed up
- [ ] Migrate from Wormhole USDC to Circle CCTP native USDC when available
- [ ] V2 fiat settlement layer (the real, non-custodial merchant USDsui→SGD off-ramp). Two candidate leg-1 partners, both regulated: (a) **StraitsX** — MAS-licensed, shipping stablecoin-native PayNow merchant settlement (XSGD redemption); (b) **Bridge/Stripe** — USDsui's own issuer, with global fiat payout rails (redeem at par through the issuer). Either replaces the manual demo below. Requires a PSA license (SPI SGD 100k / MPI SGD 250k capital) or a licensed partner. Pairs with the counsel/PSA-DPT-SP opinion item above.
- [ ] **Coinbase CDP Offramp follow-ups** (rail shipped 2026-08-11, flag `coinbase_offramp_enabled` OFF).
  Phase 0 passed against production: SG supported, SGD payable, USDC sellable from Sui.
  Outstanding before the flag can go on:
  - [ ] One capped live run (`COINBASE_OFFRAMP_MAX_SGD_MINOR` low). **There is no offramp sandbox**,
    so this is real money against production Coinbase — no way around it.
  - [ ] Register the `redirectUrl` on the CDP domain allowlist (Payments → Onramp & Offramp).
    A non-allowlisted URL is silently dropped while the order still completes.
  - [ ] Confirm whether offramp needs separate production approval; the quickstart lists only
    account + secret key + allowlist, which is not the same as confirmation.
  - [ ] **`from_address` semantics unverified** — does Coinbase validate the transaction *sender*
    or the *gas payer*? Quay's sponsored PTB has `sender = merchant`, `gasOwner = sponsor`, so the
    two differ. The capped live run settles this.
  - [ ] The hourly reconcile cron needs a paid Vercel tier (Hobby is daily-only).
  - [ ] Swap-back path for stranded USDC. After a post-send cancellation the merchant holds USDC,
    which is not a receive token; `StrandedUsdcCard` surfaces the balance but there is no one-tap
    conversion, so recovery is currently a support action.
  - [ ] **Abandon-before-send is unrecoverable by construction** and will stay that way: signing is
    client-only, so no server or cron can fill an order the merchant walked away from. Mitigated by
    the surviving-tab design and up-front warning only.
- [ ] **Fee stack: Coinbase is ~4x the Wise leg.** Measured 2026-08-11 — Coinbase charged S$0.13 on a
  S$12.80 gross sale (~101 bps) against the Wise demo's 25 bps, before the 10% Scallop performance fee
  on interest and the Cetus route cost, and the merchant still moves SGD to their bank by hand. The
  rail's win is non-custody and outliving the Wise demo, not merchant economics. Decide whether that
  trade holds before promoting it over the Wise path.
- [ ] **Evaluate Bridge/Stripe as the offramp target.** Bridge issues USDsui and would redeem at par —
  removing the swap leg entirely and ending in a bank account rather than a Coinbase balance. Coinbase
  was chosen for speed of validation (self-serve, viability provable with one authenticated curl)
  rather than merchant outcome. Pairs with the V2 settlement item below.
- [ ] Counsel opinion: does non-custody actually resolve the DPT licensing question for this rail?
- [ ] **DELETE the manual Wise cash-out demo when V2 lands.** The demo is deliberately throwaway and custodial-by-treasury: remove `frontend/src/lib/server/{treasury,wise,cashout-store,cashout-fee}.ts`, `frontend/src/app/api/cashout/*`, `.secrets/treasury-mainnet.json`, the `cashout_requests` table + `cashout_enabled` flag, `scripts/cashout-redrive.ts`, and the cash-out half of `MoneyOutSections.tsx`. Keep the non-custodial withdraw-to-address (gasless `buildGaslessUsdsuiSendAll` + `/api/sponsor/withdraw` for partial + WithdrawSection) — that stays. **Note:** the Coinbase rail is NOT parity and does not unblock this deletion — it pays into a Coinbase balance, not a bank, and requires each merchant to hold a KYC'd Coinbase SG account.
- [ ] Apply for Sui Foundation grant ($25-100k plausible with hackathon validation)

### Operational
- [ ] **`/api/cashout/*` and `/api/sponsor/*` have no authentication** — `owner` is client-supplied and
  regex-validated only. Pre-existing; the Coinbase routes deliberately do not reproduce it (they gate on
  on-chain registry membership, see `lib/server/coinbase-auth.ts`). Retrofit that gate to the older routes.
- [ ] **`scripts/` still use the retired JSON-RPC transport** and are broken. The app moved to gRPC +
  GraphQL on 2026-08-11; the day0..day13 and wise-* one-shot tooling did not.
- [ ] No route-level or component-level test infrastructure. Logic is pushed into `lib/` and unit-tested
  there instead; routes and components are verified by hand.
- [ ] Replace dev-key issuer attestation with multisig or DAO control
- [ ] Self-attestation V1 design (remove quay as attestation issuer)
- [ ] Bug bounty program post-mainnet (Immunefi tier-1, ~$10k initial)
- [ ] Indexer self-hosted vs. Shinami/BlockVision evaluation
- [ ] Cross-border expansion design (Malaysia DuitNow QR is very similar to SGQR)
