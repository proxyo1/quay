"use client";

import { useCallback, useEffect, useState } from "react";

import { getSuiClient } from "@/lib/sui-client";

import { clearSession, loadSession, type ZkLoginSession } from "./session";

/**
 * React hook around the localStorage-backed zkLogin session.
 *
 * Auto-expiry: the zkLogin proof is bound to a `maxEpoch`. Once Sui's
 * current epoch passes it the proof is rejected by validators with a
 * cryptic "ZKLogin expired at epoch X, current epoch Y" — instead of
 * surfacing that to the user, we proactively check on hydration (and
 * every minute thereafter) and clear the session if it's gone stale.
 * Callers can read `expired` to show "your session timed out, sign in
 * again" once the redirect lands on /merchant/login.
 *
 * RPC failures during the epoch check are silent — we'd rather risk an
 * expired session attempting a tx than kick the user out because their
 * fullnode hiccupped.
 */
export function useZkLoginSession() {
  const [session, setSession] = useState<ZkLoginSession | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [expired, setExpired] = useState(false);

  // Hydration + auto-expiry. The two initial setStates here are the
  // standard Next.js "load client-only state after mount" pattern that
  // the react-hooks/set-state-in-effect rule flags but is in fact correct:
  // localStorage isn't available during SSR/RSC, so we MUST defer to a
  // client effect.
  useEffect(() => {
    let cancelled = false;
    const loaded = loadSession();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(loaded);
    setHydrated(true);

    const checkExpiry = async (s: ZkLoginSession) => {
      try {
        const sui = getSuiClient();
        const { systemState } = await sui.core.getCurrentSystemState();
        if (cancelled) return;
        const currentEpoch = Number(systemState.epoch);
        if (currentEpoch > s.maxEpoch) {
          clearSession();
          setSession(null);
          setExpired(true);
        }
      } catch {
        /* transient RPC failure — leave session alone */
      }
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key === "quay.merchant_session.v2") setSession(loadSession());
    };
    window.addEventListener("storage", onStorage);

    if (loaded) {
      void checkExpiry(loaded);
      // Re-check every minute so a long-open tab doesn't keep a stale
      // session alive past epoch-rollover.
      const interval = setInterval(() => {
        const current = loadSession();
        if (current) void checkExpiry(current);
      }, 60_000);
      return () => {
        cancelled = true;
        clearInterval(interval);
        window.removeEventListener("storage", onStorage);
      };
    }

    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const refresh = useCallback(() => {
    setSession(loadSession());
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setSession(null);
    setExpired(false);
  }, []);

  return { session, hydrated, expired, refresh, signOut };
}
