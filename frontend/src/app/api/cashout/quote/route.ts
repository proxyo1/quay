import "server-only";

import { NextResponse } from "next/server";

import { computeCashoutQuote, QUAY_FEE_BPS } from "@/lib/server/cashout-fee";
import { getFeatureFlag } from "@/lib/server/feature-flags";
import { treasuryAddress } from "@/lib/server/treasury";
import {
  createSgdQuote,
  getAccountRequirements,
  getPersonalProfileId,
  type WiseAccountRequirement,
} from "@/lib/server/wise";
import { fetchLatestPrices, isStale, PYTH_FEEDS } from "@/lib/pyth";

export const runtime = "nodejs";

/**
 * Cash-out preview. Returns the indicative SGD the merchant would receive
 * (USDsui 1:1 USD, Pyth USD/SGD, minus the 25 bps fee) plus the Wise
 * recipient-field schema so the UI can render the right form. This is a
 * preview only — /api/cashout/initiate re-fetches and LOCKS the quote at
 * sign time (D4), and that locked number is what the merchant actually
 * receives.
 */

interface QuoteRequest {
  amount_usdsui_minor?: string | number;
}

export async function POST(req: Request) {
  const flag = await getFeatureFlag("cashout_enabled");
  if (!flag?.enabled) {
    return NextResponse.json({ error: "cash-out is not available" }, { status: 404 });
  }

  let body: QuoteRequest;
  try {
    body = (await req.json()) as QuoteRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  let amountMinor: bigint;
  try {
    amountMinor = BigInt(body.amount_usdsui_minor ?? 0);
  } catch {
    return NextResponse.json({ error: "amount_usdsui_minor must be an integer" }, { status: 400 });
  }
  if (amountMinor <= 0n) {
    return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  }

  // Pyth USD/SGD — reject stale/zero so we never show a bogus quote.
  let rate: number;
  let publishTime: number;
  try {
    const prices = await fetchLatestPrices([PYTH_FEEDS.USD_SGD]);
    const p = prices.get(PYTH_FEEDS.USD_SGD);
    if (!p || !(p.price > 0) || isStale(p)) {
      return NextResponse.json({ error: "exchange rate unavailable, try again" }, { status: 503 });
    }
    rate = p.price;
    publishTime = p.publishTime;
  } catch {
    return NextResponse.json({ error: "exchange rate unavailable, try again" }, { status: 503 });
  }

  let quote;
  try {
    quote = computeCashoutQuote(amountMinor, rate, QUAY_FEE_BPS);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not quote" },
      { status: 400 },
    );
  }

  // Wise recipient schema for the form. Best-effort: if Wise is unreachable
  // the price quote still returns, with recipient_schema=null so the UI can
  // show "cash-out temporarily unavailable" for the recipient step.
  let recipientSchema: WiseAccountRequirement[] | null = null;
  try {
    const profileId = await getPersonalProfileId();
    const wiseQuote = await createSgdQuote(profileId, quote.netSgdMinor);
    recipientSchema = await getAccountRequirements(wiseQuote.id);
  } catch {
    recipientSchema = null;
  }

  return NextResponse.json({
    amount_usdsui_minor: quote.amountUsdsuiMinor.toString(),
    rate_sgd_per_usd: quote.rateSgdPerUsd,
    fee_bps: quote.feeBps,
    gross_sgd_minor: quote.grossSgdMinor.toString(),
    fee_sgd_minor: quote.feeSgdMinor.toString(),
    net_sgd_minor: quote.netSgdMinor.toString(),
    pyth_publish_time: publishTime,
    treasury_address: treasuryAddress(),
    recipient_schema: recipientSchema,
  });
}
