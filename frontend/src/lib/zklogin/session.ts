"use client";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

import type { ZkProof } from "./proof";

/**
 * Persisted zkLogin session. Lives in localStorage. The ephemeral private
 * key + proof are bound to a specific `maxEpoch`; once Sui advances past
 * that epoch the proof is invalid and the user must re-authenticate.
 */
export interface ZkLoginSession {
  kind: "zklogin";
  /** Stored Google identity: email if available; otherwise sub. */
  email: string;
  sub: string;
  aud: string;
  /** Sui address derived from jwtToAddress(jwt, salt). */
  address: string;
  /** Per-user salt (decimal-string bigint as returned by /api/zklogin/salt). */
  salt: string;
  /** The Google JWT (id_token). Needed to reconstruct addressSeed at signing time. */
  jwt: string;
  /** Bech32 ephemeral private key — signs tx bytes; ZK proof binds to its pubkey. */
  ephemeralPrivKeyBech32: string;
  /** OAuth-flow randomness used to compute the nonce. */
  randomness: string;
  /** Max Sui epoch the proof is valid for. */
  maxEpoch: number;
  /** Groth16 proof from Mysten prover. */
  proof: ZkProof;
  createdAt: number;
}

const STORAGE_KEY = "suiqr.merchant_session.v1";

export function loadSession(): ZkLoginSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ZkLoginSession;
    if (parsed.kind !== "zklogin") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(session: ZkLoginSession): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export function ephemeralFromSession(session: ZkLoginSession): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(session.ephemeralPrivKeyBech32);
  return Ed25519Keypair.fromSecretKey(secretKey);
}
