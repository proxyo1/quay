"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchLatestPrices, type PythPrice } from "./client";

/**
 * TanStack-Query hook for live Pyth prices.
 *
 * - Refetches every `refetchIntervalMs` (default 10s) so the UI tracks
 *   live market movement.
 * - Returns the Map keyed by 0x-prefixed feed ID.
 * - Errors surface via `query.error` — callers should show a stale-OK
 *   message and avoid blocking the UI on feed loss.
 */
export function usePythPrices(
  feedIds: readonly string[],
  refetchIntervalMs = 10_000,
) {
  return useQuery<Map<string, PythPrice>>({
    queryKey: ["pyth", "prices", ...feedIds],
    queryFn: ({ signal }) => fetchLatestPrices(feedIds, { signal }),
    refetchInterval: refetchIntervalMs,
    refetchIntervalInBackground: false,
    staleTime: refetchIntervalMs / 2,
    enabled: feedIds.length > 0,
    retry: 2,
  });
}
