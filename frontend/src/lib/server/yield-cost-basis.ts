import "server-only";

import { QUAY_TREASURY_ADDRESS } from "@/lib/dex/client";
import type { FeatureFlagRow } from "@/lib/server/feature-flags";
import { getSupabaseClient } from "@/lib/server/supabase";

/**
 * Cost-basis ledger reader + redeem-fee calculator.
 *
 * Quay charges a performance fee (default 10%) on the gain portion of a
 * yield-routed redeem — gain = (current redeem value at on-chain share
 * price) − (weighted-average cost basis of the shares being burnt).
 *
 * Design (v1): the indexer cron WRITES cost-basis rows for every mint it
 * observes, but never updates consumption. The merchant's current
 * on-chain `Coin<SCALLOP_USDSUI>` balance is the source of truth for
 * "which mints survived" — past redeems implicitly consumed the OLDEST
 * mints (FIFO). The redeem path here walks the ledger newest-first,
 * accumulates until the cumulative share count covers the on-chain
 * balance, and treats those rows as the "backing set" for the merchant's
 * current holdings. Within the backing set, the burn consumes FIFO
 * (oldest backing row first) — same as if we'd tracked consumption
 * explicitly, just computed lazily.
 *
 * Why this shape: no per-redeem ledger writes means no atomicity
 * concerns between Supabase + Sui submission, no consumption-cursor
 * race between concurrent toggles, no need for `consumed_share_minor`
 * book-keeping (the column exists in the schema as historical scaffold
 * but stays 0 in v1).
 *
 * Edge cases the math handles:
 *   - `current_balance > sum(ledger_mints)` — indexer lag or external
 *     mints we never indexed. Treat the gap as "minted at current
 *     price" → zero contribution to profit → conservative (no fee).
 *   - `burn > on-chain balance` — caller bug; rejected before reaching
 *     this layer. If it slips through, the math treats it the same as
 *     the lag case.
 *   - Share price strictly increases on Scallop (see plan §3 finding 3),
 *     so the profit term is always ≥ 0; we still clamp via `max(0, …)`
 *     to be defensive against RPC anomalies.
 */

export const DEFAULT_FEE_BPS = 1000; // 10%
export const FEE_BPS_DENOM = 10_000;

export interface YieldFeeConfig {
  /** Performance fee in basis points (10000 = 100%). */
  feeBps: number;
  /** Sui address that receives the fee. */
  treasuryAddress: string;
}

/**
 * Pull fee config from `feature_flags.metadata`. Falls back to defaults
 * if either field is missing or malformed — keeps the redeem path
 * working even if ops never touches the metadata.
 */
export function getYieldFeeConfig(
  flag: FeatureFlagRow | null,
): YieldFeeConfig {
  const md = (flag?.metadata ?? {}) as Record<string, unknown>;
  const rawFee = md.yield_fee_bps;
  const rawTreasury = md.quay_treasury;
  return {
    feeBps:
      typeof rawFee === "number" && rawFee >= 0 && rawFee <= FEE_BPS_DENOM
        ? rawFee
        : DEFAULT_FEE_BPS,
    treasuryAddress:
      typeof rawTreasury === "string" && /^0x[0-9a-fA-F]+$/.test(rawTreasury)
        ? rawTreasury
        : QUAY_TREASURY_ADDRESS,
  };
}

export interface CostBasisRow {
  txDigest: string;
  mintShareMinor: bigint;
  mintUnderlyingMinor: bigint;
  observedAt: string;
}

/**
 * Read all cost-basis rows for a merchant in ASCENDING observed_at order
 * (oldest first). Returns empty array when Supabase isn't configured,
 * which feeds the "insufficient cost basis → no fee" branch — safe
 * default.
 */
export async function readCostBasis(
  merchant: string,
  limit = 500,
): Promise<CostBasisRow[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("yield_cost_basis")
    .select("tx_digest, mint_share_minor, mint_underlying_minor, observed_at")
    .eq("merchant_address", merchant)
    .order("observed_at", { ascending: true })
    .limit(limit);
  if (error || !data) return [];
  return data.map((r) => ({
    txDigest: r.tx_digest as string,
    mintShareMinor: BigInt(r.mint_share_minor as string | number),
    mintUnderlyingMinor: BigInt(r.mint_underlying_minor as string | number),
    observedAt: r.observed_at as string,
  }));
}

export interface RedeemFeeComputation {
  /** Shares being burnt (input echo). */
  burnShareMinor: bigint;
  /** Cost basis (USDsui underlying minor) for the burnt shares. */
  costBasisUnderlyingMinor: bigint;
  /** Estimated redeem value = burnShare × currentSharePrice. */
  estimatedRedeemUnderlyingMinor: bigint;
  /** max(0, redeem − cost basis). */
  profitUnderlyingMinor: bigint;
  /** floor(profit × feeBps / 10000). */
  feeUnderlyingMinor: bigint;
  /** True when the ledger didn't cover the merchant's current on-chain balance. */
  insufficientCostBasis: boolean;
}

