"use client";

import { computeZkLoginAddressFromSeed, decodeJwt } from "@mysten/sui/zklogin";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  clearPendingState,
  ephemeralKeypairFromPending,
  fetchZkLoginProof,
  loadPendingState,
  parseCallbackHash,
  saveSession,
  type ZkLoginSession,
} from "@/lib/zklogin";

type State =
  | { kind: "running"; step: string }
  | { kind: "error"; message: string }
  | { kind: "done"; address: string };

/**
 * /auth/google/callback
 *
 * Google redirects here with `#id_token=<JWT>` in the URL hash. We:
 *   1. extract the JWT (client-side only)
 *   2. load the pending state we persisted before the redirect
 *   3. POST Enoki to get the Groth16 proof + Enoki-managed addressSeed
 *   4. derive the Sui address locally from (addressSeed, iss)
 *   5. persist the full session in localStorage
 *   6. redirect to the next URL (typically /merchant/onboard)
 *
 * Enoki owns the per-user salt, so there is no separate salt fetch here.
 */
export default function OAuthCallbackPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "running", step: "parsing JWT" });
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    (async () => {
      try {
        const { idToken } = parseCallbackHash(window.location.hash);
        if (!idToken) throw new Error("no id_token in callback URL");

        const pending = loadPendingState();
        if (!pending) throw new Error("no pending zkLogin state — start over from /merchant/login");

        setState({ kind: "running", step: "fetching zk proof from Enoki" });
        const ephemeral = ephemeralKeypairFromPending(pending);
        const proof = await fetchZkLoginProof({
          jwt: idToken,
          ephemeral,
          maxEpoch: pending.maxEpoch,
          jwtRandomness: pending.randomness,
        });

        setState({ kind: "running", step: "deriving address" });
        const claims = decodeJwt(idToken) as {
          sub: string;
          email?: string;
          aud: string | string[];
          iss: string;
        };
        const audValue = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
        const address = computeZkLoginAddressFromSeed(
          BigInt(proof.addressSeed),
          claims.iss,
          false,
        );

        setState({ kind: "running", step: "persisting session" });
        const session: ZkLoginSession = {
          kind: "zklogin",
          email: claims.email ?? claims.sub,
          sub: claims.sub,
          aud: audValue,
          address,
          jwt: idToken,
          ephemeralPrivKeyBech32: pending.ephemeralPrivKeyBech32,
          randomness: pending.randomness,
          maxEpoch: pending.maxEpoch,
          proof,
          createdAt: Date.now(),
        };
        saveSession(session);
        clearPendingState();

        // Strip the hash so a refresh doesn't re-trigger parsing.
        history.replaceState(null, "", window.location.pathname);

        setState({ kind: "done", address });
        setTimeout(() => router.replace(pending.nextUrl), 600);
      } catch (e) {
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, [router]);

  return (
    <main className="mx-auto max-w-md px-6 py-16 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Signing in</h1>
        <p className="text-sm text-gray-500 mt-1">
          Connecting your Google identity to your quay Sui address.
        </p>
      </header>

      {state.kind === "running" && (
        <section className="rounded-md border border-gray-200 dark:border-gray-700 p-4 text-sm">
          <p className="font-medium">{state.step}…</p>
          <p className="text-xs text-gray-500 mt-1">
            Ephemeral keypair + Groth16 proof via Enoki — your password
            never touches quay.
          </p>
        </section>
      )}

      {state.kind === "done" && (
        <section className="rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/30 p-4 text-sm">
          <p className="font-medium">✓ Signed in</p>
          <p className="text-xs font-mono mt-1">
            {state.address.slice(0, 10)}…{state.address.slice(-6)}
          </p>
          <p className="text-xs text-gray-500 mt-2">Redirecting…</p>
        </section>
      )}

      {state.kind === "error" && (
        <section className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 p-4 text-sm space-y-3">
          <div>
            <p className="font-medium text-red-700 dark:text-red-300">Sign-in failed</p>
            <p className="text-xs text-red-700 dark:text-red-300 mt-1 break-words">
              {state.message}
            </p>
          </div>
          <Link
            href="/merchant/login"
            className="inline-block text-xs px-3 py-1.5 rounded border border-red-300 hover:bg-red-100"
          >
            Try again
          </Link>
        </section>
      )}
    </main>
  );
}
