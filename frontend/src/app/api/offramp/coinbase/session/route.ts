import "server-only";

import { NextResponse } from "next/server";

import { getFeatureFlag } from "@/lib/server/feature-flags";
import {
  OfframpAuthError,
  authorizeOfframpRequest,
  mintOfframpToken,
  partnerUserRefFor,
} from "@/lib/server/coinbase-auth";
import {
  CoinbaseOfframpError,
  buildOfframpUrl,
  createSellQuote,
  createSessionToken,
  getCashoutLimits,
  isCoinbaseConfigured,
} from "@/lib/server/coinbase-offramp";
import {
  OfframpStoreError,
  getOpenForOwner,
  insertCreated,
} from "@/lib/server/coinbase-offramp-store";
import { checkAndIncrementSponsorUsage } from "@/lib/server/sponsor";
import { coinbaseOfframpCapMinor, formatSgdMinor } from "@/lib/money";
import { readBalanceSheet, USDSUI } from "@/lib/quay/scallop";
import { planRedeemFromBalanceSheet } from "@/lib/quay/scallop-redeem";
import { collectUsdsuiCoins } from "@/lib/quay/transfer";
import { SwapBudgetExceededError, quoteUsdcSwap } from "@/lib/quay/swap-to-usdc";
import { AggregatorRouteError } from "@/lib/dex/aggregator";
import { getDexClients } from "@/lib/dex/client";
import { getSuiClient } from "@/lib/sui-client";

export const runtime = "nodejs";

/**
 * Start a Coinbase cash-out: price it, reserve the merchant's slot, and hand
 * back a locked widget URL.
 *
 * Ordering here is deliberate and is the plan's central design decision. The
 * USDC amount is **derived from a live Cetus quote against the balance the
 * merchant actually has**, rather than picked first and hoped for. Committing
 * a `sell_amount` to Coinbase and only then discovering the swap cannot be
 * funded would put an uncontrollable dependency after an irreversible
 * commitment.
 *
 * Note this does NOT redeem from Scallop. It reports what is realizable so the
 * UI can disclose the redeem and its fee before the merchant signs anything;
 * the redeem is its own transaction, signed first, because Scallop's pool cash
 * is shared with every other user and can move underneath us.
 *
 * Rate limited per address and flag-gated. There is no offramp sandbox, so the
 * flag is off by default and the SGD cap is a real safety rail.
 */

const DAILY_CAP = 5;
const RATE_LIMIT_LABEL = "coinbase-offramp";
const FEATURE_FLAG_NAME = "coinbase_offramp_enabled";

/** Slippage tolerance for the USDsui→USDC leg. */
const SWAP_SLIPPAGE_BPS = 100;

interface SessionRequest {
  owner?: string;
  /** USDsui microunits the merchant wants to cash out. */
  amount_usdsui_minor?: string;
  /** Where Coinbase should send the merchant back to. */
  redirect_url?: string;
}

function redirectUrlFor(req: Request, supplied: string | undefined): string {
  if (supplied) return supplied;
  const origin = new URL(req.url).origin;
  return `${origin}/app/merchant/wallet`;
}

