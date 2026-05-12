/**
 * zkLogin configuration. Google-only for V0.
 *
 * The redirect URI must match an "Authorized redirect URI" in your
 * Google Cloud OAuth client (see docs/GOOGLE_OAUTH_SETUP.md).
 */

export const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

export const ZKLOGIN_REDIRECT_PATH = "/auth/google/callback";

/**
 * Enoki-hosted prover. We use Enoki because Sui testnet validators only accept
 * proofs produced against the production verifying key (see fastcrypto's
 * `ZkLoginEnv::Prod`), and Mysten's public prover requires Enoki auth. Enoki
 * also manages the user salt, so `/api/zklogin/salt` is bypassed at proof time.
 */
export const ENOKI_API_BASE = "https://api.enoki.mystenlabs.com/v1";
export const ENOKI_API_KEY = process.env.NEXT_PUBLIC_ENOKI_API_KEY ?? "";
export const ENOKI_NETWORK = "testnet" as const;

/** How many epochs the proof should remain valid for. */
export const EPOCH_LOOKAHEAD = 2;

export function isZkLoginConfigured(): boolean {
  return GOOGLE_CLIENT_ID.length > 0 && ENOKI_API_KEY.length > 0;
}

export function redirectUri(): string {
  if (typeof window === "undefined") return ZKLOGIN_REDIRECT_PATH;
  return `${window.location.origin}${ZKLOGIN_REDIRECT_PATH}`;
}
