# Contributing to suiqr

Thanks for the interest. This is a hackathon submission first and a real
codebase second — if you're poking at it before mainnet ships, expect rough
edges.

## Quickstart for contributors

```bash
brew install sui pnpm
git clone <repo>
cd suiqr

# 1. Move
cd move/suiqr
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

1. **Cetus swap-and-pay PTB** — Move contract is `Coin<T>`-generic; the
   missing piece is the frontend PTB that pulls a SUI→USDC swap from a
   Cetus pool right before the `pay` call. See
   [`scripts/cetus-testnet.json`](scripts/cetus-testnet.json) for the
   pre-cataloged pool registry IDs. Probably needs the
   `cetus_clmm::pool::flash_swap` flash-swap pattern plus
   `repay_flash_swap` in the same PTB to avoid an intermediate Coin
   custody hop.
2. **Camera scanning** — `frontend/src/lib/sgqr/` already handles the
   parse. What's needed is a `<CameraInput>` component using
   `@zxing/browser` that feeds the parser. Plus a field-test pass per
   AD5: ≥20 real Singapore SGQR photos × lighting conditions.
3. **Mobile-number PayNow support** — the domain-tag scheme
   (`PAYNOW_UEN_V1` vs future `PAYNOW_MOBILE_V1`) is already in place on
   chain. Frontend needs to parse proxy type `0` (currently flagged as
   "not supported in V0") and surface a mobile-number registration path.
4. **zkLogin merchant signup** — scaffolded in
   [`docs/GOOGLE_OAUTH_SETUP.md`](docs/GOOGLE_OAUTH_SETUP.md). Needs a
   Google OAuth client + the Mysten prover service plumbing.
5. **SuiNS optional name attach** — small enhancement; show
   "kopihouse.sui" instead of `0x7840…3360` on /scan and
   /merchant/terminal.
6. **Multisig issuer migration** — currently single-key. V1 must rotate
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

- Anything that adds a custodial path (suiqr holding user keys / coins).
  The whole point of this protocol is that suiqr never custodies user
  funds.
- Anything that hardcodes mainnet contract addresses without a
  documented multisig rotation plan for the issuer key.
- Anything that removes the AD48 ("Why not just off-ramp?") section
  from the README. That's the demo's load-bearing answer to the most
  common skeptic question.