export async function POST(req: Request) {
  // Kill switch first: a disabled rail should look absent, not broken.
  const flag = await getFeatureFlag(FEATURE_FLAG_NAME);
  if (!flag?.enabled) {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }
  if (!isCoinbaseConfigured()) {
    return NextResponse.json(
      { error: "Coinbase offramp not configured on the server" },
      { status: 503 },
    );
  }

  let body: SessionRequest;
  try {
    body = (await req.json()) as SessionRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Auth: registered merchant, or a valid bearer token.
  let claims;
  try {
    claims = await authorizeOfframpRequest({
      authorizationHeader: req.headers.get("authorization"),
      owner: body.owner,
    });
  } catch (e) {
    if (e instanceof OfframpAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
  const owner = claims.owner;

  let amountMinor: bigint;
  try {
    amountMinor = BigInt(body.amount_usdsui_minor ?? "0");
  } catch {
    return NextResponse.json(
      { error: "amount_usdsui_minor must be an integer string" },
      { status: 400 },
    );
  }
  if (amountMinor <= 0n) {
    return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  }

  // Cheap pre-check BEFORE the rate limit is consumed.
  //
  // Coinbase enforces its minimum in SGD, which we cannot know until the quote
  // comes back — by which point a daily slot is already spent. A merchant
  // fumbling the amount two or three times would lock themselves out for a
  // day over something we could see coming. USDsui and USDC are both 1:1 USD,
  // so a deliberately conservative floor rate turns the SGD minimum into a
  // USDsui one. Advisory only: it errs toward letting a marginal amount
  // through, and the Coinbase quote remains the authority.
  const limits = await getCashoutLimits({});
  if (limits) {
    const CONSERVATIVE_SGD_PER_USD = 140n; // 1.40, hundredths
    const minUsdsuiMinor = (limits.minMinor * 1_000_000n * 100n) / (CONSERVATIVE_SGD_PER_USD * 100n);
    if (amountMinor < minUsdsuiMinor) {
      return NextResponse.json(
        {
          error:
            `Coinbase's minimum cash-out is S$${formatSgdMinor(limits.minMinor)}. ` +
            `Try a larger amount.`,
          min_sgd_minor: limits.minMinor.toString(),
          max_sgd_minor: limits.maxMinor.toString(),
        },
        { status: 400 },
      );
    }
  }

  const usage = await checkAndIncrementSponsorUsage(
    `${owner}:${RATE_LIMIT_LABEL}`,
    DAILY_CAP,
  );
  if (!usage.ok) {
    return NextResponse.json(
      { error: "daily cash-out cap reached", cap: DAILY_CAP, reset_at_ms: usage.resetAt },
      { status: 429 },
    );
  }

  // In-flight lock. The DB index is the real guarantee; checking here just
  // turns a constraint violation into a useful message.
  try {
    const open = await getOpenForOwner(owner);
    if (open) {
      return NextResponse.json(
        {
          error: "you already have a cash-out in progress",
          request_id: open.id,
          status: open.status,
        },
        { status: 409 },
      );
    }
  } catch (e) {
    if (e instanceof OfframpStoreError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const sui = getSuiClient();

  // What can this merchant actually realize right now: liquid USDsui plus
  // whatever Scallop's pool cash will let them redeem.
  let liquidMinor = 0n;
  try {
    const collected = await collectUsdsuiCoins(sui, owner);
    liquidMinor = collected.totalMinor;
  } catch {
    liquidMinor = 0n;
  }

  const balanceSheet = await readBalanceSheet(sui, USDSUI.coinType);
  let realizableFromYield = 0n;
  let redeemPlan: ReturnType<typeof planRedeemFromBalanceSheet> | null = null;

  if (balanceSheet && amountMinor > liquidMinor) {
    const shortfall = amountMinor - liquidMinor;
    const { balances } = await sui.listBalances({ owner });
    const sCoinBalance = balances.find((b) => b.coinType === USDSUI.sCoinType);
    const shareBalance = BigInt(sCoinBalance?.balance ?? "0");
    redeemPlan = planRedeemFromBalanceSheet({
      shareBalance,
      balanceSheet,
      requestedUnderlying: shortfall,
    });
    realizableFromYield = redeemPlan.realizableUnderlying;
  }

  const availableMinor = liquidMinor + realizableFromYield;
  if (availableMinor < amountMinor) {
    return NextResponse.json(
      {
        error: "not enough USDsui available to cash out that amount",
        requested_minor: amountMinor.toString(),
        available_minor: availableMinor.toString(),
        liquid_minor: liquidMinor.toString(),
        realizable_from_earning_minor: realizableFromYield.toString(),
      },
      { status: 400 },
    );
  }

  // Live Cetus quote against the balance that will exist, which is what
  // derives the USDC amount. Exact-out both ways: we ask what USDC the
  // merchant's USDsui buys, bounded by that same budget.
  const dex = getDexClients(sui, undefined, owner);
  let swapQuote;
  try {
    // USDsui and USDC are both 1:1 USD and 6dp, so the nominal target is the
    // amount itself; the swap's own budget check is what enforces reality.
    swapQuote = await quoteUsdcSwap({
      cetus: dex.cetusAggregator,
      amountOutUsdc: amountMinor,
      budgetInUsdsui: availableMinor,
      slippageBps: SWAP_SLIPPAGE_BPS,
    });
  } catch (e) {
    if (e instanceof SwapBudgetExceededError) {
      return NextResponse.json(
        {
          error:
            "the USDsui→USDC route costs more than you have available right now",
          required_minor: e.requiredIn.toString(),
          available_minor: e.budgetIn.toString(),
        },
        { status: 409 },
      );
    }
    if (e instanceof AggregatorRouteError) {
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
    throw e;
  }

  // USDC amount as the decimal string Coinbase wants.
  const sellAmountUsdc = formatUsdcDecimal(swapQuote.amountOut);

  const partnerUserRef = partnerUserRefFor(owner);
  const redirectUrl = redirectUrlFor(req, body.redirect_url);

  let sessionToken: string;
  let quote;
  try {
    // Mint immediately before use: single-use, ~5 minute expiry.
    sessionToken = await createSessionToken({ address: owner });
    quote = await createSellQuote({
      sellAmountUsdc,
      sourceAddress: owner,
      partnerUserRef,
      redirectUrl,
      sessionToken,
    });
  } catch (e) {
    if (e instanceof CoinbaseOfframpError) {
      // Coinbase puts the actionable reason in the body, not the status line.
      // Surfacing only `e.message` produced "Coinbase POST /sell/quote -> 400",
      // which tells an operator nothing and a merchant less.
      const detail =
        (e.body as { message?: string } | undefined)?.message ?? e.message;
      console.error(`[coinbase-offramp] sell/quote failed: ${detail}`);

      // A rejected *amount* is the merchant's problem to fix, not an outage,
      // so it is a 400 with Coinbase's own published limits rather than a 502.
      if (e.status === 400) {
        const limits = await getCashoutLimits({});
        return NextResponse.json(
          {
            error: limits
              ? `Coinbase pays out between S$${formatSgdMinor(limits.minMinor)} and ` +
                `S$${formatSgdMinor(limits.maxMinor)} per cash-out. Try a larger amount.`
              : "Coinbase rejected this amount",
            detail,
            min_sgd_minor: limits?.minMinor.toString() ?? null,
            max_sgd_minor: limits?.maxMinor.toString() ?? null,
          },
          { status: 400 },
        );
      }
      return NextResponse.json(
        { error: "Coinbase is unavailable right now", detail },
        { status: 502 },
      );
    }
    throw e;
  }

  // Hard SGD cap. No sandbox exists, so every run is real money.
  const capMinor = coinbaseOfframpCapMinor();
  if (quote.cashoutTotalSgdMinor > capMinor) {
    return NextResponse.json(
      {
        error:
          `cash-out of S$${formatSgdMinor(quote.cashoutTotalSgdMinor)} exceeds ` +
          `the per-transaction limit of S$${formatSgdMinor(capMinor)}`,
      },
      { status: 400 },
    );
  }

  let row;
  try {
    row = await insertCreated({
      owner,
      uen: claims.uen,
      partnerUserRef,
      amountUsdsuiMinor: amountMinor,
      sellAmountUsdcMinor: swapQuote.amountOut,
      cashoutTotalSgdMinor: quote.cashoutTotalSgdMinor,
      coinbaseFeeSgdMinor: quote.coinbaseFeeSgdMinor,
      coinbaseQuoteId: quote.quoteId,
      deadlineAt: null, // Coinbase supplies this once the order is committed.
      redeem: redeemPlan
        ? {
            redeemedShareMinor: redeemPlan.redeemableShare,
            leftoverShareMinor: redeemPlan.leftoverShare,
            partial: redeemPlan.partial,
            performanceFeeUnderlyingMinor: 0n, // computed at redeem time
            sharePriceAtQuote: redeemPlan.sharePrice,
            redeemDigest: null,
          }
        : undefined,
    });
  } catch (e) {
    if (e instanceof OfframpStoreError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const offrampUrl = buildOfframpUrl({
    sessionToken,
    quoteId: quote.quoteId,
    presetCryptoAmount: sellAmountUsdc,
    partnerUserId: partnerUserRef,
    redirectUrl,
    returnedOfframpUrl: quote.returnedOfframpUrl,
  });

  return NextResponse.json({
    request_id: row.id,
    // The redeem leg calls /api/sponsor/earn-move, which is keyed by UEN.
    uen: claims.uen,
    /** Present this on subsequent calls to skip the registry read. */
    offramp_token: await mintOfframpToken({ owner, uen: claims.uen }),
    offramp_url: offrampUrl,
    sell_amount_usdc_minor: swapQuote.amountOut.toString(),
    /** Quay's estimate. Coinbase's own number is authoritative after commit. */
    estimated_sgd_minor: quote.cashoutTotalSgdMinor.toString(),
    coinbase_fee_sgd_minor: quote.coinbaseFeeSgdMinor.toString(),
    swap: {
      expected_in_usdsui_minor: swapQuote.expectedAmountIn.toString(),
      max_in_usdsui_minor: swapQuote.maxAmountIn.toString(),
      venues: swapQuote.venues,
    },
    redeem: redeemPlan
      ? {
          required: redeemPlan.redeemableShare > 0n,
          redeemable_share_minor: redeemPlan.redeemableShare.toString(),
          leftover_share_minor: redeemPlan.leftoverShare.toString(),
          partial: redeemPlan.partial,
          realizable_underlying_minor: redeemPlan.realizableUnderlying.toString(),
        }
      : { required: false },
  });
}

/** USDC minor units → the decimal string Coinbase's API expects. */
function formatUsdcDecimal(minor: bigint): string {
  const whole = minor / 1_000_000n;
  const frac = (minor % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
