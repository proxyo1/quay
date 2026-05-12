/**
 * zkLogin configuration. Google-only for V0.
 *
 * The redirect URI must match an "Authorized redirect URI" in your
 * Google Cloud OAuth client (see docs/GOOGLE_OAUTH_SETUP.md).
 */

export const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

export const ZKLOGIN_REDIRECT_PATH = "/merchant/oauth/callback";

/** Mysten-hosted prover for testnet / devnet. */
export const ZK_PROVER_URL = "https://prover-dev.mystenlabs.com/v1";

/** How many epochs the proof should remain valid for. */
export const EPOCH_LOOKAHEAD = 2;

/** Key-claim name used by Google OIDC. zkLogin computes addressSeed over this claim. */
export const KEY_CLAIM_NAME = "sub" as const;

export function isZkLoginConfigured(): boolean {
  return GOOGLE_CLIENT_ID.length > 0;
}

export function redirectUri(): string {
  if (typeof window === "undefined") return ZKLOGIN_REDIRECT_PATH;
  return `${window.location.origin}${ZKLOGIN_REDIRECT_PATH}`;
}
