import "server-only";

import type { AcraEntityDetail } from "@/lib/acra";

/**
 * The seam between "we decided to verify this merchant" and "a cent actually
 * left an account".
 *
 * Everything on our side of this interface — the code, the state machine, the
 * attempt cap, expiry, resend — is identical whether the transfer is made by
 * an API call or by a person with a banking app. Keeping the boundary explicit
 * is what lets the manual rail ship now and automation land later as a swap
 * rather than a rewrite.
 *
 * It is also the test boundary: the send leg cannot run in CI, so tests use
 * FakeSender and one documented manual procedure covers the part a test
 * genuinely cannot reach (that a real cent arrives with a readable code).
 */

export interface CentSendRequest {
  /** UEN PayNow proxy to pay. The proxy the SGQR sticker encodes. */
  uen: string;
  /** Goes in the PayNow reference, e.g. "QUAY-7F3K9M". */
  reference: string;
  /** Registered entity name. Wise requires `accountHolderName`. */
  accountHolderName: string;
  /**
   * Full address. Wise's `singapore_paynow` requires country, city, first
   * line and post code, none of which a scanned sticker provides — this is
   * why the ACRA detail lookup is load-bearing rather than cosmetic.
   * Null when ACRA was unavailable or the detail row could not be matched.
   */
  address: AcraEntityDetail["address"] | null;
}

export type CentSendResult =
  /** Money is on its way. `providerRef` is for support lookups. */
  | { status: "sent"; providerRef: string | null }
  /** Accepted, but a human still has to push the button. */
  | { status: "queued" }
  /** Not sent, and not retryable without someone changing something. */
  | { status: "failed"; reason: string };

export interface CentSender {
  readonly name: string;
  send(req: CentSendRequest): Promise<CentSendResult>;
}

/**
 * The rail that ships first: a person sends the cent from a business banking
 * app.
 *
 * The security property lives entirely in the code round-trip, not in who
 * pushed the button, so this is exactly as strong as an automated send. It
 * just does not scale past pilot volume.
 *
 * There is no separate queue table: a submission sitting in `awaiting_code`
 * with `code_sent_at IS NULL` *is* the queue, and the admin exception surface
 * lists them. One source of truth beats two that can disagree.
 */
export class ManualCentSender implements CentSender {
  readonly name = "manual";

  async send(req: CentSendRequest): Promise<CentSendResult> {
    // Deliberately loud: this is an operator action item, and until someone
    // acts on it the merchant is stuck waiting. Vercel surfaces console.error
    // in the log drain, which is where operators already look.
    console.error(
      `[verification] MANUAL SEND REQUIRED — pay S$0.01 via PayNow to UEN ${req.uen}` +
        ` with reference "${req.reference}" (holder: ${req.accountHolderName})`,
    );
    return { status: "queued" };
  }
}

/**
 * Test double. Records what it was asked to send so assertions can check the
 * reference actually reached the rail.
 */
export class FakeCentSender implements CentSender {
  readonly name = "fake";
  readonly sent: CentSendRequest[] = [];
  constructor(private readonly outcome: CentSendResult = { status: "sent", providerRef: "fake-ref" }) {}

  async send(req: CentSendRequest): Promise<CentSendResult> {
    this.sent.push(req);
    return this.outcome;
  }
}

/**
 * Which rail is live.
 *
 * A Wise-backed sender is viable — `singapore_paynow` accepts a UEN in its
 * `accountNumber` field (docs/wise-paynow-probe.md) — but it is deliberately
 * not implemented yet: it moves real money, the plan ships the manual rail
 * first, and the reference-length question is still open. Add it here when
 * that is settled, and nothing above this line has to change.
 */
export function getCentSender(): CentSender {
  return new ManualCentSender();
}
