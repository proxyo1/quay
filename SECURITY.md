# Security policy

quay began as a hackathon submission on Sui testnet and is now **deployed
to Sui mainnet** (testnet artifacts are archived). The trust model below
governs the live deployment, not a hypothetical future one.

Two paths can move real money and are therefore **both off by default**:
the custodial Wise PayNow cash-out demo (`cashout_enabled`, and
`WISE_ENV=sandbox` unless deliberately flipped) and the non-custodial
Coinbase CDP offramp (`coinbase_offramp_enabled`, with a daily cap that
defaults to zero). Read "Known V0 caveats" before enabling either.

## Reporting a vulnerability

Please email **hello@0xmedia.co** with:
- a clear description of the issue,
- impact (data loss, fund loss, denial of service, escalation, etc.),
- repro steps (Move test, signed PTB, or browser script preferred),
- your suggested fix or mitigation if you have one.

Expect an acknowledgment within 48 hours. Please do not open public
issues for un-patched vulnerabilities.

## Threat model summary

### What quay promises

- **Merchants are who they say they are** — bound by the issuer
  ed25519 attestation over a BCS-encoded `ClaimMessage`.
- **Payments are immutable** — `payments::pay<T>` transfers the coin
  in the same PTB as the `PaymentReceipt` event emission.
- **Replay-resistant attestations** — every claim consumes a 32-byte
  nonce tracked on chain in `used_nonces`.
- **Cross-network replay-resistant** — the canonical message includes
  `chain_id`; a testnet attestation cannot register on mainnet.
- **Expiry-bound attestations** — every `ClaimMessage` carries
  `expires_at_ms`; the Move side enforces `clock.now <= expires_at_ms`.
- **No quay-custody of user funds** — merchants own their address;
  payers pay directly; quay never holds anyone's coins.

### What quay does NOT promise (V0)

- **The issuer key is single-key.** Compromise of
  `.secrets/issuer-testnet.json` (or the prod equivalent) lets the
  holder mint arbitrary attestations. V1 migrates to a multisig via
  `rotate_issuer_pubkey(cap, registry, new_pubkey, clock)`.
- **UEN ownership is proven by a PayNow micro-deposit, not by document
  review.** Quay sends S$0.01 to the UEN proxy encoded on the merchant's
  SGQR sticker, carrying a reference code; the merchant reads it off
  their bank statement and enters it. Passing requires visibility into
  the account that UEN receives PayNow into, which is the same account
  the physical sticker pays into. `/api/kyb/finalize` issues an
  attestation only for submissions that cleared that check.

  This replaced admin review of an uploaded Bizfile. That check did not
  establish ownership: an **ACRA business profile is a public record any
  person can buy for S$5.50**, so the evidence behind an attestation cost
  an attacker S$5.50. Document review addresses forgery; it cannot
  address impersonation, where the document is genuine and the claimant
  is not the owner. The micro-deposit addresses impersonation directly,
  and is a challenge Quay issues rather than evidence the claimant
  selects.

  Residual risks: code entry is capped at 5 attempts per hour and the
  counter **fails closed**, because it is the only thing between a
  guesser and someone else's UEN. Codes expire, and expiry is required
  rather than cosmetic — an unexpired abandoned claim would hold a real
  business's UEN hostage via the uniqueness index. ACRA data is used for
  autofill and to supply the payout address; it is never a gate, since
  the register refreshes monthly and a newly incorporated company is
  legitimately absent.
- **Payout redirection can be detected but NOT prevented.**
  `update_merchant_address` (`payments.move:372`) asserts only that the
  caller currently holds the entry, and Sui's compatible-upgrade rules
  forbid changing an existing public function's signature, so no
  attestation can be demanded of it; a v2 function would leave v1
  callable forever. The adversary here is the caller, so an application
  check stops nobody. `/api/cron/payout-watch` watches the
  `MerchantAddressUpdated` event and alerts, which shrinks
  time-to-discovery but is not a control. Recovery for a wrongly-held UEN
  (`admin_reassign_merchant`) is designed and deferred; see TODOS.md.
- **The Sui Move code has not been independently audited.** Required
  before mainnet ($25–50k, 4–6 weeks lead time, OtterSec / MoveBit /
  Zellic recommended).
- **No bug bounty until post-mainnet.** Targeted Immunefi-tier-1
  program planned ($10k starter pool).
- **No formal Singapore counsel opinion** on PSA / DPT-SP scope. The
  V0 design memo argues that quay-as-protocol is NOT a payment service
  (no custody, no fiat conversion) but a counsel opinion is required
  before mainnet.