/**
 * Compute the Quay performance fee for a redeem. Pure function — caller
 * supplies the ledger rows, the merchant's live on-chain share balance,
 * and the current share price.
 *
 * Math walk:
 *   1. Find the "backing rows" — newest-first ledger entries whose
 *      cumulative share count ≥ `onChainShareBalance`. These rows are
 *      what the merchant currently holds. Older ledger rows are
 *      implicitly consumed by past redeems.
 *   2. Within the backing set, the burn consumes FIFO (oldest first).
 *      Take `burnShareMinor` shares total; sum their cost basis as
 *      `sum(take × row_underlying / row_share)`.
 *   3. `estimated_redeem = burn × current_share_price`.
 *   4. `profit = max(0, estimated_redeem − cost_basis)`.
 *   5. `fee = profit × feeBps / 10000`.
 */
export function computeRedeemFee(args: {
  /** All cost-basis rows for the merchant, ascending observed_at. */
  ledgerRowsAsc: CostBasisRow[];
  /** Merchant's current `Coin<SCALLOP_USDSUI>` balance (sum across coin objects). */
  onChainShareBalance: bigint;
  /** Shares being burnt by this redeem. Must be ≤ onChainShareBalance. */
  burnShareMinor: bigint;
  /** Live Scallop share price (e.g. 1.0165). */
  currentSharePrice: number;
  /** Performance-fee rate in basis points. */
  feeBps: number;
}): RedeemFeeComputation {
  const {
    ledgerRowsAsc,
    onChainShareBalance,
    burnShareMinor,
    currentSharePrice,
    feeBps,
  } = args;
  if (burnShareMinor <= 0n) {
    return zeroFeeResult(0n);
  }

  // Step 1: walk DESC, accumulate to onChainShareBalance — those are the
  // backing rows.
  const desc = [...ledgerRowsAsc].reverse();
  const backing: Array<{ row: CostBasisRow; availableShares: bigint }> = [];
  let covered = 0n;
  for (const row of desc) {
    if (covered >= onChainShareBalance) break;
    const need = onChainShareBalance - covered;
    const take = row.mintShareMinor < need ? row.mintShareMinor : need;
    backing.push({ row, availableShares: take });
    covered += take;
  }
  const insufficient = covered < onChainShareBalance;
  if (insufficient) {
    // Synthetic "minted at current price" row for the uncovered gap.
    // We append a virtual row at the OLDEST position so it gets consumed
    // first by FIFO — and since its cost basis equals the current redeem
    // price, it adds zero profit.
    backing.push({
      row: {
        txDigest: "__virtual_uncovered__",
        mintShareMinor: onChainShareBalance - covered,
        mintUnderlyingMinor: BigInt(
          Math.floor(Number(onChainShareBalance - covered) * currentSharePrice),
        ),
        observedAt: new Date(0).toISOString(),
      },
      availableShares: onChainShareBalance - covered,
    });
  }

  // Step 2: FIFO consume within backing rows. `backing` is currently DESC
  // (newest first). Reverse for ASC (oldest first).
  backing.reverse();

  let remaining = burnShareMinor;
  let costBasisFloat = 0;
  for (const { row, availableShares } of backing) {
    if (remaining === 0n) break;
    const take = availableShares < remaining ? availableShares : remaining;
    const pricePerShare =
      Number(row.mintUnderlyingMinor) / Number(row.mintShareMinor);
    costBasisFloat += Number(take) * pricePerShare;
    remaining -= take;
  }

  // If burnShareMinor > onChainShareBalance (shouldn't happen — caller
  // guarantees it doesn't), treat the overflow as cost basis at current
  // price (zero contribution to profit).
  if (remaining > 0n) {
    costBasisFloat += Number(remaining) * currentSharePrice;
  }

  const costBasisUnderlyingMinor = BigInt(Math.floor(costBasisFloat));
  const estimatedRedeem = BigInt(
    Math.floor(Number(burnShareMinor) * currentSharePrice),
  );
  const profit =
    estimatedRedeem > costBasisUnderlyingMinor
      ? estimatedRedeem - costBasisUnderlyingMinor
      : 0n;
  const fee = (profit * BigInt(feeBps)) / BigInt(FEE_BPS_DENOM);

  return {
    burnShareMinor,
    costBasisUnderlyingMinor,
    estimatedRedeemUnderlyingMinor: estimatedRedeem,
    profitUnderlyingMinor: profit,
    feeUnderlyingMinor: fee,
    insufficientCostBasis: insufficient,
  };
}

function zeroFeeResult(burn: bigint): RedeemFeeComputation {
  return {
    burnShareMinor: burn,
    costBasisUnderlyingMinor: 0n,
    estimatedRedeemUnderlyingMinor: 0n,
    profitUnderlyingMinor: 0n,
    feeUnderlyingMinor: 0n,
    insufficientCostBasis: false,
  };
}

/**
 * Upsert a cost-basis row. Called by the indexer cron after observing a
 * yield-routed PaymentReceipt and joining its same-tx MintEvent.
 * Idempotent on the `(tx_digest, merchant_address)` primary key.
 */
export async function recordCostBasis(args: {
  txDigest: string;
  merchantAddress: string;
  mintShareMinor: bigint;
  mintUnderlyingMinor: bigint;
}): Promise<{ written: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) return { written: false, error: "supabase not configured" };
  const { error } = await supabase.from("yield_cost_basis").upsert(
    {
      tx_digest: args.txDigest,
      merchant_address: args.merchantAddress,
      mint_share_minor: args.mintShareMinor.toString(),
      mint_underlying_minor: args.mintUnderlyingMinor.toString(),
    },
    { onConflict: "tx_digest,merchant_address", ignoreDuplicates: true },
  );
  if (error) return { written: false, error: error.message };
  return { written: true };
}
