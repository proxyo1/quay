import "server-only";

import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { NextResponse } from "next/server";

import { getFeatureFlag } from "@/lib/server/feature-flags";
import {
  OfframpAuthError,
  authorizeOfframpRequest,
} from "@/lib/server/coinbase-auth";
import {
  CoinbaseOfframpError,
  getUserTransactions,
  isCoinbaseConfigured,
  selectDepositTransaction,
} from "@/lib/server/coinbase-offramp";
import {
  OfframpStoreError,
  getById,
  markCommitted,
} from "@/lib/server/coinbase-offramp-store";
import { loadSponsorKeypair } from "@/lib/server/sponsor";
import { AggregatorRouteError } from "@/lib/dex/aggregator";
import { getDexClients } from "@/lib/dex/client";
import { usdsuiSpendableMinor } from "@/lib/quay/transfer";
import { USDSUI } from "@/lib/quay/scallop";
import {
  SwapBudgetExceededError,
  USDC_MAINNET,
  appendUsdcSwapToPtb,
  quoteUsdcSwap,
} from "@/lib/quay/swap-to-usdc";
import { getSuiClient } from "@/lib/sui-client";

export const runtime = "nodejs";

/**
 * Build the sponsored swap-and-send transaction for a committed order.
 *
 * Called once the merchant has committed the order inside the widget — which
 * Quay cannot verify. Coinbase issues `to_address` at quote time and a
 * committed order is indistinguishable from an untouched one on the API, so
 * this route confirms only that the address belongs to a live order that is
 * this merchant's and current. See the note above `selectDepositTransaction`.
 *
 * **Two transactions, not one.** Coinbase matches a deposit by validating
 * `from_address`, `to_address`, `amount`, `network` and `asset` against the
 * chain, and a single swap-and-send PTB fails the first of those: the USDC is
 * produced by the Cetus swap and transferred straight to Coinbase, so the
 * merchant's only balance change is USDsui leaving. No USDC ever moves *from*
 * `from_address`, so there is no transfer for Coinbase to match and the deposit
 * lands as an ordinary credit with no sale behind it. That cost two live
 * cash-outs before the matching rule was found in the integration guide.
 *
 * So the swap lands the USDC in the merchant's own address first, and a second
 * plain transfer sends it on. One PTB doing both would not help — Sui reports
 * *net* balance changes, so USDC arriving and leaving in one transaction nets
 * to zero and still shows no transfer.
 *
 * Which stage this call builds is derived from the merchant's live USDC
 * balance rather than stored, so the flow resumes correctly if the tab dies
 * between the two signatures. A merchant already holding enough USDC — stranded
 * by an earlier failure — skips straight to the send and spends that instead,
 * which is the right outcome.
 *
 * The swap stage re-quotes rather than reusing the session's quote: minutes may
 * have passed inside the widget, and the swap is exact-out, so a thinner route
 * now needs more USDsui. The max-in bound is what stops that from silently
 * spending more than the merchant freed up.
 */

const LOW_BALANCE_FLOOR_MIST = 40_000_000n;
const SWAP_SLIPPAGE_BPS = 100;
const FEATURE_FLAG_NAME = "coinbase_offramp_enabled";

interface PrepareRequest {
  request_id?: string;
  owner?: string;
}

