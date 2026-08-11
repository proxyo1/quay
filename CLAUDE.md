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
  `sources/payments.move` (~520 LOC), tests in `tests/payments_tests.move` (24 tests).
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
  The off-chain BCS shape (`frontend/src/lib/server/kyb-attestation.ts`, `bcs.struct("ClaimMessage", …)`:
  domain_tag `b"QUAY_CLAIM_V1"`, chain_id, uen, claimer, nonce, expires_at_ms, evidence_hash) **must stay
  byte-for-byte in sync with the Move `ClaimMessage` struct** — reorder a field or change a type on one
  side and every attestation silently fails ed25519 verification (`E_INVALID_ATTESTATION`).
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

- **Withdraw USDsui to an address** — fully non-custodial, two modes (both in `src/lib/quay/transfer.ts`):
  - *Withdraw everything (default)* → **gasless**: `buildGaslessUsdsuiSendAll` emits one
    `0x2::coin::send_funds` per coin, gas=0, merchant zkLogin-signs alone (no sponsor, no
    server round-trip, no SUI). Uses Sui's protocol gasless stablecoin transfers (mainnet
    v125; USDsui allowlisted). Verified by `scripts/gasless-withdraw-spike.ts`.
  - *Partial amount* → sponsored `/api/sponsor/withdraw` → `buildSponsoredUsdsuiTransfer`
    (merges the merchant's fragmented coins then splits; gasless can't split).
- **Cash out USDsui → SGD** — a deliberately throwaway, **custodial demo** (the only custodial
  path in the app). `/api/cashout/{quote,initiate,confirm}` send USDsui to a treasury
  (`src/lib/server/treasury.ts`, key in `.secrets/treasury-mainnet.json`), then pay SGD via
  Wise PayNow (`src/lib/server/wise.ts`) out of a pre-funded float. State machine in the
  `cashout_requests` table (`src/lib/server/cashout-store.ts`); 25 bps fee + FX math in
  `cashout-fee.ts`. Gated by the `cashout_enabled` feature flag (off by default). `WISE_ENV`
  defaults to `sandbox`; `live` is a deliberate flip bounded by `CASHOUT_MAX_SGD_MINOR` +
  a 10/day cap. Stuck payouts are recoverable via `scripts/cashout-redrive.ts`. Slated for
  deletion when the licensed V2 settlement leg lands (see TODOS) — do not build on it.

### Coinbase CDP Offramp (`/app/merchant/wallet`, flag-gated OFF)

A second, **non-custodial** cash-out rail alongside the Wise demo. The merchant sells USDC from
their own address into their own KYC'd Coinbase account; Quay mints session tokens and builds the
send, never holding funds. Gated by `coinbase_offramp_enabled` (off by default).

Flow: quote → (redeem from Scallop if needed) → widget in a **new window** → poll for the deposit
address → sponsored swap+send. Files: `lib/server/coinbase-{offramp,offramp-store,auth}.ts`,
`lib/quay/swap-to-usdc.ts`, `app/api/offramp/coinbase/{session,prepare,status}`,
`app/api/cron/coinbase-reconcile`, `app/app/merchant/wallet/CoinbaseOfframpSection.tsx`.

Non-obvious, all load-bearing:

- **The USDC amount is derived from a live Cetus quote**, never chosen first. Committing a
  `sell_amount` to Coinbase and then discovering the swap can't be funded puts an uncontrollable
  dependency after an irreversible commitment.
- **`offramp_url` from the Sell Quote API is always an empty string** (verified across every request
  shape). The widget URL is constructed against `pay.coinbase.com/v3/sell/input`, with `disableEdit`
  — without it the merchant can commit to more USDC than they freed up.
- **SG has no bank payout rail** (`payment_methods = CRYPTO_ACCOUNT, FIAT_WALLET`). Coinbase pays into
  the merchant's Coinbase *balance*. Copy must never imply Quay settles to a bank.
- **Signing is client-only.** No server or cron can fill an order — `zkLoginSign` needs a key that
  exists only in the merchant's browser. Abandon-before-send is therefore unrecoverable, the widget
  opens with `window.open` (a redirect can lose the session), and the reconcile cron only settles rows
  that already sent.
- **Auth is on-chain registry membership**, not a signed nonce: `zkLoginSign` cannot sign an arbitrary
  message, and anyone can mint a zkLogin address anyway.
- Run `scripts/coinbase-offramp-probe.ts` to re-verify the corridor; output lands in
  `docs/coinbase-offramp-probe.md`.

### Merchant yield routing (Scallop)

