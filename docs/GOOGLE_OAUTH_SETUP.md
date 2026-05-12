# Google OAuth setup (for zkLogin merchant onboarding)

The merchant onboarding flow on `/merchant/onboard` uses **Sui zkLogin
with Google as the OIDC provider** as the only authentication path. To
run the app locally or deploy it, you need a Google OAuth 2.0 Web
application client.

## What you'll create

A single OAuth 2.0 **Web application** client in Google Cloud Console.
Its client ID becomes a public env var (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`)
that the frontend uses to initiate the OAuth redirect; the JWT Google
returns is then exchanged through Mysten's prover service for a
zkLogin-bound Sui address.

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

## Wire it up

```bash
# frontend/.env.local
NEXT_PUBLIC_GOOGLE_CLIENT_ID="1234567890-abc...def.apps.googleusercontent.com"
```

That's all the public config. The Mysten zkLogin salt service and prover
service URLs are baked in (free for hackathon use; rate-limited).

For production deployments, also set:

```bash
# Server-only — used by /api/zklogin/salt to derive a stable salt per user
SUIQR_ZKLOGIN_SALT_SECRET="<32-bytes-of-randomness-as-base64-or-hex>"
```

If unset, [`/api/zklogin/salt`](../frontend/src/app/api/zklogin/salt/route.ts)
falls back to a default development secret — fine for testnet, not safe
for mainnet because anyone with the same default would derive the same
address space.

## How the flow works locally

1. `/merchant/login` → click "Sign in with Google"
2. Browser mints an ephemeral Ed25519 keypair, computes a nonce from
   it + current Sui epoch + `EPOCH_LOOKAHEAD`, persists pending state
   in localStorage, redirects to Google with `response_type=id_token`
3. User approves → Google redirects to `/auth/google/callback#id_token=…`
4. Callback page parses the JWT, POSTs `/api/zklogin/salt` for the
   per-user salt, derives the Sui address via `jwtToAddress(jwt, salt)`,
   fetches a Groth16 proof from Mysten's prover-dev endpoint, persists
   the full `ZkLoginSession`, redirects to `next` (default
   `/merchant/onboard`)
5. From there, every `executeTransactionBlock` call uses
   [`zkLoginSign`](../frontend/src/lib/zklogin/sign.ts) to wrap an
   ephemeral signature in a zkLogin signature envelope

The session is valid for `maxEpoch` (≈ current epoch + 2). After
that, signing in again refreshes the proof; the Sui address stays
the same as long as the user keeps the same Google account.

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `Error 400: redirect_uri_mismatch` | The path in your Google Cloud Console allowlist doesn't exactly match `${origin}/auth/google/callback` | Add the exact URI to the allowlist; wait ~5 min for Google's propagation |
| Callback fails on "fetching zk proof" | Mysten prover-dev rate-limited or down | Retry; check `https://prover-dev.mystenlabs.com/v1` is up |
| Sign-in succeeds but `/merchant/onboard` redirects back to `/merchant/login` | localStorage write blocked (Safari private mode, third-party cookies setting) | Reload in a normal browser tab |
| Session looks live but a tx signature fails on chain | `maxEpoch` expired | Sign out + sign in again to refresh the proof |
