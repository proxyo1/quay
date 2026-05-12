# Google OAuth setup (for zkLogin merchant onboarding)

The merchant onboarding flow on `/merchant/onboard` works today via Sui
wallet connect. To enable the **"Sign in with Google"** path (zkLogin),
you need a Google OAuth 2.0 client.

This is per AD33 in the build plan: pre-cache salts + tested fallback
to regular wallet path.

## What you'll create

A single OAuth 2.0 **Web application** client in Google Cloud Console.
Its client ID becomes a public env var (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`)
that the frontend uses to initiate the OAuth redirect; the JWT Google
returns is then used to derive a zkLogin Sui address.

## Steps

1. Open [console.cloud.google.com](https://console.cloud.google.com)
   and create a project (or reuse one).
2. APIs & Services → Credentials → **+ CREATE CREDENTIALS** → OAuth
   client ID.
3. If prompted, configure the consent screen first:
   - User type: **External**
   - App name: `suiqr` (or whatever you call it)
   - User support email: your email
   - Scopes: `openid`, `email`, `profile`
   - Test users: add the Gmail accounts that will sign in during the
     hackathon demo
4. Back at Credentials, application type: **Web application**.
5. Authorized JavaScript origins:
   - `http://localhost:3000` (dev)
   - whatever Vercel URL you deploy to (e.g., `https://suiqr.vercel.app`)
6. Authorized redirect URIs:
   - `http://localhost:3000/auth/google/callback`
   - `https://suiqr.vercel.app/auth/google/callback` (or your deploy URL)
7. Click **Create**. Copy the Client ID — it looks like
   `1234567890-abc...def.apps.googleusercontent.com`.

## Wire it up

```bash
# frontend/.env.local
NEXT_PUBLIC_GOOGLE_CLIENT_ID="1234567890-abc...def.apps.googleusercontent.com"
```

That's all the public config. The Mysten zkLogin salt service and prover
service URLs are baked in (free for hackathon use; rate-limited).

The frontend code path for OAuth + zkLogin lives in
`frontend/src/lib/zklogin/` (skeleton ships in a future commit — Day 6 in
this repo only ships the wallet-connect path E2E).

## Why this isn't already wired

Two reasons it's deferred:

1. **OAuth client ID is a per-deploy secret-ish value** — we don't want
   to hardcode one developer's client ID into the repo, and CI doesn't
   have a Google account to create one.
2. **zkLogin signing of `register_merchant` requires the Mysten prover
   service**, which validates real Google JWTs. There's no way to test
   the E2E flow without a real OAuth client. The Day 6 wallet-connect
   smoke test (`scripts/day6-onboard-smoke.ts`) proves the on-chain
   register flow itself works; the zkLogin layer only changes which
   key signs the tx.

When you wire your OAuth client and want the zkLogin path live, write
to the build plan or open an issue — the work is straightforward but
needs OAuth credentials to test against.

## Why the V0 demo can ship without this

The demo path:

1. Merchant connects an existing Sui wallet (Sui Wallet / Slush / Suiet)
2. Enters their UEN
3. `/api/attest` auto-issues an attestation (V0 only — production gates
   this behind SGQR-photo + BizFile+ review)
4. Wallet signs `register_merchant` → on-chain registration

This is the path verified by `day6-onboard-smoke.ts`. The Gmail path
is a demo polish item, not a load-bearing capability.
