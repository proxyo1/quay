# Security policy

suiqr is a hackathon submission on Sui testnet. There is no mainnet
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

### What suiqr promises

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
- **No suiqr-custody of user funds** — merchants own their address;
  payers pay directly; suiqr never holds anyone's coins.

### What suiqr does NOT promise (V0)

- **The issuer key is single-key.** Compromise of
  `.secrets/issuer-testnet.json` (or the prod equivalent) lets the
  holder mint arbitrary attestations. V1 migrates to a multisig via
  `rotate_issuer_pubkey(cap, registry, new_pubkey, clock)`.
- **The V0 attestation route auto-signs** for any well-shaped UEN +
  claimer address. There is no SGQR-photo or BizFile+ review yet —
  production gates this manually.
- **The Sui Move code has not been independently audited.** Required
  before mainnet ($25–50k, 4–6 weeks lead time, OtterSec / MoveBit /
  Zellic recommended).
- **No bug bounty until post-mainnet.** Targeted Immunefi-tier-1
  program planned ($10k starter pool).
- **No formal Singapore counsel opinion** on PSA / DPT-SP scope. The
  V0 design memo argues that suiqr-as-protocol is NOT a payment service
  (no custody, no fiat conversion) but a counsel opinion is required
  before mainnet.

## Hardening checklist (pre-mainnet)

- [ ] Move audit (OtterSec / MoveBit / Zellic)
- [ ] Migrate issuer key to 2-of-3 multisig via `rotate_issuer_pubkey`
- [ ] Move `AdminCap` to multisig as well (separate from issuer)
- [ ] Manual review gate for `/api/attest` (SGQR-photo + BizFile+)
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
| Spam claims | Auto-issued for valid-shaped UEN | Manual review or NETS-controlled signer |
| Sponsor wallet drainage | 5/day per-claimer rate limit, 20% balance floor | Captcha + per-IP rate limit + auto-faucet |
| `pay<T>` slippage from off-chain Pyth quote | UI shows the rate the user accepted; on-chain settlement uses whatever Coin the wallet sends | Day 5.5+ Cetus on-chain swap with `amount_limit` slippage cap |
| Phishing site impersonation | None — single deploy at suiqr.com (when mainnet) | DNSSEC + HSTS + Tag 59 strict allowlist on rendered names (AD29) |
| Mobile-number PayNow gap | Not supported in V0 | `PAYNOW_MOBILE_V1` namespace via the domain-tag scheme |

## Code structure that matters

The trust-critical Move surface is small:

- [`move/suiqr/sources/payments.move`](move/suiqr/sources/payments.move)
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
  + [`frontend/src/app/api/sponsor/register/route.ts`](frontend/src/app/api/sponsor/register/route.ts)
  — the only two server entry points that can produce a signed
  attestation or a sponsored gas signature.

If you're auditing, start there.
