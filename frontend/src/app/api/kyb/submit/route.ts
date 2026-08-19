import "server-only";

import { NextResponse } from "next/server";

import { compareEntityNames, lookupAcraUen } from "@/lib/acra";
import type { AcraSnapshot } from "@/lib/kyb/types";
import {
  insertSubmission,
  releaseExpiredVerifications,
  KybStoreError,
} from "@/lib/server/kyb-store";
import { mintPollingToken } from "@/lib/server/polling-token";
import { issueVerification, resolvePayoutAddress } from "@/lib/server/verification";
import { lookupUen } from "@/lib/quay";
import { looksLikeUen } from "@/lib/sgqr";
import { QUAY } from "@/lib/sui-config";
import { getSuiClient } from "@/lib/sui-client";

export const runtime = "nodejs";

/**
 * Merchant onboarding, step one.
 *
 * Registers a claim on a UEN and starts PayNow verification: Quay sends
 * S$0.01 to the UEN proxy on the merchant's sticker carrying a reference
 * code, which they read off their bank statement and enter at
 * /api/kyb/verify-code.
 *
 * What changed and why:
 *
 *   - **No document.** This route used to accept an encrypted proof-of-
 *     ownership document for a human to review. An ACRA business profile is
 *     a public record any person can buy for S$5.50, so that review never
 *     established ownership — it only ever caught forgery, and only by eye.
 *   - **No human gate.** Reviewing a purchasable PDF is ceremony, not
 *     security. Proof of control over the receiving account replaces it.
 *   - **ACRA never blocks.** The register refreshes monthly, so a company
 *     incorporated three weeks ago is legitimately absent. A lookup that
 *     fails, times out, or returns nothing is recorded and waved through;
 *     the cent is what actually proves anything.
 */

const sui = getSuiClient();

