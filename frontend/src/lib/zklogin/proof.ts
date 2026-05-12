"use client";

import { getExtendedEphemeralPublicKey } from "@mysten/sui/zklogin";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { KEY_CLAIM_NAME, ZK_PROVER_URL } from "./config";

/** Shape of a Mysten prover response. We only keep the fields we need. */
export interface ZkProof {
  proofPoints: { a: string[]; b: string[][]; c: string[] };
  issBase64Details: { value: string; indexMod4: number };
  headerBase64: string;
}

export interface FetchProofInputs {
  jwt: string;
  ephemeral: Ed25519Keypair;
  maxEpoch: number;
  jwtRandomness: string;
  salt: string;
}

/**
 * Fetch a zkLogin proof from Mysten's hosted prover. Returns the parsed
 * proof payload ready to feed to `getZkLoginSignature`.
 *
 * The prover service validates that the JWT's nonce was computed correctly
 * from the ephemeral pubkey + maxEpoch + randomness, and returns a Groth16
 * proof binding all of that to the user's salted address.
 */
export async function fetchZkLoginProof(input: FetchProofInputs): Promise<ZkProof> {
  const { jwt, ephemeral, maxEpoch, jwtRandomness, salt } = input;
  const extPub = getExtendedEphemeralPublicKey(ephemeral.getPublicKey());
  const body = {
    jwt,
    extendedEphemeralPublicKey: extPub,
    maxEpoch,
    jwtRandomness,
    salt,
    keyClaimName: KEY_CLAIM_NAME,
  };
  const res = await fetch(ZK_PROVER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`prover HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as ZkProof;
  if (!json.proofPoints || !json.headerBase64 || !json.issBase64Details) {
    throw new Error("prover returned an unexpected shape");
  }
  return json;
}
