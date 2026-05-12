"use client";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

import { deriveMerchantKeypair, emailFingerprint } from "./derive";

/**
 * In-browser merchant session state. Stored in localStorage.
 *
 * V0 supports `email_demo` only. The shape leaves room for a `zklogin`
 * variant once a Google OAuth client is wired (see
 * docs/GOOGLE_OAUTH_SETUP.md).
 */

export type MerchantSession =
  | {
      kind: "email_demo";
      email: string;
      address: string;
      /** bech32-encoded private key — full access to the derived wallet. */
      privateKeyBech32: string;
      /** A short stable fingerprint of the email for the UI. */
      fingerprint: string;
      createdAt: number;
    }
  | {
      kind: "zklogin";
      email: string;
      address: string;
      /** Reserved for the real zkLogin payload (jwt, salt, ephemeral pubkey, proof). */
      reserved: true;
      createdAt: number;
    };

const STORAGE_KEY = "suiqr.merchant_session.v1";

export function loadSession(): MerchantSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as MerchantSession;
  } catch {
    return null;
  }
}

export function saveSession(session: MerchantSession): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export function signInWithEmail(email: string): MerchantSession {
  const kp = deriveMerchantKeypair(email);
  const session: MerchantSession = {
    kind: "email_demo",
    email: email.trim().toLowerCase(),
    address: kp.toSuiAddress(),
    privateKeyBech32: kp.getSecretKey(),
    fingerprint: emailFingerprint(email),
    createdAt: Date.now(),
  };
  saveSession(session);
  return session;
}

export function loadKeypair(session: MerchantSession): Ed25519Keypair {
  if (session.kind !== "email_demo") {
    throw new Error("zkLogin signing not implemented yet — wire a Google OAuth client first");
  }
  const { secretKey } = decodeSuiPrivateKey(session.privateKeyBech32);
  return Ed25519Keypair.fromSecretKey(secretKey);
}
