# Contributing to quay

Thanks for the interest. This is a hackathon submission first and a real
codebase second — if you're poking at it before mainnet ships, expect rough
edges.

## Quickstart for contributors

```bash
brew install sui pnpm
git clone <repo>
cd quay

# 1. Move
cd move/quay
sui move build       # 0 errors expected
sui move test        # 18 / 18 expected

# 2. Frontend
cd ../../frontend
pnpm install
pnpm test            # bun test src/lib — 54 / 54 expected
pnpm exec tsc --noEmit  # 0 errors expected
pnpm build           # 6 static + 2 dynamic routes expected
pnpm dev             # http://localhost:3000
```

If any of those fail on a clean clone, open an issue with the full
output.

## What to work on

Sorted by **how much it advances the demo or unblocks mainnet**:

1. **Gasless quick-pay (no-receipt retail path)** — Sui's protocol-level
   gasless stablecoin transfers are **live on mainnet** (v125, 2026-05-20)
   via [`0x2::coin::send_funds`](https://docs.sui.io/develop/transaction-payment/gasless-stablecoin-transfers);
   USDsui is allowlisted. **Withdraw-everything already uses it**
   (`buildGaslessUsdsuiSendAll`, see `src/lib/quay/transfer.ts` +
   `scripts/gasless-withdraw-spike.ts`). The remaining piece is a gasless
   *payment* path for sub-$10 retail tickets where the rich `PaymentReceipt`
   isn't required — because any custom moveCall (the receipt event)
   disqualifies a PTB from gasless, so this must be a separate code path
   from `payments::pay<T>`, which stays for GST-reportable receipted
   payments. Dual-path frontend; merchant terminal subscribes to both.
   Note the constraint: gasless allows no object writes / no split, so a
   gasless pay sends whole coins (or relies on the payer holding an exact
   coin).
2. **Cetus swap-and-pay PTB** — Move contract is `Coin<T>`-generic; the
   missing piece is the frontend PTB that pulls a SUI→USDsui swap from
   a Cetus pool right before the `pay` call. See
   [`scripts/cetus-testnet.json`](scripts/cetus-testnet.json) for the
   pre-cataloged pool registry IDs. Probably needs the
   `cetus_clmm::pool::flash_swap` flash-swap pattern plus
   `repay_flash_swap` in the same PTB to avoid an intermediate Coin
   custody hop.
3. **USDsui mainnet settlement** — when USDsui lands on testnet (or we
   move directly to mainnet for V0.5), swap the default
   `COIN_TYPES.SUI` → USDsui in the pay path. Pure constant change in
   [`frontend/src/lib/quay/pay.ts`](frontend/src/lib/quay/pay.ts); no
   on-chain redeploy.
4. **Real-photo SGQR field test (AD5)** — the `SgqrCameraScanner` is
   wired and tuned (`facingMode: environment`, `TRY_HARDER`, reticle
   sized to the 10:1 rule for a 50mm SGQR at 30cm), but the spec
   demands ≥20 real Singapore SGQR photos × lighting conditions before
   we can claim camera reliability for the V0 submission.
5. **Mobile-number PayNow support** — the domain-tag scheme
   (`PAYNOW_UEN_V1` vs future `PAYNOW_MOBILE_V1`) is already in place on
   chain. Frontend needs to parse proxy type `0` (currently flagged as
   "not supported in V0") and surface a mobile-number registration
   path. ~70% of SG hawkers use mobile-number PayNow.
6. **SuiNS optional name attach** — small enhancement; show
   "kopihouse.sui" instead of `0x7840…3360` on /scan and
   /merchant/terminal.
7. **Multisig issuer migration** — currently single-key. V1 must rotate
   to 2-of-3 (or m-of-n) via the existing `rotate_issuer_pubkey` entry.

## Commit + PR style

- One logical change per commit; conventional-commits-ish prefix
  (`feat(scope):`, `fix(scope):`, `docs:`, `chore:`).
- Reference the relevant AD (auto-decision) or design-doc section when
  the change has a non-obvious rationale.
- Move changes must keep `sui move build` + `sui move test` green; CI
  is not set up yet, run locally.
- Frontend changes must keep `pnpm exec tsc --noEmit` + `pnpm build` +
  `bun test src/lib` green.

## Security disclosures

See [`SECURITY.md`](SECURITY.md). Do NOT open public issues for
vulnerabilities.

## What NOT to merge

- Anything that adds a custodial path (quay holding user keys / coins).
  The whole point of this protocol is that quay never custodies user
  funds.
- Anything that hardcodes mainnet contract addresses without a
  documented multisig rotation plan for the issuer key.
- Anything that removes the AD48 ("Why not just off-ramp?") section
  from the README. That's the demo's load-bearing answer to the most
  common skeptic question.
