import "server-only";

import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { NextResponse } from "next/server";

import { getFeatureFlag } from "@/lib/server/feature-flags";
import {
  checkAndIncrementSponsorUsage,
  loadSponsorKeypair,
} from "@/lib/server/sponsor";
import {
  DEFAULT_CALL_PACKAGE,
  USDSUI,
  buildMintWithSCoinWrap,
  buildRedeemFromSCoin,
  getPoolCash,
  getSharePrice,
  preflightScallopHealthy,
} from "@/lib/quay/scallop";
import {
  computeRedeemFee,
  getYieldFeeConfig,
  readCostBasis,
} from "@/lib/server/yield-cost-basis";
import { SUI_NETWORK } from "@/lib/sui-config";

export const runtime = "nodejs";

/**
 * Ad-hoc partial cash-out / re-deposit between liquid USDsui and
 * Scallop-yielding sUSDsui WITHOUT flipping the merchant's
 * yield_routing.enabled flag.
 *
 * Use cases:
 *   - "Move $X to cash" while earning is enabled  → direction=to_cash
 *   - "Move $X back to earning" after a cash-out  → direction=to_earning
 *
 * Bounded by `amount_usdsui_minor` (the underlying amount the merchant
 * wants to move). For to_cash, pool cash limits the actual amount —
 * surfaced in the response so the wallet can show a disclosure modal
 * (DR4) before the merchant signs.
 *
 * Sponsor pays gas (5/day cap is too tight for ad-hoc moves — 20/day
 * matches realistic UX). Separate counter from toggle-yield.
 */

const DAILY_CAP = 20;
const RATE_LIMIT_LABEL = "earn-move";
const LOW_BALANCE_FLOOR_MIST = 40_000_000n;
const MAX_COINS_PER_PTB = 50;
const FEATURE_FLAG_NAME = "yield_routing.scallop.usdsui";

const sui = new SuiClient({ network: SUI_NETWORK, url: getFullnodeUrl(SUI_NETWORK) });

type Direction = "to_cash" | "to_earning";

interface EarnMoveRequest {
  uen: string;
  owner: string;
  direction: Direction;
  /** Amount of underlying USDsui (6-decimal minor units) to move. */
  amount_usdsui_minor: string;
}

interface SponsoredTx {
  tx_bytes_b64: string;
  sponsor_signature: string;
}

interface EarnMoveResponse {
  direction: Direction;
  /** What the merchant requested (input echo). */
  requested_underlying_minor: string;
  /** What the PTB actually moves (= requested unless pool cash clamped to_cash). */
  actual_underlying_minor: string;
  partial: boolean;
  tx: SponsoredTx;
  sponsor_address: string;
  daily_cap: number;
  /**
   * Quay performance fee taken from the redeem (only present and non-zero
   * for `to_cash`). Mints (`to_earning`) never incur a fee.
   */
  fee_underlying_minor?: string;
  /** Address that received the fee. */
  fee_recipient?: string;
  /** Cost basis used for the fee calculation (USDsui underlying). */
  cost_basis_underlying_minor?: string;
  /** True when the ledger didn't cover the merchant's on-chain balance. */
  insufficient_cost_basis?: boolean;
}

