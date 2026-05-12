# Demo-day dress rehearsal

5-minute runbook for the suiqr Sui Overflow submission demo.

## Pre-demo (do this once, day-of, before judges arrive)

1. **Boot the dev server**

   ```bash
   cd /Users/ryan/projects/suiqr/frontend
   pnpm dev
   ```

   Verify [http://localhost:3000](http://localhost:3000) loads, and
   that the Sign-in-with-Google button on `/merchant/login` is enabled
   (not greyed out). If it's greyed, check
   `frontend/.env.local` has `NEXT_PUBLIC_GOOGLE_CLIENT_ID` set.

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

3. **Confirm payer-side demo merchants are registered** (these power
   Act 1's /scan walk-through — they belong to a separate non-zkLogin
   demo wallet because the on-chain registry only cares about a Sui
   address, not who signed):

   ```bash
   bun run day11-stage-demo.ts
   ```

   Should print "already registered — skipping" for KOPI HOUSE, AH
   HUAT CHICKEN RICE, and WEST COAST PRINT SHOP. If not, it'll register
   them fresh (still safe).

4. **Pre-stage your demoer-side merchant** — the one whose terminal
   you'll show in Act 2. This is a real zkLogin-derived address you
   own.

   - Open `/merchant/login`, sign in with the Gmail account you'll
     demo with (e.g., a `suiqr-demo@gmail.com` test account).
   - On `/merchant/onboard`, claim a memorable UEN
     (e.g., `T11DEMO123` — anything 8-10 alphanumeric).
   - Sponsored gas is checked by default — the merchant's wallet
     never holds SUI.
   - When you see "✓ Registered on testnet · sponsor paid gas",
     you're set. Sign out so the demo starts clean.

5. **Open Sui Wallet (or Slush) on testnet** with a funded address
   ready to act as the **payer** in Act 1. Payers stay wallet-based
   in V0 — the plan refinement at checkpoint 20260512-211516
   made that the marquee distinction (crypto-native payers, Google-
   identity merchants).

## The 5-minute demo

### Act 1 — payer flow (90 seconds)

The payer is a wallet-connected crypto-native person; the merchant
they're paying is one of the pre-staged fixtures.

1. **Open /scan** ([localhost:3000/scan](http://localhost:3000/scan)).
2. **Click "Scan SGQR"** or, if no real sticker is in frame, click
   "↳ Try the demo UEN (T11KH0001A)" — the same KOPI HOUSE that's
   pre-registered on chain.
3. **Point out the parsed view + on-chain status**:
   - PayNow UEN `T11KH0001A` extracted (from camera) or accepted
     (from manual)
   - "✓ Registered — pays to 0x2084…0c57" badge resolved via
     `devInspectTransactionBlock`
4. **Connect the payer's Sui Wallet** (right-side button).
5. **Type $3.50 in the amount box**. Live Pyth quote appears:
   "≈ X.XX SUI · 1 USD = 1.27 SGD · 1 SUI = $Y.YY · live (Ns ago)".
6. **Optional memo**: type "kopi-o + kaya toast".
7. **Click Pay**. Sui Wallet pops up, show the tx preview, approve.
8. **Wait for success state** (~2-3s). Click the suiscan link — show
   the `PaymentReceipt` event in the explorer with `sgd_minor_units:
   350` and the memo.

### Act 2 — merchant: sign in with Google → terminal lights up (180 seconds)

This is the marquee composability story: zkLogin merchant signup with
sponsored gas, plus a live terminal that updates ~2s after on-chain
finality.

1. **Open /merchant/login**, click **"Sign in with Google"**. Sign in
   with the demoer account you pre-staged in step 4 of pre-demo.
2. **Show the callback progress** ("parsing JWT → fetching salt →
   deriving address → fetching zk proof → persisting session"). Lands
   on `/merchant/onboard`.
3. **Point out the "Signed in" card**: the Gmail email + a derived Sui
   address starting with `0x…`. **This address is bound to the
   demoer's Google account** — there's no private key to back up, no
   recovery phrase. Sign in with the same Google account on any device
   and the wallet is there.
4. **Open `/merchant/terminal`** (in the same tab, no wallet popup
   needed). Header reads "TODAY $X.XX SGD" (X = whatever the demoer
   has received historically; usually $0 on a fresh demo).
5. **Drive a payment to this merchant from /scan in a second window**:
   - Open `/scan`, paste the demoer's UEN (the one onboarded in
     pre-demo step 4).
   - Pay $2.00 SGD with a quick memo like "demo from Act 2".
6. **Switch back to the terminal tab**. Within ~2s of finality, the
   row appears: "$2.00 SGD · X.XXXX SUI · 0x… payer · 'demo from
   Act 2'". TODAY total ticks up.
7. **Sign out**, **sign back in with the same Google account**. The
   address is the same; the terminal still shows the receipt.

### Wrap (30 seconds)

- Open the README's "Why not just off-ramp?" section. Read the
  payer-side + merchant-side differentiators bullets.
- Open the [`scripts/deploy-testnet.json`](../scripts/deploy-testnet.json)
  file. Show the live testnet contract IDs.
- Mention V0.5 mainnet plan: **USDsui** as the settlement asset
  (Sui-native, yield recycling back to the ecosystem) +
  protocol-level gasless retail transfers via
  [`balance::send_funds`](https://docs.sui.io/develop/transaction-payment/gasless-stablecoin-transfers)
  for sub-$10 tickets, with `payments::pay<T>` retained for the
  GST-reportable receipted path.

## Demo failure recovery

| Symptom | Cause | Fix |
|---------|-------|-----|
| `/scan` paste / scan shows "not registered" for a demo UEN | demo merchants never landed | run `day11-stage-demo.ts` again |
| Pay button disabled with "stale" Pyth | Hermes outage > 60s | wait or refresh; underlying flow still works |
| Sui Wallet payer-side sign rejected | user closed popup | retry — state machine handles retry cleanly |
| Sponsor returns 503 on /merchant/onboard | sponsor balance < 20% floor | `day7-create-sponsor.ts` tops up |
| Google sign-in shows `Error 400: redirect_uri_mismatch` | Google Cloud Console redirect URI doesn't match `${origin}/auth/google/callback` | Fix the allowlist + wait 5 min |
| Callback page errors on "fetching zk proof" | Mysten prover-dev rate-limited or down | retry; the proof endpoint is the only third-party dep on the merchant signing path |
| Terminal stays empty after a pay | signed in as a different Google account than the one that owns the merchant address | sign out and back in with the merchant's Gmail |

## Talking points for Q&A

These are pre-baked from the build plan's AD48 ("Why not just off-ramp?"):

- **"Why not just use PayNow + Coinhako?"** — PayNow works for 99% of
  SG users. We target the crypto-native 1% who want non-custodial
  payment without KYC at point of sale, and merchants who want lower
  fees than Visa MDR + self-custody of USDC + structured on-chain
  receipts for GST reporting.
- **"What about hawkers without UEN?"** — V0 is UEN-only. Mobile-number
  PayNow (~70% of SG hawkers) is V1+. Domain-tag namespacing
  (`PAYNOW_UEN_V1` vs future `PAYNOW_MOBILE_V1`) is already on chain.
- **"Mainnet swap?"** — Move contract is generic over `Coin<T>`.
  Mainnet adds a Cetus swap step in the same PTB to settle non-SUI
  source tokens. Testnet Cetus liquidity is the only reason it's not
  in the V0 demo (we cataloged the pool IDs but deferred the
  flash-swap PTB to a focused session).
- **"Why USDsui over USDC for mainnet?"** — Sui-native (no Wormhole
  bridge dependency), yield from reserves recycles back to the Sui
  ecosystem (buybacks + DeFi incentives), issued under US law by
  Stripe's Bridge — same compliance posture as USDC plus a fee story
  USDC can't match.
- **"Centralization?"** — V0 has a single ed25519 issuer key (suiqr).
  V1 rotates to multisig / DAO via `rotate_issuer_pubkey` (gated by
  AdminCap). The Move contract supports this on day one.
- **"What does zkLogin give merchants vs just connecting a wallet?"** —
  No private key to lose, no recovery phrase to back up. The merchant's
  on-chain identity IS their Google account. Sign in on any device
  with the same Google account and the wallet is there. This is the
  literal experience your barista will accept — "sign in with Google"
  is something everyone already knows how to do.
- **"Why blake2b256 not keccak?"** — Sui Move's `sui::hash::blake2b256`
  is the canonical hash (Move framework 1.20+). Keccak is also
  available; blake2b is the cross-chain-friendly default.
