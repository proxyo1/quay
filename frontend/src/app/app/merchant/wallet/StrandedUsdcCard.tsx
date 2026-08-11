"use client";

import { useQuery } from "@tanstack/react-query";

import { USDC_MAINNET } from "@/lib/quay/swap-to-usdc";
import { formatMinor } from "@/lib/quay/token-meta";
import { getSuiClient } from "@/lib/sui-client";

/**
 * Surfaces USDC sitting in a merchant's wallet.
 *
 * A merchant should normally never hold USDC. It appears in one situation:
 * a cash-out failed *after* the send and Coinbase returned the USDC to the
 * address it came from.
 *
 * That is the less common of the two post-send failures, and this card is what
 * distinguishes them. When Coinbase does not complete a sale the deposit
 * usually stays in the merchant's Coinbase balance as ordinary USDC — nothing
 * comes back on chain and this card correctly renders nothing. So the row
 * status (`unmatched`) never claims a return; the balance here is the only
 * evidence that one happened.
 *
 * That balance is otherwise invisible. USDC is not a supported receive token
 * (`MAINNET_RECEIVE_TOKENS` is USDsui only), and the wallet page reads only
 * USDsui and its sCoin — so without this card the merchant holds real money the
 * app refuses to acknowledge. Showing it is the minimum; the plan's ideal was a
 * one-tap swap back to USDsui, which is not built here because it needs its own
 * sponsored PTB route, so this states plainly what happened and what the
 * balance is rather than implying it is lost.
 *
 * Renders nothing when the balance is zero, which is the overwhelmingly common
 * case.
 */
export function StrandedUsdcCard({ owner }: { owner: string | undefined }) {
  const { data } = useQuery<bigint>({
    queryKey: ["stranded-usdc", owner],
    queryFn: async () => {
      if (!owner) return 0n;
      const sui = getSuiClient();
      const res = await sui.getBalance({ owner, coinType: USDC_MAINNET });
      return BigInt(res.balance.balance);
    },
    enabled: !!owner,
    staleTime: 30_000,
  });

  if (!data || data === 0n) return null;

  return (
    <section className="glass-card-warning rounded-2xl p-5 space-y-2">
      <p className="relative z-10 text-[11px] uppercase tracking-[0.12em] text-[var(--accent)]">
        Unsold USDC
      </p>
      <p className="relative z-10 text-sm text-white">
        {formatMinor(data, 6)} USDC is in your wallet
      </p>
      <p className="relative z-10 text-xs text-[var(--muted)] leading-relaxed">
        A Coinbase cash-out didn&apos;t complete, so the USDC came back to you.
        USDC isn&apos;t your settlement token, so it won&apos;t appear in your
        main balance — but it is yours and it is safe. Contact support to convert
        it back to USDsui.
      </p>
    </section>
  );
}
