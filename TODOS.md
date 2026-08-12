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
- [ ] **Harden manual UEN ownership proof — the current check does not establish ownership.**
  `/app/merchant/onboard` accepts "Bizfile (ACRA) or business letterhead". Neither proves control:
  an **ACRA business profile is a public record any person can buy for S$5.50** — you need not be
  an owner or director — and a letterhead is a Word document. So the evidence behind an issuer
  attestation costs an attacker S$5.50. The payoff is high and silent: claim a real merchant's UEN
  and payments scanned from their physical sticker settle to the attacker, while the victim (not a
  Quay user) has no way to notice. The *binding* is fine — JCS `evidence_content` over UEN + name +
  doc hash + claimer, nonce'd and expiry-bound; it is the attested fact that is weak.
  Distinguish two failure modes: document **forgery** (fixable by verification) and **impersonation**
  (genuine document, wrong person — unfixable by any amount of document scrutiny). Today's review
  only ever addresses the first, and only by eye.
  Fix, in priority order:
  - [ ] **Require a PayNow transfer *from* the business account** with a one-time reference code
    issued per submission (S$0.01 to Quay's PayNow). This is the high-leverage change: the bank
    already did full KYB to open the account, and PayNow registration already verified the
    UEN↔entity binding, so Quay **inherits the bank's KYB**. Sending requires account control;
    receiving proves nothing — that asymmetry is the whole point. On-brand too: merchants already
    have PayNow, so nothing new must be acquired. Moves the bar from "spend S$5.50" to "control the
    business bank account". **Verify first:** how much sender detail the bank surfaces on an inbound
    PayNow credit — the reference code correlates regardless, but a visible sender UEN/registered
    name would make the match machine-checkable instead of manual.
    Needs: a `verification_code` + payment-observed state on `kyb_submissions`, and
    `evidence_content` extended to bind the reference code once payment is the primary evidence.
  - [ ] **Accept the OpenAttestation (`.oa`) file** ACRA issues alongside the business-profile PDF,
    and verify it programmatically. Kills forgery outright and removes reviewer judgment — but does
    **nothing** for impersonation, since a genuine profile is purchasable. Complement to the PayNow
    check, never a substitute.
  - [ ] Keep **postal PIN to the ACRA-registered address** in reserve for merchants with no business
    bank account. Strong, but slow (days) and costs postage.
  - [ ] Considered and ranked lower: photo of the physical SGQR sticker beside a handwritten one-time
    code (circumstantial, but hard to fake at scale); NRIC/selfie matched against the Bizfile officer
    list (standard, forgeable, still closes the "wrong person entirely" gap); business-domain email
    (poor fit — hawkers and small SMEs mostly have no domain).
- [ ] **Myinfo Business / Corppass for automatic UEN ownership verification.** The right long-term
  answer: the merchant's own **Corppass Administrator** designates who may transact for the entity,
  so authority comes from government records rather than from reviewing a PDF. Data originates from
  ACRA (via BizFile), BGP, BCA and Corppass; a user may retrieve only their own business's corporate
  data and their own personal data, which is exactly Quay's need and no more.
  Researched 2026-08-12 — do not re-derive:
  - **Cost is a non-issue.** No setup or onboarding fees; freemium gives 50,000 free Login and 5,000
    free Myinfo Standard transactions per month per UEN. Quay would use a rounding error of that.
    (Unconfirmed: whether Myinfo Business is priced identically to personal Myinfo — the rate table
    needs a Singpass login.)
  - **Three gates, not zero.** Developer Portal access needs GovTech approval; staging/sandbox is
    self-service once inside; the production app is a *separate* approval taking up to 2 weeks.
  - **It cannot replace the manual flow.** Onboarding prerequisites state Singpass may not be the
    sole authentication or form-filling method — a manual/alternative path (manual entry, document
    upload) is a *condition of approval*. So `/admin/kyb` and the KYB doc handling stay permanently;
    Myinfo Business becomes the fast path, cutting review *frequency*, not the code or the admin-seed
    liability in SECURITY.md. Corollary: the hardening item above is not throwaway work — it is the
    fallback Quay is required to operate either way.
  - **Biggest risk is the regulated-industry question.** Prerequisites require licences or permits if
    operating in a regulated industry, and each requested data scope needs written justification.
    Quay has no PSA/DPT-SP counsel opinion (see above), so that item gates this one. No published
    policy was found on crypto/DPT use cases in either direction.
  - **Build on the current version.** Myinfo Business v3 opened for onboarding 2026-05-18, but v3/v4
    partners must migrate to Myinfo v5 by end September 2026 and be FAPI 2.0 compliant by
    31 December 2026 — target v5/FAPI 2.0 directly rather than onboarding to v3 and migrating.
  - **Integration wrinkle:** merchants authenticate with Google zkLogin, but Myinfo Business
    authenticates with Singpass/Corppass — different identities. The Corppass session proves UEN
    authority; the attestation must be issued for the Sui address presented **in that same session**,
    nonce-bound, or a relay attack lets someone pass Corppass for their own UEN and swap in another
    address. `ClaimMessage` already carries nonce + claimer, so the shape is right.
- [ ] **Free, zero-approval interim: ACRA open data UEN pre-check.** `data.gov.sg` publishes the ACRA
  entity register (2M+ entities, refreshed monthly) — UEN, entity name, status, type, address. No
  application, no cost. Confirms a UEN exists, is active, and matches the claimed name *before* a
  submission reaches the review queue. It does **not** prove the claimant controls it, so it is a
  cheap filter on obviously bad claims and a name pre-fill, never a replacement for review.
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
  - [ ] **Reconcile cron has no schedule.** Hobby allows 2 cron jobs at daily frequency and the two
    Scallop crons fill both slots, so a third entry fails the deploy. `/api/cron/coinbase-reconcile`
    exists and works but must be triggered externally (GitHub Action on a schedule, cron-job.org, or
    manually) until the account is on Pro. Set `CRON_SECRET` first if exposing it to an external
    caller. Not urgent: `/api/offramp/coinbase/status` reconciles on every poll, so this only covers
    the merchant who sends and never returns — where the funds are already with Coinbase and only the
    local row is stale.
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
