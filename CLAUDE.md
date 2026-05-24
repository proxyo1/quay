# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Quay is a Singapore SGQR → on-chain payment rail on Sui. A payer scans a real SGQR/PayNow
sticker, the app extracts the merchant's UEN, looks up that merchant's on-chain payout address,
and settles a `Coin<T>` payment directly to the merchant — no Quay custody at any point.
Originally a hackathon submission (the repo dir is `suiqr`, the package is `quay`); now deployed
to **Sui mainnet** with testnet artifacts archived.

## Layout

Three independent subprojects, no root package.json:

- `move/quay/` — the `quay::payments` Move 2024 contract. Single source file
  `sources/payments.move` (~340 LOC), tests in `tests/payments_tests.move`.
- `frontend/` — Next.js 16 + React 19 + Tailwind 4 PWA. The whole app *and* the API live here.
- `scripts/` — Bun deploy + smoke-test scripts (`day0`..`day13`, `wise-*`). One-shot ops tooling,
  not application code.
- `supabase/migrations/` — Postgres schema for off-chain state (KYB submissions, issuer audit log,
  feature flags, yield cost basis).

## Commands

Move contract (run from `move/quay/`):
```bash
sui move build            # 0 errors expected
sui move test             # all unit tests must stay green; CI is not set up, run locally
```

Frontend (run from `frontend/`) — **install/dev/build use pnpm, but tests run under Bun**:
```bash
pnpm install
pnpm dev                  # http://localhost:3000
pnpm build
pnpm lint                 # eslint
pnpm exec tsc --noEmit    # typecheck — must be 0 errors before any commit
bun test src/lib          # full unit suite
bun test src/lib/sgqr     # single dir/file — pass a path to scope the run
```
Tests run under Bun, not Next/Jest. `bunfig.toml` preloads `test/setup.ts`, which stubs the
`server-only` package so server-only library code (`admin-auth`, `kyb-store`, `polling-token`, …)
is unit-testable.

Deploy / ops (run from `scripts/`, after `bun install`):
```bash
bun run day2-deploy.ts            # publish + set issuer pubkey + register demo merchant
bun run day7-create-sponsor.ts    # provision the gas-sponsor wallet
bun run day13-cetus-aggregator-smoke.ts  # verify Cetus aggregator routing
```

## Architecture

### The core insight: UEN as registry key

A Singapore business's UEN (from its PayNow SGQR subtag) is the lookup key into the on-chain
`MerchantRegistry`. The registry stores `blake2b256("PAYNOW_UEN_V1" || uen_bytes)` — never the raw
UEN — for privacy. The domain tag (`PAYNOW_UEN_V1`) namespaces the key derivation so future
mobile-number PayNow support can't collide. This is the load-bearing idea; don't break it.

### Move module (`quay::payments`)

