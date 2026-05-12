"use client";

import { genAddressSeed, getZkLoginSignature, decodeJwt } from "@mysten/sui/zklogin";

import { KEY_CLAIM_NAME } from "./config";
import { ephemeralFromSession, type ZkLoginSession } from "./session";

/**
 * Sign serialized transaction bytes with the session's ephemeral keypair
 * and wrap that signature in a zkLogin signature envelope that the Sui
 * fullnode will verify against the bound Google identity.
 *
 * Returned `signature` is ready to feed to `executeTransactionBlock` as
 * one of the signatures in a multi-sig (sponsored) submission.
 */
export async function zkLoginSign(
  session: ZkLoginSession,
  txBytes: Uint8Array,
): Promise<string> {
  const ephemeral = ephemeralFromSession(session);
  const { signature: userSignature } = await ephemeral.signTransaction(txBytes);

  const decoded = decodeJwt(session.jwt) as { sub: string; aud: string | string[] };
  const audValue = Array.isArray(decoded.aud) ? decoded.aud[0] : decoded.aud;
  const addressSeed = genAddressSeed(
    BigInt(session.salt),
    KEY_CLAIM_NAME,
    decoded.sub,
    audValue,
  ).toString();

  return getZkLoginSignature({
    inputs: {
      ...session.proof,
      addressSeed,
    },
    maxEpoch: session.maxEpoch,
    userSignature,
  });
}
