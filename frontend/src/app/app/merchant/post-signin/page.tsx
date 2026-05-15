"use client";

/**
 * Post sign-in dispatcher.
 *
 * Both sign-in entry points (the /merchant home and /merchant/login) hand
 * Google OAuth this URL as the post-auth landing. Once the zkLogin session
 * hydrates we check whether the merchant already has any registered UENs:
 *
 *   - 0 UENs  → /merchant/onboard   (new merchant — needs to add a business)
 *   - 1+ UENs → /merchant/terminal  (returning merchant — straight to dashboard)
 *
 * If the events query fails we fall back to /merchant (the home dashboard)
 * so the merchant can pick where to go manually instead of being stuck.
 *
 * The hop is intentionally invisible — the user sees a brief "Loading…"
 * splash while the events query resolves (~200–800ms in practice).
 */

import { useSuiClient } from "@mysten/dapp-kit";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { QUAY } from "@/lib/sui-config";
import { useZkLoginSession } from "@/lib/zklogin";

interface MerchantRegisteredEvent {
  sui_address: string;
}

export default function PostSignInPage() {
  const { session, hydrated, expired } = useZkLoginSession();
  const router = useRouter();
  const sui = useSuiClient();

  const hasUensQ = useQuery({
    queryKey: ["post-signin-has-uens", session?.address],
    queryFn: async () => {
      if (!session?.address) return false;
      const events = await sui.queryEvents({
        query: { MoveEventType: `${QUAY.packageId}::payments::MerchantRegistered` },
        order: "descending",
        limit: 100,
      });
      return events.data.some(
        (e) =>
          (e.parsedJson as MerchantRegisteredEvent | undefined)?.sui_address ===
          session.address,
      );
    },
    enabled: !!session?.address,
    // Single-shot lookup — no need to re-poll. The dispatcher only runs
    // once per sign-in.
    staleTime: Infinity,
  });

  useEffect(() => {
    // Session hydration is still in flight — wait.
    if (!hydrated) return;

    // No session: bounce to login. Preserve the expired flag so the login
    // page can show the "session expired" warning if relevant.
    if (!session) {
      const expiredParam = expired ? "?expired=1" : "";
      router.replace(`/merchant/login${expiredParam}`);
      return;
    }

    // Session is good. Wait for the UENs query to settle.
    if (hasUensQ.isLoading) return;

    // Query failed — drop them on the home dashboard so they can choose
    // where to go manually rather than being stuck on a spinner.
    if (hasUensQ.isError) {
      router.replace("/merchant");
      return;
    }

    if (hasUensQ.data) {
      router.replace("/merchant/terminal");
    } else {
      router.replace("/merchant/onboard");
    }
  }, [
    hydrated,
    session,
    expired,
    hasUensQ.isLoading,
    hasUensQ.isError,
    hasUensQ.data,
    router,
  ]);

  return (
    <main className="relative z-10 mx-auto w-full max-w-md px-5 py-16">
      <p className="text-sm text-[var(--muted-soft)]">Loading your account…</p>
    </main>
  );
}