## Hardening checklist (pre-mainnet)

- [ ] Move audit (OtterSec / MoveBit / Zellic)
- [ ] Migrate issuer key to 2-of-3 multisig via `rotate_issuer_pubkey`
- [ ] Move `AdminCap` to multisig as well (separate from issuer)
- [x] Manual review gate for issuer attestations (KYB doc review via `/admin/kyb`, shipped)
- [ ] CCTP-native USDC migration (Wormhole → Circle)
- [ ] Singapore counsel opinion on PSA / DPT-SP scope
- [ ] Indexer hardening (self-hosted vs Shinami/BlockVision evaluation)
- [ ] Sponsor wallet hardening: hardware key, daily spend alarm,
      auto-pause on anomaly
- [ ] Bug bounty program launch

## Known V0 caveats

| Concern | V0 state | V1 plan |
|---|---|---|
| Issuer key compromise | Single ed25519 key in `.secrets/` | Multisig via `rotate_issuer_pubkey` |
| Spam claims | Manual KYB review gate; partial-unique-index blocks dup pending per wallet and dup active per UEN | NETS-controlled signer / BizFile+ federation for further automation |
| Sponsor wallet drainage | 5/day per-claimer rate limit, 20% balance floor | Captcha + per-IP rate limit + auto-faucet |
| `pay<T>` slippage from off-chain Pyth quote | UI shows the rate the user accepted; on-chain settlement uses whatever Coin the wallet sends | Day 5.5+ Cetus on-chain swap with `amount_limit` slippage cap |
| Phishing site impersonation | None — single deploy at quay.com (when mainnet) | DNSSEC + HSTS + Tag 59 strict allowlist on rendered names (AD29) |
| Mobile-number PayNow gap | Not supported in V0 | `PAYNOW_MOBILE_V1` namespace via the domain-tag scheme |
| Merchant cash-out custody (Wise rail) | **Custodial demo.** `/api/cashout/*` briefly holds the merchant's USDsui in a Quay treasury (`.secrets/treasury-mainnet.json`) between the on-chain transfer and a Wise PayNow SGD payout funded from a Quay float. Defaults to `WISE_ENV=sandbox` (no real money) and the `cashout_enabled` flag is off by default; **live (`WISE_ENV=live`) is a deliberate config flip** intended only for controlled own-funds payouts, bounded by a per-tx cap (`CASHOUT_MAX_SGD_MINOR`, default S$50) + 10/day per-address limit. | V2 non-custodial licensed leg (StraitsX PayNow settlement or Bridge/Stripe issuer redemption); delete the demo (see TODOS). |
| Merchant cash-out (Coinbase rail) | **Non-custodial.** The merchant sells USDC from their own address into their own KYC'd Coinbase account; Quay mints session tokens and builds the send but never holds funds. Off by default behind `coinbase_offramp_enabled`, and additionally bounded by a per-tx cap (`COINBASE_OFFRAMP_MAX_SGD_MINOR`), a daily cap (`COINBASE_OFFRAMP_DAILY_CAP`, **0 = disabled, and 0 is the default**), and a one-open-cash-out-per-owner index. **There is no Coinbase offramp sandbox** — any end-to-end test is real money against production. | Evaluate Bridge/Stripe redemption at par (removes the swap leg, ends in a bank rather than a Coinbase balance). See TODOS. |
| Coinbase offramp abandonment | Signing is **client-only** — `zkLoginSign` needs a key that exists only in the merchant's browser, so no server or cron can fill an order. A merchant who completes the Coinbase widget and then closes the tab before sending leaves an order Quay cannot complete on their behalf; the reconcile cron only settles rows that already sent. | Unrecoverable by design, not by omission — the alternative is server-side custody of a signing key. Surfaced to the merchant rather than retried silently. |

### The two cash-out rails differ in custody, and only one is custodial

There are two money-out-to-fiat paths on `/app/merchant/wallet`, and they are
not variations on one design:

- **Coinbase CDP offramp** (`/api/offramp/coinbase/*`) — **non-custodial**. The
  merchant sells USDC out of their own address into their own KYC'd Coinbase
  account. Quay mints session tokens and builds the swap+send; it never holds
  the funds. Gated OFF by `coinbase_offramp_enabled`.
- **Wise PayNow demo** (`/api/cashout/*`) — **custodial**, and the only
  custodial path in quay. Described below.

Three properties of the Coinbase rail are load-bearing and easy to regress:

