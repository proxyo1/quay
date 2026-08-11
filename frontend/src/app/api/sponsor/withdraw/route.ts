import "server-only";

import { NextResponse } from "next/server";

import {
  checkAndIncrementSponsorUsage,
  loadSponsorKeypair,
} from "@/lib/server/sponsor";
import { buildSponsoredUsdsuiTransfer, InsufficientUsdsuiError } from "@/lib/quay/transfer";
import { getSuiClient } from "@/lib/sui-client";

export const runtime = "nodejs";

/**
 * Sponsored, NON-custodial USDsui withdrawal to an arbitrary Sui address.
 * Distinct from cash-out: no treasury, no Wise, no DB row — the merchant's
 * USDsui goes straight to the destination in one atomic transfer. Sponsor
 * pays gas so a zero-SUI merchant can still withdraw.
 *
 * The merchant zkLogin-signs the returned tx and submits it dual-signed.
 * On-chain transfers are final; the irreversible-confirm guard lives in the
 * UI (D4-design) — server-side we validate the address shape and amount.
 */

const DAILY_CAP = 10;
const LOW_BALANCE_FLOOR_MIST = 40_000_000n;
const FULL_ADDR = /^0x[0-9a-fA-F]{64}$/;

const sui = getSuiClient();

interface WithdrawRequest {
  owner: string;
  destination: string;
  amount_usdsui_minor: string | number;
}

export async function POST(req: Request) {
  let body: WithdrawRequest;
  try {
    body = (await req.json()) as WithdrawRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!body.owner || !/^0x[0-9a-fA-F]{1,64}$/.test(body.owner)) {
    return NextResponse.json({ error: "invalid owner address" }, { status: 400 });
  }
  // Destination must be a FULL 32-byte address — a truncated/typo'd address
  // would send funds into the void irrecoverably.
  if (!body.destination || !FULL_ADDR.test(body.destination)) {
    return NextResponse.json(
      { error: "destination must be a full 0x + 64 hex Sui address" },
      { status: 400 },
    );
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
    const usage = await checkAndIncrementSponsorUsage(body.owner, DAILY_CAP);
    if (!usage.ok) {
      return NextResponse.json(
        { error: "daily withdraw cap reached for this address", cap: DAILY_CAP, reset_at_ms: usage.resetAt },
        { status: 429 },
      );
    }
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
  if (BigInt(sponsorBal.balance.balance) < LOW_BALANCE_FLOOR_MIST) {
    return NextResponse.json(
      { error: "sponsor balance below floor — refusing to sign" },
      { status: 503 },
    );
  }

  let txBytes: Uint8Array;
  try {
    const tx = await buildSponsoredUsdsuiTransfer({
      sui,
      owner: body.owner,
      destination: body.destination,
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

  return NextResponse.json({
    tx_bytes_b64: Buffer.from(txBytes).toString("base64"),
    sponsor_signature: sponsorSig.signature,
    sponsor_address: sponsorAddr,
    destination: body.destination,
    amount_usdsui_minor: amountMinor.toString(),
  });
}