Opt-in from the wallet (`/api/sponsor/{toggle-yield,earn-move}`): when a merchant enables it,
the `pay<T>` PTB mints the settled USDsui into Scallop's lending reserve, so the merchant holds
`Coin<SCALLOP_USDSUI>` (the wrapped sCoin) instead of `Coin<USDsui>`. `pay<T>` is type-generic,
so this is a PTB/frontend change, not a Move change. All Scallop logic lives in
`src/lib/quay/scallop.ts` — **no `@scallop-io` SDK** (deliberately; it's too heavy for the four
PTB calls we need). Non-obvious facts, all load-bearing:

- **`TYPE_PACKAGE` vs `CALL_PACKAGE`.** Scallop upgrades its package opaquely. Type identifiers
  (e.g. `${TYPE_PACKAGE}::reserve::MarketCoin<T>`) stay pinned to the original publish ID forever;
  the *call target* is the latest upgrade. Never collapse the two. The live call package is read
  from Supabase `feature_flags.metadata.last_seen_package` (with `DEFAULT_CALL_PACKAGE` as fallback);
  same pattern for the separate sCoin-converter package.
- **Use the OLD main market** (`MARKET_OBJECT`) — it's the only one that lists USDsui. A second
  market exists but doesn't carry USDsui.
- **Gated by the `yield_routing.scallop.usdsui` feature flag** (off until Vercel env is configured).
  Every payment is additionally gated on a 30s-cached `preflightScallopHealthy` (AllowAll whitelist
  + supply-cap headroom).
- **`/api/cron/scallop-monitor`** (weekly) auto-flips the flag `enabled=false` on hard anomalies
  (whitelist→RejectAll, reserve delisted, supply cap full) but treats package upgrades as a soft
  observation (records the new call package, doesn't flip). `/api/cron/scallop-cost-basis-indexer`
  (daily) tracks cost basis for the redeem-side fee.
- **Live supply APY** for the wallet's "Earn interest" card comes from `/api/scallop/apy` (cached
  server proxy of Scallop's public market endpoint, matched by `coinType`) — it's *gross* APY, not
  net of the cost-basis fee.

### Trust boundary

The issuer ed25519 key (`.secrets/issuer-testnet.json`, gitignored) is the root of trust — whoever
holds it can mint arbitrary merchant attestations. It is single-key in V0 (multisig is the
documented V1 migration). It must only ever be touched server-side via `/api/attest` and
`/api/kyb/finalize`. Never move issuer signing into client code.

Both server keys (issuer, sponsor) load with the same precedence: `QUAY_<KEY>_SECRET_KEY_HEX` env →
`QUAY_<KEY>_SECRET_KEY_BECH32` env → `.secrets/<key>-testnet.json` file (`issuer.ts`, `sponsor.ts`).
Use the env-hex path in production; the `.secrets` files are the local-dev fallback produced by
`day2-deploy`/`day7-create-sponsor`. Other server config (Google/Enoki OAuth, Supabase, `ADMIN_WALLETS`,
`ADMIN_KYB_PUBKEY`, `ADMIN_JWT_SECRET`, `CRON_SECRET`, Wise/cashout) lives in `frontend/.env.local` —
there is no committed `.env.example`, so read the consuming module to learn the exact var names.

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
- Never construct a Sui client directly. Get it from `@/lib/sui-client` — `getSuiClient()` for a
  client, `import type { SuiClient }` for the parameter type. It is a `SuiGrpcClient`; the endpoint
  comes from `NEXT_PUBLIC_SUI_GRPC_URL`. **JSON-RPC is dead** — Sui retired it on the public
  fullnodes (mainnet and testnet), so `getJsonRpcFullnodeUrl` points at a host that answers every
  method with `-32601`. `scripts/` have not been ported and are broken for that reason.
- Event history comes from GraphQL (`lib/quay/events.ts`), because gRPC has no event query at all.
  Sui's GraphQL retains only a **recent window** of events, so never derive current state by
  replaying history — read the on-chain object or table instead. Move `vector<u8>` fields arrive
  base64 from GraphQL where JSON-RPC gave `number[]`; run them through `bytesFromEventField`.
- gRPC returns Move struct contents as raw **BCS**, not a parsed `fields` bag. Decoders live in
  `lib/quay/move-bcs.ts` (Quay's structs) and `lib/quay/scallop.ts` (Scallop's). BCS is positional:
  a wrong field order decodes to garbage silently rather than throwing, so validate against mainnet
  (`bun run src/lib/__tests__/grpc-smoke.ts`) after touching one.
- Walrus blobs are versioned: merchant profiles carry `v: PROFILE_SCHEMA_VERSION` and receipts a
  `schema_version` const. Readers fall back to a legacy shape on an unknown version rather than throwing,
  so **bump the constant** when you change a blob schema and keep the legacy read path working.
- `AD##` tags in `payments.move` and server comments (e.g. AD19, AD24) index design/threat-model decisions;
  grep the tag and check SECURITY.md before changing the logic it guards.