interface SubmitRequestBody {
  uen?: string;
  /** Signboard name customers know. Optional. */
  trading_name?: string;
  /** Fallback registered name, used only when ACRA cannot supply one. */
  business_name?: string;
  claimer?: string;
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: SubmitRequestBody;
  try {
    body = (await req.json()) as SubmitRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // ── Validate ──
  if (!body.uen || !looksLikeUen(body.uen)) {
    return NextResponse.json({ error: `UEN '${body.uen ?? ""}' invalid` }, { status: 400 });
  }
  if (!body.claimer || !/^0x[0-9a-fA-F]+$/.test(body.claimer)) {
    return NextResponse.json({ error: "claimer address invalid" }, { status: 400 });
  }
  const uen = body.uen.trim().toUpperCase();

  // ── Release any expired hold on this UEN, opportunistically ──
  //
  // `awaiting_code` counts as an active claim in the uniqueness index, so an
  // abandoned verification blocks the real merchant. The sweeper cron exists
  // for this, but the Vercel Hobby plan allows only two cron slots and both
  // are already spoken for, so relying on it alone would mean shipping a
  // lockout with no scheduled remedy.
  //
  // Sweeping here instead is arguably better than a cron regardless: the
  // lockout is only observable when somebody tries to claim the UEN, which is
  // exactly this moment. Best-effort — a sweep failure must not block a claim.
  try {
    const released = await releaseExpiredVerifications();
    if (released.length > 0) {
      console.warn(
        `[/api/kyb/submit] released ${released.length} expired verification(s) before claim`,
      );
    }
  } catch (e) {
    console.warn(
      `[/api/kyb/submit] expired-verification sweep failed, continuing: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  // ── Already claimed on chain? ──
  try {
    const onChain = await lookupUen(sui, QUAY.registryId, uen);
    if (onChain.claimed) {
      return NextResponse.json(
        {
          error: `UEN ${uen} is already claimed on chain by ${onChain.owner}`,
          code: "already_claimed",
        },
        { status: 409 },
      );
    }
  } catch (e) {
    // RPC blip. Don't block: register_merchant rejects a duplicate on chain
    // with E_UEN_ALREADY_CLAIMED regardless.
    console.warn(
      `[/api/kyb/submit] on-chain preflight failed, proceeding: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  // ── ACRA machine checks. Informational only, never a gate. ──
  const acra = await lookupAcraUen(uen);
  let registeredName: string | null = null;
  let acraNote: string | null = null;

  if (acra.status === "found") {
    registeredName = acra.record.entityName;
    if (acra.record.status.toLowerCase() !== "registered") {
      // Recorded, not rejected: a deregistered UEN whose holder can still
      // read the account is a support conversation, not an attack.
      acraNote = `ACRA status is '${acra.record.status}'`;
    }
    const match = compareEntityNames(body.business_name, registeredName);
    if (match === "mismatch") {
      acraNote = [acraNote, "claimed name does not match the register"]
        .filter(Boolean)
        .join("; ");
    }
  } else if (acra.status === "not_found") {
    acraNote = "not in the ACRA register (may be newer than the monthly refresh)";
  } else {
    acraNote = `ACRA unavailable: ${acra.reason}`;
  }

  // The registered name is what gets bound on chain. Fall back to what the
  // merchant typed only when ACRA could not tell us.
  const businessName = registeredName ?? body.business_name?.trim() ?? undefined;
  if (!businessName) {
    return NextResponse.json(
      {
        error:
          "could not determine the registered business name — enter it manually and retry",
        code: "name_required",
      },
      { status: 400 },
    );
  }

  // Frozen here, at claim time, and never re-fetched. The register refreshes
  // monthly, so re-reading it at finalize could hash a different fact than the
  // one this claim was accepted under.
  const acraSnapshot: AcraSnapshot = {
    entity_name: registeredName,
    entity_status: acra.status === "found" ? acra.record.status : null,
    entity_type: acra.status === "found" ? acra.record.entityType : null,
    checked_at_ms: Date.now(),
    note: acraNote,
  };

  // ── Insert the claim ──
  let inserted: { id: string; submittedAt: string };
  try {
    inserted = await insertSubmission({
      walletAddress: body.claimer,
      uen,
      businessName,
      tradingName: body.trading_name?.trim() || undefined,
      acraSnapshot,
    });
  } catch (e) {
    if (e instanceof KybStoreError) {
      return NextResponse.json(
        {
          error: e.message,
          // The UI renders 409 as "someone just claimed this UEN" with a
          // contest route, never as a generic failure. Auto-approval shrinks
          // the claim race from a day to seconds, so this fires for real.
          code: e.status === 409 ? "just_claimed" : undefined,
        },
        { status: e.status },
      );
    }
    return NextResponse.json(
      { error: `db error: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  // ── Send the cent ──
  //
  // Wise's singapore_paynow payout needs the recipient's name and full
  // address, which a scanned sticker cannot provide but ACRA's per-letter
  // detail dataset can. Best-effort: on the manual rail an operator fills a
  // gap by hand rather than the merchant being blocked.
  const payout = registeredName
    ? await resolvePayoutAddress(uen, registeredName)
    : { address: null, line: null };

  const issued = await issueVerification({
    submissionId: inserted.id,
    uen,
    accountHolderName: businessName,
    address: payout.address,
  });

  if (issued.status === "conflict") {
    return NextResponse.json({ error: issued.message }, { status: 409 });
  }
  if (issued.status === "failed") {
    return NextResponse.json(
      { error: `could not start verification: ${issued.reason}` },
      { status: 502 },
    );
  }

  const pollingToken = await mintPollingToken({
    submissionId: inserted.id,
    walletAddress: body.claimer,
  });

  return NextResponse.json({
    submission_id: inserted.id,
    polling_token: pollingToken,
    status: "awaiting_code" as const,
    submitted_at: inserted.submittedAt,
    business_name: businessName,
    /** What the merchant should look for on their statement. */
    code_reference: issued.reference,
    code_expires_at: issued.expiresAt.toISOString(),
    /** False on the manual rail: a human still has to send it. */
    cent_sent: issued.sent,
    acra_note: acraNote,
  });
}
