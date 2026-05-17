# Security policy

quay is a hackathon submission on Sui testnet. There is no mainnet
deployment and no production users to harm — but the Move contract is
intended to migrate to mainnet, and the trust model below is what
governs that migration.

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
- **The attestation route is now human-gated.** As of the KYB review
  flow, `/api/kyb/finalize` only issues an attestation for submissions
  the admin has explicitly approved via `/admin/kyb`. The merchant
  uploads an encrypted proof-of-ownership document at submission time
  (Bizfile from ACRA, business letterhead, etc.); the admin reviews and
  decides before any signature is minted. See "KYB key custody" below
  for the admin trust model.
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

## Code structure that matters

The trust-critical Move surface is small:

- [`move/quay/sources/payments.move`](move/quay/sources/payments.move)
  — ~290 LOC. `register_merchant`, `set_initial_issuer_pubkey`,
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

If you're auditing, start there.

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
