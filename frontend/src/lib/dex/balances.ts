/**
 * Wallet balance + coin metadata fetcher for the PayPanel source-token picker.
 *
 * The payer side of the swap-and-pay flow is "pay with whatever liquid token
 * you hold." To populate that picker we need:
 *   1. Every coin type the user owns with a non-zero balance.
 *   2. The display symbol + decimals for each, so we can render "12.345 WAL"
 *      instead of "12345678901 0x…::wal::WAL".
 *
 * `useUserBalances` packages both into a React Query call keyed by address
 * so the picker can render with a single hook and re-fetch on wallet change.
 *
 * Cost: one `getAllBalances` plus one `getCoinMetadata` per token. Cached
 * for 30 s — balances change infrequently, metadata is effectively static.
 */

import { useQuery } from "@tanstack/react-query";
import { getSuiClient } from "@/lib/sui-client";

export interface UserBalance {
  /** Sui Move type, e.g. `0x2::sui::SUI`. */
  coinType: string;
  /** Total balance across all the user's coins of this type, smallest units. */
  balance: bigint;
  /** Display symbol from on-chain metadata, falls back to the type tail. */
  symbol: string;
  /** Decimals from on-chain metadata; 0 if unknown (callers should treat as raw). */
  decimals: number;
}

/**
 * Fetch every token the user owns with a non-zero balance, plus its display
 * metadata. Returns the list sorted by balance descending so the most useful
 * tokens float to the top of the picker.
 */
export function useUserBalances(address: string | undefined) {
  const sui = getSuiClient();
  return useQuery<UserBalance[]>({
    queryKey: ["wallet-balances", address],
    enabled: !!address,
    staleTime: 30_000,
    queryFn: async () => {
      if (!address) return [];
      const { balances } = await sui.listBalances({ owner: address });
      // Filter dust-free balances first to avoid metadata calls on zero-balance entries.
      const nonZero = balances.filter((b) => BigInt(b.balance) > 0n);
      const enriched = await Promise.all(
        nonZero.map(async (b): Promise<UserBalance> => {
          let symbol = shortenType(b.coinType);
          let decimals = 0;
          try {
            const { coinMetadata } = await sui.getCoinMetadata({ coinType: b.coinType });
            if (coinMetadata) {
              if (coinMetadata.symbol) symbol = coinMetadata.symbol;
              if (typeof coinMetadata.decimals === "number") decimals = coinMetadata.decimals;
            }
          } catch {
            // No metadata published — fall back to the type tail + raw integer.
          }
          return {
            coinType: b.coinType,
            balance: BigInt(b.balance),
            symbol,
            decimals,
          };
        }),
      );
      enriched.sort((a, b) => (a.balance < b.balance ? 1 : a.balance > b.balance ? -1 : 0));
      return enriched;
    },
  });
}

/**
 * Format a token amount for display using its decimals. Trims trailing zeros.
 */
export function formatBalance(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  const fracStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

function shortenType(coinType: string): string {
  const idx = coinType.lastIndexOf("::");
  return idx >= 0 ? coinType.slice(idx + 2) : coinType;
}