1. **Authorisation is on-chain registry membership, not a signed nonce.** The
   obvious design fails twice: `zkLoginSign` cannot sign an arbitrary message
   (it wraps a TransactionData-intent signature), and proving control of a
   zkLogin address is not an abuse control anyway — any Google account yields
   one, so an attacker can mint addresses freely. The meaningful gate is
   whether the address owns a registered UEN in `MerchantRegistry`: scarce
   (it requires passing KYB and an issuer attestation), exactly the population
   allowed to cash out, and unforgeable. A successful check mints a
   short-lived Quay token so the polling and prepare calls need not re-read
   the chain. See [`frontend/src/lib/server/coinbase-auth.ts`](frontend/src/lib/server/coinbase-auth.ts).
2. **Signing is client-only.** No server path and no cron can fill an order.
   This is why the widget opens with `window.open` rather than a redirect (a
   redirect can lose the session) and why the reconcile cron only settles rows
   that already sent.
3. **The USDC amount is derived from a live Cetus quote, never chosen first.**
   Committing a `sell_amount` to Coinbase and *then* discovering the swap
   cannot be funded puts an uncontrollable dependency after an irreversible
   commitment.

Two disclosure points that copy must respect: **Singapore has no Coinbase bank
payout rail** (`payment_methods = CRYPTO_ACCOUNT, FIAT_WALLET`), so Coinbase
pays into the merchant's Coinbase *balance* — never imply Quay settles to a
bank. And **there is no offramp sandbox**, so any end-to-end verification is
real money against production Coinbase.

The Coinbase rail is therefore **not parity** with the Wise demo and does not
by itself unblock deleting it: it ends in a Coinbase balance rather than a bank
account, and requires each merchant to hold a KYC'd Coinbase SG account.

### The Wise cash-out demo

The Wise cash-out flow is the only custodial path in quay. Code defaults are
inert — sandbox payouts, flag off — so the repo ships moving no real money;
going live is an explicit operator decision (`WISE_ENV=live` + a live Wise
token + flipping `cashout_enabled`), and is intended only for an operator
cashing out their **own** funds to their **own** account. Paying third-party
merchants for real is the licensed V2 path, not this. Guards on the live
path: a per-transaction SGD cap (`CASHOUT_MAX_SGD_MINOR`), a 10/day
per-address limit, and the `cashout_enabled` kill switch. It does not
displace the non-custody model: payments, refunds, settlement-preference, and
the **withdraw-to-address** flow (`/api/sponsor/withdraw`) are all fully
non-custodial. Cash-out verifies the on-chain receipt before any payout, is
idempotent on the Sui tx digest (no double-pay), and surfaces stuck rows as
"payout pending" for recovery via `scripts/cashout-redrive.ts` rather than
failing silently.

## Code structure that matters

The trust-critical Move surface is small:

- [`move/quay/sources/payments.move`](move/quay/sources/payments.move)
  — ~517 LOC. `register_merchant`, `set_initial_issuer_pubkey`,
  `rotate_issuer_pubkey`, and the BCS `ClaimMessage` shape are the
  load-bearing pieces. `pay` and `refund` are essentially
  emit-and-forward.

The trust-critical server surface is also small:

- [`frontend/src/lib/server/issuer.ts`](frontend/src/lib/server/issuer.ts)
  — loads the issuer secret from env/`.secrets/`.
- [`frontend/src/lib/server/sponsor.ts`](frontend/src/lib/server/sponsor.ts)
  — same pattern for the sponsor secret.
- [`frontend/src/app/api/attest/route.ts`](frontend/src/app/api/attest/route.ts)
  + [`frontend/src/lib/server/kyb-attestation.ts`](frontend/src/lib/server/kyb-attestation.ts)
  — the only two server paths that can produce a signed attestation or
  a sponsored gas signature. The KYB helper is called by
  [`frontend/src/app/api/kyb/finalize/route.ts`](frontend/src/app/api/kyb/finalize/route.ts)
  only after the admin has approved a submission via
  [`frontend/src/app/api/admin/kyb/[id]/decide/route.ts`](frontend/src/app/api/admin/kyb/[id]/decide/route.ts).
- [`frontend/src/lib/server/admin-auth.ts`](frontend/src/lib/server/admin-auth.ts)
  — wallet-signed challenge → HttpOnly cookie, allowlist re-checked per
  request. Same JWT signing key (`ADMIN_JWT_SECRET`) used for merchant
  polling tokens in
  [`frontend/src/lib/server/polling-token.ts`](frontend/src/lib/server/polling-token.ts).
- [`frontend/src/lib/server/coinbase-auth.ts`](frontend/src/lib/server/coinbase-auth.ts)
  — the registry-membership gate on the Coinbase offramp routes, plus the
  short-lived token it mints. Read the header before changing it; the
  rejected alternatives are documented there and both are dead ends.
