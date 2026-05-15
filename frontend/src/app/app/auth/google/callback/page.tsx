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
    <main className="relative z-10 mx-auto max-w-md px-5 py-16 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-white">Signing in</h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          Connecting your Google identity to your quay Sui address.
        </p>
      </header>

      {state.kind === "running" && (
        <section className="glass-card rounded-2xl p-4 text-sm">
          <p className="relative z-10 font-medium text-white inline-flex items-center gap-2">
            <Spinner />
            {state.step}…
          </p>
          <p className="relative z-10 text-xs text-[var(--muted-soft)] mt-1.5">
            Ephemeral keypair + Groth16 proof via Enoki — your password
            never touches quay.
          </p>
        </section>
      )}

      {state.kind === "done" && (
        <section className="glass-card-success rounded-2xl p-4 text-sm">
          <p className="font-medium text-white">✓ Signed in</p>
          <p className="text-xs font-mono mt-1 text-[var(--muted)]">
            {state.address.slice(0, 10)}…{state.address.slice(-6)}
          </p>
          <p className="text-xs text-[var(--muted-soft)] mt-2">Redirecting…</p>
        </section>
      )}

      {state.kind === "error" && (
        <section className="glass-card-danger rounded-2xl p-4 text-sm space-y-3">
          <div>
            <p className="font-medium text-red-200">Sign-in failed</p>
            <p className="text-xs text-red-200/80 mt-1 break-words">
              {state.message}
            </p>
          </div>
          <Link
            href="/merchant/login"
            className="glass-chip rounded-lg"
          >
            Try again
          </Link>
        </section>
      )}
    </main>
  );
}

function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
