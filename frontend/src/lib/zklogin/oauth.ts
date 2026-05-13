"use client";

import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { generateNonce, generateRandomness } from "@mysten/sui/zklogin";

import {
  EPOCH_LOOKAHEAD,
  GOOGLE_CLIENT_ID,
  redirectUri,
} from "./config";

const sui = new SuiClient({ network: "testnet", url: getFullnodeUrl("testnet") });

const PENDING_KEY = "quay.zklogin.pending.v1";

interface PendingState {
  ephemeralPrivKeyBech32: string;
  randomness: string;
  maxEpoch: number;
  nextUrl: string;
  createdAt: number;
}

/**
 * Begin the Google OAuth flow:
 *   1. mint ephemeral Ed25519 keypair
 *   2. fetch current Sui epoch, set maxEpoch = current + EPOCH_LOOKAHEAD
 *   3. generate randomness + nonce
 *   4. persist { ephemeralPriv, randomness, maxEpoch, nextUrl } in localStorage
 *   5. redirect to Google
 *
 * The callback page reads `PENDING_STATE` from localStorage and completes the
 * proof / address-derivation handshake.
 */
export async function startGoogleZkLogin(nextUrl: string = "/merchant/onboard"): Promise<void> {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error("NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set");
  }
  const ephemeral = Ed25519Keypair.generate();
  const { epoch } = await sui.getLatestSuiSystemState();
  const maxEpoch = Number(epoch) + EPOCH_LOOKAHEAD;
  const randomness = generateRandomness();
  const nonce = generateNonce(ephemeral.getPublicKey(), maxEpoch, randomness);

  const pending: PendingState = {
    ephemeralPrivKeyBech32: ephemeral.getSecretKey(),
    randomness,
    maxEpoch,
    nextUrl,
    createdAt: Date.now(),
  };
  window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "id_token",
    scope: "openid email",
    nonce,
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function loadPendingState(): PendingState | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(PENDING_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingState;
  } catch {
    return null;
  }
}

export function clearPendingState(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(PENDING_KEY);
}

/** Rehydrate the ephemeral keypair from the pending state's bech32 private key. */
export function ephemeralKeypairFromPending(pending: PendingState): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(pending.ephemeralPrivKeyBech32);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

/** Parse `#id_token=...&state=...` from a callback URL hash. */
export function parseCallbackHash(hash: string): { idToken: string | null } {
  const cleaned = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(cleaned);
  return { idToken: params.get("id_token") };
}
