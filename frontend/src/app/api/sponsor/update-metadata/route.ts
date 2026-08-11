import "server-only";

import { Transaction } from "@mysten/sui/transactions";
import { NextResponse } from "next/server";

import {
  checkAndIncrementSponsorUsage,
  loadSponsorKeypair,
} from "@/lib/server/sponsor";
import { looksLikeUen } from "@/lib/sgqr";
import { QUAY } from "@/lib/sui-config";
import { getSuiClient } from "@/lib/sui-client";

export const runtime = "nodejs";

/**
 * Sponsored merchant metadata update.
 *
 * Mirror of /api/sponsor/register but for `payments::update_merchant_metadata`.
 * Used by /merchant/wallet → "Settlement preference" → save, so a merchant
 * who has zero SUI in their zkLogin wallet can still change their preferred
 * receive token (or rotate their logo) without us putting the cost of the
 * gas back on them.
 *
 * The on-chain side already enforces ownership via `E_NOT_MERCHANT_OWNER`,
 * so the rate limit here is the only check that matters server-side — a
 * malicious caller can't sign for someone else's UEN regardless of what
 * they POST. We still limit per claimer to prevent sponsor-pool drain.
 */

const DAILY_CAP = 10;
const LOW_BALANCE_FLOOR_MIST = 40_000_000n; // 20% of 200M target
const CLOCK = "0x6";

const sui = getSuiClient();

interface SponsorUpdateMetadataRequest {
  uen: string;
  owner: string;
  /**
   * Bare Walrus blob ID for the new v1 profile JSON. `null` (or absent)
   * clears the on-chain pointer (rare — merchants almost always want to
   * preserve their logo while changing the receive token).
   */
  new_metadata_blob_id?: string | null;
}

interface SponsorUpdateMetadataResponse {
  tx_bytes_b64: string;
  sponsor_signature: string;
  sponsor_address: string;
  daily_cap: number;
}

export async function POST(req: Request) {
  let body: SponsorUpdateMetadataRequest;
  try {
    body = (await req.json()) as SponsorUpdateMetadataRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.uen || !body.owner) {
    return NextResponse.json({ error: "uen and owner required" }, { status: 400 });
  }
  if (!looksLikeUen(body.uen)) {
    return NextResponse.json({ error: `UEN '${body.uen}' invalid` }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]+$/.test(body.owner)) {
    return NextResponse.json({ error: "invalid owner address" }, { status: 400 });
  }
  if (
    body.new_metadata_blob_id !== undefined &&
    body.new_metadata_blob_id !== null &&
    typeof body.new_metadata_blob_id !== "string"
  ) {
    return NextResponse.json({ error: "new_metadata_blob_id must be string | null" }, { status: 400 });
  }

  // Rate limit — production-only. Dev skips the cap for iterative testing.
  if (process.env.NODE_ENV !== "development") {
    const usageCheck = await checkAndIncrementSponsorUsage(body.owner, DAILY_CAP);
    if (!usageCheck.ok) {
      return NextResponse.json(
        {
          error: "daily sponsored-gas cap reached for this address",
          cap: DAILY_CAP,
          reset_at_ms: usageCheck.resetAt,
        },
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
      {
        error: "sponsor balance below floor — refusing to sign",
        sponsor_balance_mist: sponsorBal.balance.balance,
        floor_mist: LOW_BALANCE_FLOOR_MIST.toString(),
      },
      { status: 503 },
    );
  }

  const tx = new Transaction();
  tx.setSender(body.owner);
  tx.setGasOwner(sponsorAddr);
  tx.setGasBudget(10_000_000n);
  tx.moveCall({
    target: `${QUAY.packageId}::payments::update_merchant_metadata`,
    arguments: [
      tx.object(QUAY.registryId),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(body.uen))),
      body.new_metadata_blob_id
        ? tx.pure.option("string", body.new_metadata_blob_id)
        : tx.pure.option("string", null),
      tx.object(CLOCK),
    ],
  });

  let txBytes: Uint8Array;
  try {
    txBytes = await tx.build({ client: sui });
  } catch (e) {
    return NextResponse.json(
      { error: `tx build failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  const sponsorSig = await sponsor.signTransaction(txBytes);

  const response: SponsorUpdateMetadataResponse = {
    tx_bytes_b64: Buffer.from(txBytes).toString("base64"),
    sponsor_signature: sponsorSig.signature,
    sponsor_address: sponsorAddr,
    daily_cap: DAILY_CAP,
  };
  return NextResponse.json(response);
}