export async function POST(req: Request) {
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

  let body: PrepareRequest;
  try {
    body = (await req.json()) as PrepareRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.request_id) {
    return NextResponse.json({ error: "request_id required" }, { status: 400 });
  }

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

  let row;
  try {
    row = await getById(body.request_id);
  } catch (e) {
    if (e instanceof OfframpStoreError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
  if (!row) {
    return NextResponse.json({ error: "cash-out not found" }, { status: 404 });
  }
  // A token proves who you are; it does not entitle you to someone else's row.
  if (row.owner !== claims.owner) {
    return NextResponse.json({ error: "not your cash-out" }, { status: 403 });
  }
  if (row.status !== "created" && row.status !== "committed") {
    return NextResponse.json(
      { error: `cash-out is '${row.status}' and cannot be prepared`, status: row.status },
      { status: 409 },
    );
  }

  // Ask Coinbase for the deposit address. Absent = the merchant has not
  // finished committing yet, which is a normal poll result, not an error.
  //
  // Two independent traps here, both of which have produced a live "ready to
  // send" against an order that could not accept the funds:
  //   - the list is the merchant's whole history, so the entry must be bound to
  //     THIS order (`selectDepositTransaction`);
  //   - a deposit address alone is not a commitment, because Coinbase issues
  //     one at quote time — and no API field distinguishes the two, so the
  //     merchant's own confirmation in the widget is the only signal there is.
  let tx;
  try {
    const transactions = await getUserTransactions(row.partner_user_ref);
    tx = selectDepositTransaction(transactions, {
      rowCreatedAtMs: Date.parse(row.created_at),
      boundTransactionId: row.coinbase_transaction_id,
    });
  } catch (e) {
    if (e instanceof CoinbaseOfframpError) {
      return NextResponse.json(
        { error: "Coinbase is unavailable right now", detail: e.message },
        { status: 502 },
      );
    }
    throw e;
  }

  if (!tx?.toAddress) {
    return NextResponse.json(
      { ready: false, reason: "waiting for you to confirm the order on Coinbase" },
      { status: 202 },
    );
  }

  // Record the commitment (idempotent: already-committed rows skip the write).
  if (row.status === "created") {
    try {
      row = await markCommitted(row.id, "created", {
        toAddress: tx.toAddress,
        sellAmountUsdcMinor: tx.sellAmountUsdcMinor,
        coinbaseTransactionId: tx.transactionId,
        deadlineAt: tx.deadlineMs ? new Date(tx.deadlineMs) : null,
      });
    } catch (e) {
      if (e instanceof OfframpStoreError && e.status !== 409) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      // A 409 means a concurrent poll committed it first — re-read and carry on.
      const refreshed = await getById(body.request_id);
      if (refreshed) row = refreshed;
    }
  }

  const sellAmountUsdc =
    tx.sellAmountUsdcMinor > 0n
      ? tx.sellAmountUsdcMinor
      : BigInt(row.sell_amount_usdc_minor ?? "0");
  if (sellAmountUsdc <= 0n) {
    return NextResponse.json(
      { error: "Coinbase did not report a sell amount" },
      { status: 502 },
    );
  }

  const sui = getSuiClient();

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
  if (BigInt(sponsorBal.balance.balance) < LOW_BALANCE_FLOOR_MIST) {
    return NextResponse.json(
      { error: "sponsor balance below floor — refusing to sign" },
      { status: 503 },
    );
  }

  // Stage selection. Enough USDC in hand means the swap already happened (or
  // the merchant was left holding some by an earlier failure), so this call
  // builds the transfer Coinbase can actually match.
  const usdcBalance = BigInt(
    (await sui.getBalance({ owner: claims.owner, coinType: USDC_MAINNET })).balance
      .balance,
  );

  if (usdcBalance >= sellAmountUsdc) {
    const sendPtb = new Transaction();
    sendPtb.setSender(claims.owner);
    sendPtb.setGasOwner(sponsorAddr);
    sendPtb.setGasBudget(20_000_000n);

    // Exactly `sell_amount`, sourced from coin objects and/or the address
    // balance. An inexact amount fails Coinbase's match as surely as a wrong
    // address does.
    const usdcCoin = sendPtb.add(
      coinWithBalance({ type: USDC_MAINNET, balance: sellAmountUsdc }),
    );
    sendPtb.transferObjects([usdcCoin], sendPtb.pure.address(tx.toAddress));

    let sendBytes: Uint8Array;
    try {
      sendBytes = await sendPtb.build({ client: sui });
    } catch (e) {
      return NextResponse.json(
        {
          error: `could not build the send: ${e instanceof Error ? e.message : String(e)}`,
        },
        { status: 500 },
      );
    }
    const sendSig = await sponsor.signTransaction(sendBytes);

    return NextResponse.json({
      ready: true,
      stage: "send",
      request_id: row.id,
      tx_bytes_b64: Buffer.from(sendBytes).toString("base64"),
      sponsor_signature: sendSig.signature,
      sponsor_address: sponsorAddr,
      to_address: tx.toAddress,
      sell_amount_usdc_minor: sellAmountUsdc.toString(),
      deadline_at_ms: tx.deadlineMs,
    });
  }

  // The merchant's spendable USDsui, across coin objects AND the address
  // balance. By this point any Scallop redeem has been signed and settled, so
  // this is the real budget.
  const totalMinor = await usdsuiSpendableMinor(sui, claims.owner);
  if (totalMinor === 0n) {
    return NextResponse.json(
      { error: "no liquid USDsui to send — free up funds from earning first" },
      { status: 400 },
    );
  }

  // Re-quote against the live route and the real budget.
  const dex = getDexClients(sui, undefined, claims.owner);
  let swapQuote;
  try {
    swapQuote = await quoteUsdcSwap({
      cetus: dex.cetusAggregator,
      amountOutUsdc: sellAmountUsdc,
      budgetInUsdsui: totalMinor,
      slippageBps: SWAP_SLIPPAGE_BPS,
    });
  } catch (e) {
    if (e instanceof SwapBudgetExceededError) {
      return NextResponse.json(
        {
          error:
            "the route now costs more USDsui than you hold — the order will " +
            "expire on Coinbase and nothing has been sent",
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

  // Build: source the bounded input → swap exact-out → send USDC.
  const ptb = new Transaction();
  ptb.setSender(claims.owner);
  ptb.setGasOwner(sponsorAddr);
  ptb.setGasBudget(50_000_000n);

  // Sources from coin objects and/or the address balance, whichever holds it.
  const swapInput = ptb.add(
    coinWithBalance({ type: USDSUI.coinType, balance: swapQuote.maxAmountIn }),
  );

  let usdcCoin;
  try {
    usdcCoin = await appendUsdcSwapToPtb({
      cetus: dex.cetusAggregator,
      tx: ptb,
      quote: swapQuote,
      inputCoin: swapInput,
      slippageBps: SWAP_SLIPPAGE_BPS,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `could not build the swap: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  // To the MERCHANT, not to Coinbase. This is the whole point of the split:
  // the USDC has to be owned by `from_address` before it moves, or the transfer
  // Coinbase is watching for never exists on chain.
  //
  // Exact-out swap: Cetus returns any unspent input to the configured signer
  // (the merchant), so no explicit leftover transfer is needed.
  ptb.transferObjects([usdcCoin], ptb.pure.address(claims.owner));

  let txBytes: Uint8Array;
  try {
    txBytes = await ptb.build({ client: sui });
  } catch (e) {
    return NextResponse.json(
      { error: `could not build transaction: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  const sponsorSig = await sponsor.signTransaction(txBytes);

  return NextResponse.json({
    ready: true,
    stage: "swap",
    request_id: row.id,
    tx_bytes_b64: Buffer.from(txBytes).toString("base64"),
    sponsor_signature: sponsorSig.signature,
    sponsor_address: sponsorAddr,
    to_address: tx.toAddress,
    sell_amount_usdc_minor: sellAmountUsdc.toString(),
    max_in_usdsui_minor: swapQuote.maxAmountIn.toString(),
    deadline_at_ms: tx.deadlineMs,
  });
}
