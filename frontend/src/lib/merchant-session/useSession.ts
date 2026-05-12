"use client";

import { useCallback, useEffect, useState } from "react";

import { clearSession, loadSession, signInWithEmail, type MerchantSession } from "./session";

/** React hook around the localStorage-backed merchant session. */
export function useMerchantSession() {
  const [session, setSession] = useState<MerchantSession | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setSession(loadSession());
    setHydrated(true);
    // Listen for changes from other tabs.
    const onStorage = (e: StorageEvent) => {
      if (e.key === "suiqr.merchant_session.v1") setSession(loadSession());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const signIn = useCallback((email: string) => {
    const s = signInWithEmail(email);
    setSession(s);
    return s;
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  return { session, hydrated, signIn, signOut };
}
