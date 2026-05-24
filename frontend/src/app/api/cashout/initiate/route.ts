import "server-only";

import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { NextResponse } from "next/server";

import {
  computeCashoutQuote,
  FX_RATE_MAX_AGE_SECONDS,
  QUAY_FEE_BPS,
} from "@/lib/server/cashout-fee";
import { insertSigned, type CashoutRecipient } from "@/lib/server/cashout-store";
import { getFeatureFlag } from "@/lib/server/feature-flags";
import {
  checkAndIncrementSponsorUsage,
  loadSponsorKeypair,
} from "@/lib/server/sponsor";
import { loadTreasuryKeypair } from "@/lib/server/treasury";
import { buildSponsoredUsdsuiTransfer, InsufficientUsdsuiError } from "@/lib/quay/transfer";
import { fetchLatestPrices, priceAgeSeconds, PYTH_FEEDS } from "@/lib/pyth";
import { SUI_NETWORK } from "@/lib/sui-config";

export const runtime = "nodejs";

/**
 * Build the sponsored USDsui->treasury transfer and LOCK the quote (D4).
 * The merchant zkLogin-signs the returned tx, submits it dual-signed, then
 * calls /api/cashout/confirm with the resulting digest.
 *
 * The locked net_sgd_minor is returned so the UI shows the merchant exactly
 * what they'll receive BEFORE they sign.
 */

const DAILY_CAP = 10;
const LOW_BALANCE_FLOOR_MIST = 40_000_000n;

const sui = new SuiClient({ network: SUI_NETWORK, url: getFullnodeUrl(SUI_NETWORK) });

interface InitiateRequest {
  owner: string;
  uen?: string | null;
  amount_usdsui_minor: string | number;
  recipient: CashoutRecipient & { accountHolderName?: string };
}

function validRecipient(r: unknown): r is CashoutRecipient {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return typeof o.type === "string" && o.type.length > 0 && !!o.details && typeof o.details === "object";
}

export async function POST(req: Request) {
  const flag = await getFeatureFlag("cashout_enabled");
  if (!flag?.enabled) {
    return NextResponse.json({ error: "cash-out is not available" }, { status: 404 });
  }

  let body: InitiateRequest;
  try {
    body = (await req.json()) as InitiateRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!body.owner || !/^0x[0-9a-fA-F]{1,64}$/.test(body.owner)) {
    return NextResponse.json({ error: "invalid owner address" }, { status: 400 });
  }
  if (!validRecipient(body.recipient)) {
    return NextResponse.json({ error: "recipient {type, details} required" }, { status: 400 });
  }
  let amountMinor: bigint;
  try {
    amountMinor = BigInt(body.amount_usdsui_minor);
  } catch {
    return NextResponse.json({ error: "amount_usdsui_minor must be an integer" }, { status: 400 });
  }
  if (amountMinor <= 0n) {
    return NextResponse.json({ error: "amount must be > 0" }, { status: 400 });
  }

  if (process.env.NODE_ENV !== "development") {
    const usage = checkAndIncrementSponsorUsage(body.owner, DAILY_CAP);
    if (!usage.ok) {
      return NextResponse.json(
        { error: "daily cash-out cap reached for this address", cap: DAILY_CAP, reset_at_ms: usage.resetAt },
        { status: 429 },
      );
    }
  }

  // Lock the quote: fresh Pyth USD/SGD at sign time.
  let rate: number;
  try {
    const prices = await fetchLatestPrices([PYTH_FEEDS.USD_SGD]);
    const p = prices.get(PYTH_FEEDS.USD_SGD);
    if (!p || !(p.price > 0) || priceAgeSeconds(p) > FX_RATE_MAX_AGE_SECONDS) {
      return NextResponse.json({ error: "exchange rate unavailable, try again" }, { status: 503 });
    }
    rate = p.price;
  } catch {
    return NextResponse.json({ error: "exchange rate unavailable, try again" }, { status: 503 });
  }

  let quote;
  try {
    quote = computeCashoutQuote(amountMinor, rate, QUAY_FEE_BPS);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "could not quote" }, { status: 400 });
  }

  let sponsor;
  try {
    sponsor = loadSponsorKeypair();
  } catch (e) {
    return NextResponse.json(
      { error: `sponsor key unavailable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
  const sponsorAddr = sponsor.toSuiAddress();
  const sponsorBal = await sui.getBalance({ owner: sponsorAddr });
  if (BigInt(sponsorBal.totalBalance) < LOW_BALANCE_FLOOR_MIST) {
    return NextResponse.json(
      { error: "sponsor balance below floor — refusing to sign" },
      { status: 503 },
    );
  }

  const treasury = loadTreasuryKeypair().toSuiAddress();

  let txBytes: Uint8Array;
  try {
    const tx = await buildSponsoredUsdsuiTransfer({
      sui,
      owner: body.owner,
      destination: treasury,
      amountMinor,
      sponsorAddress: sponsorAddr,
    });
    txBytes = await tx.build({ client: sui });
  } catch (e) {
    if (e instanceof InsufficientUsdsuiError) {
      return NextResponse.json(
        {
          error:
            "not enough liquid USDsui — if you're earning interest, turn it off first to free up funds",
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: `could not build transfer: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  const sponsorSig = await sponsor.signTransaction(txBytes);

  let row;
  try {
    row = await insertSigned({
      owner: body.owner,
      uen: body.uen ?? null,
      amountUsdsuiMinor: amountMinor,
      rateSgdPerUsd: quote.rateSgdPerUsd,
      feeBps: quote.feeBps,
      netSgdMinor: quote.netSgdMinor,
      recipient: { type: body.recipient.type, details: body.recipient.details },
    });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not record cash-out" },
      { status },
    );
  }

  return NextResponse.json({
    cashout_id: row.id,
    tx_bytes_b64: Buffer.from(txBytes).toString("base64"),
    sponsor_signature: sponsorSig.signature,
    treasury_address: treasury,
    amount_usdsui_minor: amountMinor.toString(),
    rate_sgd_per_usd: quote.rateSgdPerUsd,
    fee_bps: quote.feeBps,
    net_sgd_minor: quote.netSgdMinor.toString(),
  });
}