export async function POST(req: Request) {
  let body: EarnMoveRequest;
  try {
    body = (await req.json()) as EarnMoveRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Validation
  if (!body.uen || !body.owner) {
    return NextResponse.json(
      { error: "uen and owner required" },
      { status: 400 },
    );
  }
  if (!/^0x[0-9a-fA-F]+$/.test(body.owner)) {
    return NextResponse.json(
      { error: "invalid owner address" },
      { status: 400 },
    );
  }
  if (body.direction !== "to_cash" && body.direction !== "to_earning") {
    return NextResponse.json(
      { error: "direction must be 'to_cash' or 'to_earning'" },
      { status: 400 },
    );
  }
  let amount: bigint;
  try {
    amount = BigInt(body.amount_usdsui_minor);
  } catch {
    return NextResponse.json(
      { error: "amount_usdsui_minor must be a stringified non-negative integer" },
      { status: 400 },
    );
  }
  if (amount <= 0n) {
    return NextResponse.json(
      { error: "amount_usdsui_minor must be > 0" },
      { status: 400 },
    );
  }

  // Global feature flag. See toggle-yield/route.ts for the rationale on
  // distinguishing the three 503 causes (Supabase unconfigured vs row
  // missing vs flag off).
  const flag = await getFeatureFlag(FEATURE_FLAG_NAME);
  if (!flag || !flag.enabled) {
    const supabaseConfigured = !!process.env.SUPABASE_URL &&
      !!process.env.SUPABASE_SERVICE_KEY;
    const cause = !flag
      ? supabaseConfigured
        ? "flag row not found in feature_flags table"
        : "Supabase not configured on the server (set SUPABASE_URL + SUPABASE_SERVICE_KEY in Vercel)"
      : flag.last_changed_reason ?? "flag is off";
    return NextResponse.json(
      {
        error: "yield routing temporarily unavailable",
        flag: FEATURE_FLAG_NAME,
        cause,
      },
      { status: 503 },
    );
  }
  const callPackage =
    typeof flag.metadata.last_seen_package === "string"
      ? flag.metadata.last_seen_package
      : DEFAULT_CALL_PACKAGE;

  // Rate limit
  if (process.env.NODE_ENV !== "development") {
    const usageCheck = checkAndIncrementSponsorUsage(
      `${body.owner}:${RATE_LIMIT_LABEL}`,
      DAILY_CAP,
    );
    if (!usageCheck.ok) {
      return NextResponse.json(
        {
          error: "daily sponsored-gas cap reached for earn-move",
          cap: DAILY_CAP,
          reset_at_ms: usageCheck.resetAt,
        },
        { status: 429 },
      );
    }
  }

  // Sponsor + balance floor
  let sponsor;
  try {
    sponsor = loadSponsorKeypair();
  } catch (e) {
    return NextResponse.json(
      {
        error: `sponsor key unavailable: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 },
    );
  }
  const sponsorAddr = sponsor.toSuiAddress();
  const sponsorBal = await sui.getBalance({ owner: sponsorAddr });
  if (BigInt(sponsorBal.totalBalance) < LOW_BALANCE_FLOOR_MIST) {
    return NextResponse.json(
      {
        error: "sponsor balance below floor — refusing to sign",
        sponsor_balance_mist: sponsorBal.totalBalance,
        floor_mist: LOW_BALANCE_FLOOR_MIST.toString(),
      },
      { status: 503 },
    );
  }

  // Pre-flight only for to_earning (we're minting). For to_cash, even
  // an unhealthy Scallop should let the merchant pull their cash out.
  if (body.direction === "to_earning") {
    const healthy = await preflightScallopHealthy(sui, USDSUI);
    if (!healthy) {
      return NextResponse.json(
        {
          error: "Scallop pre-flight failed — refusing to mint",
          hint: "try again later; the cron will auto-disable if the issue persists",
        },
        { status: 503 },
      );
    }
  }

  // Build the PTB.
  const tx = new Transaction();
  tx.setSender(body.owner);
  tx.setGasOwner(sponsorAddr);
  tx.setGasBudget(30_000_000n);

  let actualAmount = amount;
  let partial = false;
  let responseFee: {
    fee_underlying_minor: string;
    fee_recipient: string;
    cost_basis_underlying_minor: string;
    insufficient_cost_basis: boolean;
  } | null = null;

  if (body.direction === "to_earning") {
    // Mint: merchant moves liquid USDsui into Scallop.
    const sourceType = USDSUI.coinType;
    const coinsRes = await sui.getCoins({
      owner: body.owner,
      coinType: sourceType,
      limit: MAX_COINS_PER_PTB + 1,
    });
    if (coinsRes.data.length === 0) {
      return NextResponse.json(
        { error: "merchant has no liquid USDsui" },
        { status: 400 },
      );
    }
    if (coinsRes.data.length > MAX_COINS_PER_PTB) {
      return NextResponse.json(
        {
          error: "too_many_coins",
          coin_type: sourceType,
          count: coinsRes.data.length,
          max: MAX_COINS_PER_PTB,
          hint: "consolidate via wallet first",
        },
        { status: 413 },
      );
    }
    const totalBalance = coinsRes.data.reduce(
      (acc, c) => acc + BigInt(c.balance),
      0n,
    );
    if (totalBalance < amount) {
      return NextResponse.json(
        {
          error: "insufficient liquid USDsui",
          requested: amount.toString(),
          available: totalBalance.toString(),
        },
        { status: 400 },
      );
    }

    const merged = mergeAll(
      tx,
      coinsRes.data.map((c) => c.coinObjectId),
    );
    const [exactAmount] = tx.splitCoins(merged, [tx.pure.u64(amount)]);
    const sCoin = buildMintWithSCoinWrap(tx, {
      coin: exactAmount,
      asset: USDSUI,
      callPackage,
    });
    // The merge-target keeps the unused remainder; transfer both the
    // leftover liquid USDsui and the new sCoin back to the merchant.
    tx.transferObjects([sCoin, merged], tx.pure.address(body.owner));
  } else {
    // to_cash: merchant moves sUSDsui back to liquid USDsui.
    const sourceType = USDSUI.sCoinType;
    const coinsRes = await sui.getCoins({
      owner: body.owner,
      coinType: sourceType,
      limit: MAX_COINS_PER_PTB + 1,
    });
    if (coinsRes.data.length === 0) {
      return NextResponse.json(
        { error: "merchant has no sUSDsui" },
        { status: 400 },
      );
    }
    if (coinsRes.data.length > MAX_COINS_PER_PTB) {
      return NextResponse.json(
        {
          error: "too_many_coins",
          coin_type: sourceType,
          count: coinsRes.data.length,
          max: MAX_COINS_PER_PTB,
          hint: "consolidate via wallet first",
        },
        { status: 413 },
      );
    }

    // Compute share amount needed for `amount` underlying. Clamp to
    // pool cash (with 1% haircut for share-price drift).
    const [sharePrice, poolCash] = await Promise.all([
      getSharePrice(sui, USDSUI.coinType),
      getPoolCash(sui, USDSUI.coinType),
    ]);
    if (sharePrice <= 0) {
      return NextResponse.json(
        { error: "Scallop share price unavailable" },
        { status: 503 },
      );
    }

    const HAIRCUT_BPS = 100n;
    const haircut = (poolCash * HAIRCUT_BPS) / 10_000n;
    const usableCash = poolCash > haircut ? poolCash - haircut : 0n;
    if (amount > usableCash) {
      actualAmount = usableCash;
      partial = true;
    }
    if (actualAmount === 0n) {
      return NextResponse.json(
        {
          error: "pool has no cash available right now",
          requested_underlying_minor: amount.toString(),
          pool_cash_minor: poolCash.toString(),
        },
        { status: 503 },
      );
    }

    // shares to burn ≈ ceil(actualAmount / share_price). Use ceil so we
    // never under-redeem due to rounding.
    const sharesToBurn = BigInt(
      Math.ceil(Number(actualAmount) / sharePrice),
    );

    const totalShareBalance = coinsRes.data.reduce(
      (acc, c) => acc + BigInt(c.balance),
      0n,
    );
    if (totalShareBalance < sharesToBurn) {
      return NextResponse.json(
        {
          error: "insufficient sUSDsui balance for requested cash-out",
          requested_underlying_minor: amount.toString(),
          required_share_minor: sharesToBurn.toString(),
          available_share_minor: totalShareBalance.toString(),
        },
        { status: 400 },
      );
    }

    // Compute the Quay performance fee on the gain portion. Cost basis
    // comes from the yield_cost_basis ledger (indexer-populated); the
    // merchant's `totalShareBalance` is the on-chain anchor for which
    // mints back the current holdings (newest-first walk; FIFO within).
    const ledgerRows = await readCostBasis(body.owner);
    const feeConfig = getYieldFeeConfig(flag);
    const feeComp = computeRedeemFee({
      ledgerRowsAsc: ledgerRows,
      onChainShareBalance: totalShareBalance,
      burnShareMinor: sharesToBurn,
      currentSharePrice: sharePrice,
      feeBps: feeConfig.feeBps,
    });

    const merged = mergeAll(
      tx,
      coinsRes.data.map((c) => c.coinObjectId),
    );
    const [exactShare] = tx.splitCoins(merged, [tx.pure.u64(sharesToBurn)]);
    const underlying = buildRedeemFromSCoin(tx, {
      sCoin: exactShare,
      asset: USDSUI,
      callPackage,
    });

    // Skim the fee from the redeemed underlying before it lands in the
    // merchant's wallet. No fee when profit is zero (e.g. just-deposited
    // shares, share price hasn't moved enough to clear the cost basis).
    if (feeComp.feeUnderlyingMinor > 0n) {
      const [feeCoin] = tx.splitCoins(underlying, [
        tx.pure.u64(feeComp.feeUnderlyingMinor),
      ]);
      tx.transferObjects(
        [feeCoin],
        tx.pure.address(feeConfig.treasuryAddress),
      );
    }
    tx.transferObjects(
      [underlying, merged],
      tx.pure.address(body.owner),
    );

    // Annotate the response with fee details so the wallet UI can show
    // "you cashed out $X net of $Y Quay fee".
    responseFee = {
      fee_underlying_minor: feeComp.feeUnderlyingMinor.toString(),
      fee_recipient: feeConfig.treasuryAddress,
      cost_basis_underlying_minor:
        feeComp.costBasisUnderlyingMinor.toString(),
      insufficient_cost_basis: feeComp.insufficientCostBasis,
    };
  }

  // Build + co-sign.
  let txBytes: Uint8Array;
  try {
    txBytes = await tx.build({ client: sui });
  } catch (e) {
    return NextResponse.json(
      {
        error: `tx build failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 },
    );
  }
  const sponsorSig = await sponsor.signTransaction(txBytes);

  const response: EarnMoveResponse = {
    direction: body.direction,
    requested_underlying_minor: amount.toString(),
    actual_underlying_minor: actualAmount.toString(),
    partial,
    tx: {
      tx_bytes_b64: Buffer.from(txBytes).toString("base64"),
      sponsor_signature: sponsorSig.signature,
    },
    sponsor_address: sponsorAddr,
    daily_cap: DAILY_CAP,
    ...(responseFee ?? {}),
  };
  return NextResponse.json(response);
}

function mergeAll(tx: Transaction, coinIds: string[]) {
  const [primary, ...rest] = coinIds;
  const primaryArg = tx.object(primary!);
  if (rest.length > 0) {
    tx.mergeCoins(
      primaryArg,
      rest.map((id) => tx.object(id)),
    );
  }
  return primaryArg;
}
