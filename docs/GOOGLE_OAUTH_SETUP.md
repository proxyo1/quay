# Google OAuth setup (for zkLogin merchant onboarding)

The merchant onboarding flow on `/merchant/onboard` uses **Sui zkLogin
with Google as the OIDC provider** as the only authentication path. To
run the app locally or deploy it, you need a Google OAuth 2.0 Web
application client.

## What you'll create

Two things:

1. A single OAuth 2.0 **Web application** client in Google Cloud Console.
   Its client ID becomes a public env var (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`)
   that the frontend uses to initiate the OAuth redirect.
2. An **Enoki app** at [portal.enoki.mystenlabs.com](https://portal.enoki.mystenlabs.com).
   Enoki exchanges the Google JWT for a zkLogin proof against the
   production verifying key — required for **testnet and mainnet**
   (the public `prover-dev` endpoint emits proofs against the devnet
   VK only, which testnet validators reject with `Groth16 proof verify
   failed`). Its public API key becomes `NEXT_PUBLIC_ENOKI_API_KEY`.

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
6. Authorized redirect URIs (exact-match, including path):
   - `http://localhost:3000/auth/google/callback`
   - `https://suiqr.vercel.app/auth/google/callback` (or your deploy URL)
7. Click **Create**. Copy the Client ID — it looks like
   `1234567890-abc...def.apps.googleusercontent.com`.

> If you change the redirect path on either side, update both: the
> Google Cloud Console allowlist AND `ZKLOGIN_REDIRECT_PATH` in
> [`frontend/src/lib/zklogin/config.ts`](../frontend/src/lib/zklogin/config.ts).

## Enoki app

1. Sign in at [portal.enoki.mystenlabs.com](https://portal.enoki.mystenlabs.com).
2. Create an app. Allowlist the same origins you used for the Google
   client (`http://localhost:3000` for dev, your deploy URL for prod).
3. Add your Google **client ID** to the app's auth providers.
   This is what makes Enoki accept your JWTs — without it, the proof
   endpoint returns `invalid_client_id`.
4. Enable the **zkLogin** feature on **Testnet** (Mainnet requires a
   paid plan). Sponsored Transactions can stay off — suiqr uses its
   own sponsor wallet (`/api/sponsor/register`) for gas.
5. Create a **Public** API key. The string starts with `enoki_public_`.

## Wire it up

```bash
# frontend/.env.local
NEXT_PUBLIC_GOOGLE_CLIENT_ID="1234567890-abc...def.apps.googleusercontent.com"
NEXT_PUBLIC_ENOKI_API_KEY="enoki_public_..."
```

That's all the public config. Enoki manages the per-user salt internally;
the bundled `/api/zklogin/salt` route is kept for back-compat but no
longer called from the proof path.

## How the flow works locally

1. `/merchant/login` → click "Sign in with Google"
2. Browser mints an ephemeral Ed25519 keypair, computes a nonce from
   it + current Sui epoch + `EPOCH_LOOKAHEAD`, persists pending state
   in localStorage, redirects to Google with `response_type=id_token`
3. User approves → Google redirects to `/auth/google/callback#id_token=…`
4. Callback page parses the JWT, POSTs Enoki's `/v1/zklogin/zkp` with
   the JWT in the `zklogin-jwt` header. Enoki returns a Groth16 proof
   + the addressSeed it bound it to. The Sui address is derived locally
   from that addressSeed and the JWT's `iss`. The full `ZkLoginSession`
   is persisted; the page redirects to `next` (default
   `/merchant/onboard`)
5. From there, every `executeTransactionBlock` call uses
   [`zkLoginSign`](../frontend/src/lib/zklogin/sign.ts) to wrap an
   ephemeral signature in a zkLogin signature envelope. The addressSeed
   comes from the stored proof verbatim — no local recomputation, which
   eliminates a class of mismatch bugs.

The session is valid for `maxEpoch` (≈ current epoch + 2). After
that, signing in again refreshes the proof; the Sui address stays
the same as long as the user keeps the same Google account.

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `Error 400: redirect_uri_mismatch` | The path in your Google Cloud Console allowlist doesn't exactly match `${origin}/auth/google/callback` | Add the exact URI to the allowlist; wait ~5 min for Google's propagation |
| Callback fails with `Enoki prover HTTP 400: invalid_client_id` | Your Google client ID isn't registered under your Enoki app | Add the client ID in the Enoki dashboard's auth-providers section |
| Callback fails with `Enoki API key missing` | `NEXT_PUBLIC_ENOKI_API_KEY` not in `.env.local` | Add the key from the Enoki portal and restart `pnpm dev` |
| Sign-in succeeds but `/merchant/onboard` redirects back to `/merchant/login` | localStorage write blocked (Safari private mode, third-party cookies setting) | Reload in a normal browser tab |
| Session looks live but a tx signature fails on chain with `Groth16 proof verify failed` | Stale v1 session from the pre-Enoki code path | Sign out + sign in again; the storage key bumped to v2 |
| Session looks live but a tx signature fails on chain with `MoveAbort` | `maxEpoch` expired | Sign out + sign in again to refresh the proof |
