# Demo-day dress rehearsal

5-minute runbook for the suiqr Sui Overflow submission demo.

## Pre-demo (do this once, day-of, before judges arrive)

1. **Boot the dev server**

   ```bash
   cd /Users/ryan/projects/suiqr/frontend
   pnpm dev
   ```

   Verify [http://localhost:3000](http://localhost:3000) loads.

2. **Confirm sponsor wallet is funded** (≥ 0.05 SUI; ~10 sponsored
   registrations remaining):

   ```bash
   cd /Users/ryan/projects/suiqr/scripts
   bun run day7-create-sponsor.ts
   ```

   Tops up automatically from the dev wallet if below the 0.2 SUI
   target. If both dev AND sponsor are low, request testnet faucet:

   ```bash
   ADDR=$(sui client active-address)
   curl -X POST 'https://faucet.testnet.sui.io/v2/gas' \
     -H 'Content-Type: application/json' \
     -d "{\"FixedAmountRequest\": {\"recipient\": \"$ADDR\"}}"
   ```

3. **Confirm demo merchants are registered**:

   ```bash
   bun run day11-stage-demo.ts
   ```

   Should print "already registered — skipping" for all three. If not,
   it'll register them fresh (still safe).

4. **Open Sui Wallet (or Slush) on testnet** and have a funded address
   ready to act as the payer.

## The 5-minute demo

### Act 1 — payer flow (90 seconds)

1. **Open /scan** ([localhost:3000/scan](http://localhost:3000/scan)).
2. **Paste the KOPI HOUSE SGQR string** from `scripts/demo-fixtures.json`
   (look for `merchants[0].sgqr_static`). It's a long string starting
   with `0002010102...`.
3. **Point out the parsed view**:
   - "KOPI HOUSE" extracted from EMVCo tag 59
   - CRC validates (green badge)
   - PayNow UEN `T11KH0001A` parsed out
   - On-chain lookup confirms the merchant is registered (auto-resolves
     within ~1s of paste)
4. **Type $3.50 in the amount box**. Live Pyth quote appears under it:
   "≈ 0.95 SUI · 1 USD = 1.27 SGD · 1 SUI = $X.XX · live (Ns ago)".
5. **Optional memo**: type "kopi-o + kaya toast".
6. **Click Pay**. Sui Wallet pops up, show the tx preview, approve.
7. **Wait for success state** (~2-3s). Click the suiscan link — show
   the `PaymentReceipt` event in the explorer with `sgd_minor_units:
   350` and the memo.

### Act 2 — merchant terminal (60 seconds)

1. **Open /merchant/terminal in a second tab** while still connected
   as the payer wallet (terminal expects to be the merchant — so
   actually disconnect first and reconnect to the demo merchant
   wallet, OR open in an incognito window with the merchant wallet).
2. **Show the live "Today: $3.50 SGD" header** with the pulsing green
   dot.
3. **Show the receipt card** with the payer address, SUI amount,
   "kopi-o + kaya toast" memo, and timestamp.
4. **Run a second payment from /scan** (different fixture, different
   amount — try CHICKEN RICE at $5.00). Watch the terminal update in
   real time (~2s after on-chain finality).

### Act 3 — merchant onboarding with sponsored gas (90 seconds)

This is the marquee composability story.

1. **Open Sui Wallet, create a fresh address** ("New Account").
2. **Confirm 0 SUI** in the new wallet.
3. **Open /merchant/onboard**, connect the fresh wallet.
4. **Type a fresh UEN** (e.g., `T11DEMO99X`).
5. **Confirm "Use sponsored gas" is checked**.
6. **Click Sign + submit**. Wallet pops up once for the signature
   only. Approve.
7. **Show the success card** — "Registered on testnet · sponsor paid
   gas".
8. **Verify the fresh wallet is STILL at 0 SUI** (open the wallet,
   refresh balance). Drives home that suiqr's sponsor covered the gas.

### Wrap (30 seconds)

- Open the README's "Why not just off-ramp?" section. Read the
  payer-side + merchant-side differentiators bullets.
- Open the [`scripts/deploy-testnet.json`](../scripts/deploy-testnet.json)
  file. Show the live testnet contract IDs.
- Show [`scripts/cetus-testnet.json`](../scripts/cetus-testnet.json) —
  Cetus pool IDs cataloged for the V0.5 swap-and-pay add-on.

## Demo failure recovery

| Symptom | Cause | Fix |
|---------|-------|-----|
| `/scan` paste shows "not registered" for a demo UEN | demo merchants never landed | run `day11-stage-demo.ts` again |
| Pay button disabled with "stale" Pyth | Hermes outage > 60s | wait or refresh; the underlying flow still works |
| Wallet sign rejected | user closed popup | retry — state machine handles retry cleanly |
| Sponsor returns 503 | sponsor balance < 20% floor | `day7-create-sponsor.ts` tops up |
| Terminal stays empty after a pay | wallet connected ≠ merchant address | reconnect to the demo-merchant wallet (see `.secrets/demo-merchant.json`) |

## Talking points for Q&A

These are pre-baked from the build plan's AD48 ("Why not just off-ramp?"):

- **"Why not just use PayNow + Coinhako?"** — PayNow works for 99% of
  SG users. We target the crypto-native 1% who want non-custodial
  payment without KYC at point of sale, and merchants who want lower
  fees than Visa MDR + self-custody of USDC + structured on-chain
  receipts for GST reporting.
- **"What about hawkers without UEN?"** — V0 is UEN-only. Mobile-number
  PayNow (~70% of SG hawkers) is V1+. Mentioned honestly in the README.
- **"Mainnet swap?"** — Move contract is generic over `Coin<T>`.
  Mainnet adds a Cetus swap step in the same PTB to settle non-SUI
  source tokens as USDC. Testnet Cetus liquidity is the only reason
  it's not in the V0 demo (we cataloged the IDs but deferred the
  flash-swap PTB to a focused session).
- **"Centralization?"** — V0 has a single ed25519 issuer key (suiqr).
  V1 rotates to multisig / DAO via `rotate_issuer_pubkey` (gated by
  AdminCap). The Move contract supports this on day one.
- **"Why blake2b256 not keccak?"** — Sui Move's `sui::hash::blake2b256`
  is the canonical hash (Move framework 1.20+). Keccak is also
  available; blake2b is the cross-chain-friendly default.
