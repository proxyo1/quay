"use client";

import { getExtendedEphemeralPublicKey } from "@mysten/sui/zklogin";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { ENOKI_API_BASE, ENOKI_API_KEY, ENOKI_NETWORK } from "./config";

/**
 * zkLogin proof + the addressSeed Enoki used to bind it. We carry addressSeed
 * around so the signing side doesn't recompute it (mismatches there were the
 * class of bug we worked through to get here).
 */
export interface ZkProof {
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
  addressSeed: string;
}

export interface FetchProofInputs {
  jwt: string;
  ephemeral: Ed25519Keypair;
  maxEpoch: number;
  jwtRandomness: string;
}

/**
 * Fetch a zkLogin proof from Enoki. Enoki produces proofs against the
 * production verifying key that Sui mainnet AND testnet validators accept;
 * raw `prover-dev` proofs only work on devnet. Enoki also owns the per-user
 * salt and embeds the resulting addressSeed in the response, so the caller
 * does not need to keep its own salt store for the proof path.
 *
 * The JWT travels in the `zklogin-jwt` header (not the body) per Enoki's
 * contract. Auth uses the public API key, which Enoki gates by allowed
 * origins configured in the Enoki dashboard.
 */
export async function fetchZkLoginProof(input: FetchProofInputs): Promise<ZkProof> {
  if (!ENOKI_API_KEY) {
    throw new Error(
      "Enoki API key missing — set NEXT_PUBLIC_ENOKI_API_KEY in .env.local",
    );
  }
  const { jwt, ephemeral, maxEpoch, jwtRandomness } = input;
  const extendedEphemeralPublicKey = getExtendedEphemeralPublicKey(
    ephemeral.getPublicKey(),
  );
  const res = await fetch(`${ENOKI_API_BASE}/zklogin/zkp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENOKI_API_KEY}`,
      "zklogin-jwt": jwt,
    },
    body: JSON.stringify({
      network: ENOKI_NETWORK,
      ephemeralPublicKey: extendedEphemeralPublicKey,
      maxEpoch,
      randomness: jwtRandomness,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Enoki prover HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as { data?: ZkProof };
  const proof = json.data;
  if (
    !proof ||
    !proof.proofPoints ||
    !proof.issBase64Details ||
    !proof.headerBase64 ||
    !proof.addressSeed
  ) {
    throw new Error("Enoki returned an unexpected proof shape");
  }
  return proof;
}
