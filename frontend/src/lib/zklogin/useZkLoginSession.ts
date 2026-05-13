"use client";

import { useCallback, useEffect, useState } from "react";

import { clearSession, loadSession, type ZkLoginSession } from "./session";

/** React hook around the localStorage-backed zkLogin session. */
export function useZkLoginSession() {
  const [session, setSession] = useState<ZkLoginSession | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setSession(loadSession());
    setHydrated(true);
    const onStorage = (e: StorageEvent) => {
      if (e.key === "quay.merchant_session.v2") setSession(loadSession());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const refresh = useCallback(() => {
    setSession(loadSession());
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  return { session, hydrated, refresh, signOut };
}