One shared `MerchantRegistry` object. `pay<T>` and `refund<T>` are generic over `Coin<T>` so the
same contract handles SUI, USDC, USDsui, and future stables / swap outputs with no redeploy.
Key invariants enforced on-chain (see SECURITY.md threat model):
- `register_merchant` requires an issuer ed25519 attestation over a BCS-encoded `ClaimMessage`.
- Attestations are replay-resistant (32-byte nonce consumed in `used_nonces`), cross-network-safe
  (the message includes `chain_id` — testnet attestation can't replay on mainnet), and expiry-bound.
- `pay<T>` emits `PaymentReceipt` in the *same* PTB as the coin transfer.
- `AdminCap`-gated `rotate_issuer_pubkey` — key rotation never requires a redeploy.

### Settlement token

Default merchant payout is **USDsui**, not USDC. Use USDsui in copy and defaults. The contract is
`Coin<T>`-generic, so changing the settled token is a frontend constants change in
`frontend/src/lib/quay/pay.ts`, not a Move change.

### Frontend structure

- `src/app/app/` — the authed app surface lives under the `/app` namespace (resolves on
  `app.quay.cash`): `/app/scan`, `/app/merchant/{onboard,terminal,wallet,login}`, `/app/admin/kyb`.
  Routing under `/app` is deliberate — don't move admin/merchant routes back to the root.
- `src/app/api/` — server routes. `/api/attest` and `/api/kyb/finalize` hold the **server-only**
  issuer key; `/api/sponsor/*` co-signs gas; `/api/cron/*` are Vercel cron jobs (schedules in
  `vercel.json`).
- `src/lib/` — by domain: `quay/` (PTB builders, lookup, indexer, Scallop yield), `sgqr/` (EMVCo
  TLV parser + CRC16), `dex/` (Cetus aggregator), `pyth/` (price feeds), `zklogin/` (Google OAuth
  merchant onboarding via Enoki), `kyb/` + `server/` (KYB review + issuer attestation), `walrus/`
  (KYB doc storage).
- `src/lib/sui-config.ts` — single source of truth for the active network + deployed object IDs.
  `SUI_NETWORK` is currently `"mainnet"`. Flip network by restoring the matching
  `scripts/deploy-testnet.v{N}.json` block and switching this constant.

### Merchant cash-out + withdraw (`/app/merchant/wallet`)

Two money-out paths added on the wallet page (`MoneyOutSections.tsx`), both reusing the
sponsored dual-sign PTB pattern:

- **Withdraw USDsui to an address** — fully non-custodial. `/api/sponsor/withdraw` →
  `buildSponsoredUsdsuiTransfer` (`src/lib/quay/transfer.ts`, which merges the merchant's
  fragmented USDsui coins before splitting — the single-largest-coin pay path is insufficient
  for accumulated receipts).
- **Cash out USDsui → SGD** — a deliberately throwaway, **custodial demo** (the only custodial
  path in the app). `/api/cashout/{quote,initiate,confirm}` send USDsui to a treasury
  (`src/lib/server/treasury.ts`, key in `.secrets/treasury-mainnet.json`), then pay SGD via
  Wise PayNow (`src/lib/server/wise.ts`) out of a pre-funded float. State machine in the
  `cashout_requests` table (`src/lib/server/cashout-store.ts`); 25 bps fee + FX math in
  `cashout-fee.ts`. Gated by the `cashout_enabled` feature flag (off by default). `WISE_ENV`
  defaults to `sandbox`; `live` is a deliberate flip bounded by `CASHOUT_MAX_SGD_MINOR` +
  a 10/day cap. Stuck payouts are recoverable via `scripts/cashout-redrive.ts`. Slated for
  deletion when the licensed V2 settlement leg lands (see TODOS) — do not build on it.

### Trust boundary

The issuer ed25519 key (`.secrets/issuer-testnet.json`, gitignored) is the root of trust — whoever
holds it can mint arbitrary merchant attestations. It is single-key in V0 (multisig is the
documented V1 migration). It must only ever be touched server-side via `/api/attest` and
`/api/kyb/finalize`. Never move issuer signing into client code.

### Onboarding flow (two-phase, KYB-gated)

Merchant signs in with Google zkLogin → submits KYB docs (stored to Walrus, hash recorded) →
**manual admin review at `/app/admin/kyb`** → on approval, `/api/kyb/finalize` builds a canonical
JCS (RFC 8785) `evidence_content` binding UEN + business name + doc hash + claimer address, the
issuer signs it, the sponsor co-signs gas (rate-limited 5/day per address), and the merchant
submits the sponsored `register_merchant` tx.

## Conventions

- Conventional-commits-ish prefixes: `feat(scope):`, `fix(scope):`, `docs:`, `chore:`. One logical
  change per commit.
- Never add a custodial path (Quay holding user keys or coins) — the protocol's whole premise is
  non-custody.
- Keep the README's "Why not just off-ramp?" section; it's the demo's answer to the top skeptic
  question.
- In docs/copy, write bare section numbers, not `§ NN` decoration.
