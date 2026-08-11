import "server-only";

import { NextResponse } from "next/server";

import {
  getById,
  markFailed,
  markPaidOut,
  markPaying,
  markReceived,
  type CashoutRow,
} from "@/lib/server/cashout-store";
import { getFeatureFlag } from "@/lib/server/feature-flags";
import { loadTreasuryKeypair } from "@/lib/server/treasury";
import {
  createRecipient,
  createSgdQuote,
  createTransfer,
  fundTransfer,
  getPersonalProfileId,
} from "@/lib/server/wise";
import { USDSUI } from "@/lib/quay/scallop";
import { getSuiClient } from "@/lib/sui-client";

export const runtime = "nodejs";

/**
 * Verify the on-chain USDsui->treasury transfer, then fire the Wise sandbox
 * SGD payout. Idempotent on the digest. If the payout fails AFTER funds
 * have landed in treasury, the row is marked `failed` and the merchant sees
 * "payout pending" (D3) — never a silent loss; scripts/cashout-redrive.ts
 * recovers it.
 */

const MAX_SIGNED_AGE_MS = 60 * 60 * 1000; // bound float exposure

const sui = getSuiClient();

interface ConfirmRequest {
  cashout_id: string;
  digest: string;
}

/**
 * On-chain proof that the merchant's USDsui actually reached the treasury.
 *
 * Fullnodes prune transaction history, so a digest older than the retention
 * window returns "not found" rather than a failed verification. That is fine
 * here — `MAX_SIGNED_AGE_MS` already bounds this to the last hour — but it
 * means callers must not treat a lookup failure as proof of a bad payment.
 */
async function verifyOnChain(
  digest: string,
  owner: string,
  treasury: string,
  amountMinor: bigint,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const res = await sui.getTransaction({
    digest,
    include: { balanceChanges: true, effects: true, transaction: true },
  });
  const tx = res.Transaction;
  if (!tx) return { ok: false, reason: "transaction not found" };

  if (!tx.status?.success) {
    return { ok: false, reason: `tx failed: ${tx.status?.error?.message ?? "unknown"}` };
  }

  if (tx.transaction?.sender !== owner) {
    return { ok: false, reason: "tx sender does not match cash-out owner" };
  }

  // gRPC flattens the recipient to `address`; JSON-RPC nested it under
  // `owner.AddressOwner`.
  const credit = (tx.balanceChanges ?? []).find(
    (c) =>
      c.address === treasury &&
      c.coinType === USDSUI.coinType &&
      BigInt(c.amount) >= amountMinor,
  );
  if (!credit) return { ok: false, reason: "no matching USDsui credit to treasury" };
  return { ok: true };
}

function accountHolderName(row: CashoutRow): string {
  const d = row.recipient.details ?? {};
  return d.accountHolderName || d.name || d.legalName || "Quay Merchant";
}

/** Run the Wise payout for a received/paying row. Marks paid_out or failed. */
async function payOut(row: CashoutRow, digest: string) {
  const profileId = await getPersonalProfileId();
  const quote = await createSgdQuote(profileId, BigInt(row.net_sgd_minor));
  const recipientId = await createRecipient({
    profileId,
    type: row.recipient.type,
    accountHolderName: accountHolderName(row),
    details: row.recipient.details,
  });
  await markPaying({ id: row.id, wiseQuoteId: quote.id, wiseRecipientId: String(recipientId) });
  const transfer = await createTransfer({
    profileId,
    quoteId: quote.id,
    targetAccountId: recipientId,
    customerTransactionId: digest, // idempotency: one payout per on-chain transfer
  });
  await fundTransfer(profileId, transfer.id);
  await markPaidOut(row.id, String(transfer.id));
  return String(transfer.id);
}

export async function POST(req: Request) {
  const flag = await getFeatureFlag("cashout_enabled");
  if (!flag?.enabled) {
    return NextResponse.json({ error: "cash-out is not available" }, { status: 404 });
  }

  let body: ConfirmRequest;
  try {
    body = (await req.json()) as ConfirmRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.cashout_id || !body.digest) {
    return NextResponse.json({ error: "cashout_id and digest required" }, { status: 400 });
  }

  const row = await getById(body.cashout_id);
  if (!row) return NextResponse.json({ error: "cash-out not found" }, { status: 404 });

  // Idempotency / replay binding.
  if (row.status === "paid_out") {
    return NextResponse.json({ status: "paid_out", wise_transfer_id: row.wise_transfer_id, net_sgd_minor: row.net_sgd_minor });
  }
  if (row.sui_digest && row.sui_digest !== body.digest) {
    return NextResponse.json({ error: "this cash-out is bound to a different transfer" }, { status: 409 });
  }
  if (Date.now() - new Date(row.created_at).getTime() > MAX_SIGNED_AGE_MS) {
    await markFailed(row.id, "quote expired before confirmation");
    return NextResponse.json({ error: "this cash-out expired — please start again" }, { status: 410 });
  }

  const treasury = loadTreasuryKeypair().toSuiAddress();

  // Step 1: verify on-chain receipt (only for not-yet-received rows).
  let working = row;
  if (row.status === "signed") {
    const verify = await verifyOnChain(body.digest, row.owner, treasury, BigInt(row.amount_usdsui_minor));
    if (!verify.ok) {
      return NextResponse.json({ error: `could not verify transfer: ${verify.reason}` }, { status: 400 });
    }
    try {
      working = await markReceived(row.id, body.digest);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      return NextResponse.json({ error: e instanceof Error ? e.message : "confirm failed" }, { status });
    }
  }

  // Step 2: Wise sandbox payout. Funds are already in treasury, so a
  // failure here is "payout pending", never a silent loss (D3).
  try {
    const wiseTransferId = await payOut(working, body.digest);
    return NextResponse.json({ status: "paid_out", wise_transfer_id: wiseTransferId, net_sgd_minor: working.net_sgd_minor });
  } catch (e) {
    await markFailed(working.id, e instanceof Error ? e.message : String(e)).catch(() => {});
    console.error(`[cashout] payout failed for ${working.id} (digest ${body.digest}):`, e);
    return NextResponse.json(
      {
        status: "pending",
        message: "Your USDsui was received. The SGD payout is pending and will be retried.",
        cashout_id: working.id,
      },
      { status: 202 },
    );
  }
}
