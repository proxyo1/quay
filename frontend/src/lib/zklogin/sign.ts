"use client";

import { getZkLoginSignature } from "@mysten/sui/zklogin";

import { ephemeralFromSession, type ZkLoginSession } from "./session";

/**
 * Sign serialized transaction bytes with the session's ephemeral keypair and
 * wrap that signature in a zkLogin signature envelope the Sui fullnode will
 * verify against the bound Google identity.
 *
 * The addressSeed inside the envelope comes verbatim from Enoki's proof
 * response. We never recompute it locally — recomputing risked diverging from
 * what the prover bound the proof to (different aud normalization, salt source,
 * etc.) and was the class of bug that gated this flow earlier.
 */
export async function zkLoginSign(
  session: ZkLoginSession,
  txBytes: Uint8Array,
): Promise<string> {
  const ephemeral = ephemeralFromSession(session);
  const { signature: userSignature } = await ephemeral.signTransaction(txBytes);

  return getZkLoginSignature({
    inputs: session.proof,
    maxEpoch: session.maxEpoch,
    userSignature,
  });
}