- [`frontend/src/lib/server/coinbase-offramp.ts`](frontend/src/lib/server/coinbase-offramp.ts)
  + [`frontend/src/lib/server/coinbase-offramp-store.ts`](frontend/src/lib/server/coinbase-offramp-store.ts)
  — CDP session/quote calls and the cash-out state machine, including the
  caps and the one-open-cash-out-per-owner index.

If you're auditing, start there.

**Known gap, deliberately not reproduced.** `/api/cashout/*` and
`/api/sponsor/*` have **no authentication** — `owner` is client-supplied and
regex-validated only. That hole is pre-existing. The Coinbase routes do not
reproduce it (they gate on registry membership, above); retrofitting the same
gate to the older routes is tracked in TODOS.

## KYB key custody

The KYB review flow introduces one new long-lived secret: the admin's
mnemonic-backed Sui wallet seed. Everything else is derived.

### Construction

The admin runs `/admin/setup` once, which:

1. Asks the wallet to sign the bytes `"QUAY_KYB_DECRYPT_KEY_V1"` via
   `signPersonalMessage`. Sui ed25519 signatures are deterministic per
   RFC 8032, so the same wallet always produces the same signature.
2. Strips the 1-byte Sui scheme flag and the trailing pubkey from the
   serialized signature, leaving the raw 64-byte ed25519 sig.
3. Runs HKDF-SHA256(IKM=raw_sig, salt=empty, info=UTF-8 of
   `"QUAY_KYB_DECRYPT_KEY_V1"`, L=32) → 32-byte seed.
4. Applies RFC 7748 X25519 clamping → X25519 private key.
5. Computes the X25519 public key via `crypto_scalarmult_base`.

The public key goes into `ADMIN_KYB_PUBKEY` env. Merchant browsers wrap
their per-doc DEK to that pubkey via NaCl `crypto_box_seal`. The
**private key is re-derived from the same wallet signature on every
admin session** — it is never written to disk, never sent to the
server, never persisted to localStorage. The wallet seed is the only
long-lived secret.

### Threats

| Threat | Impact | Mitigation |
|---|---|---|
| Admin wallet seed compromise | Attacker can derive the X25519 priv key, decrypt every pending and historical wrapped DEK in Supabase, and pass admin auth. **Full game over.** | Store seed in 1Password + a sealed envelope. Same gravity as the issuer ed25519 key. |
| Admin wallet seed loss | All currently-pending DEKs become unrecoverable. Existing approved/finalized merchants are unaffected (their evidence_hash is already on chain). | Document recovery: rotate `ADMIN_KYB_PUBKEY` to a new wallet, reject all pending submissions, merchants resubmit. |
| `ADMIN_KYB_PUBKEY` env tampering on the server | Merchants would wrap DEKs to an attacker pubkey; future submissions decryptable by attacker. | Server compromise is out of scope of this layer (same threat model as the issuer ed25519 key already in env). Admins are advised to verify their derived pubkey matches `/api/admin/kyb/[id]` returns via the pubkey-mismatch check baked into `/admin/kyb/[id]`. |
| Browser extension / XSS on admin domain | Could read the X25519 priv key from JS memory during a review session. | Mitigations: short session (Lock button + tab close clears memory), no third-party scripts on `/admin/*`, single-admin-on-own-laptop threat profile. Hardening path: WebAuthn PRF-derived unlock when daily review volume justifies the build. |
| zkLogin admin | Would break determinism (ephemeral keys per session). | **Admin wallet must be mnemonic-backed ed25519** (Sui Wallet extension, Suiet, etc.) — NOT zkLogin. Enforced by an explicit scheme-flag check in `lib/kyb/crypto.ts`. |

### Auditor entry points for the KYB surface

- [`frontend/src/lib/kyb/crypto.ts`](frontend/src/lib/kyb/crypto.ts)
  — all client-side crypto (encrypt/decrypt, wrap/unwrap, key
  derivation, scheme-flag handling). 79 unit tests cover the
  primitives.
- [`frontend/src/app/admin/setup/page.tsx`](frontend/src/app/admin/setup/page.tsx)
  — the one-off bootstrap UI. Has no server-side counterpart and grants
  no privileges; signing here only displays a pubkey for the operator
  to paste into env.
- [`supabase/migrations/20260517_kyb_submissions.sql`](supabase/migrations/20260517_kyb_submissions.sql)
  — table schema, RLS policies (service-role-only at every CRUD verb),
  and the two partial unique indexes that race-protect the queue.
