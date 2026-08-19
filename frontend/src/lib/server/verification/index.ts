import "server-only";

import { lookupEntityDetail, formatAddressLine } from "@/lib/acra";
import type { AcraEntityDetail } from "@/lib/acra";
import {
  getCodeHash,
  markCentSent,
  markCodeFailed,
  markVerified,
  startVerification,
  KybStoreError,
} from "@/lib/server/kyb-store";

import { consumeCodeAttempt } from "./attempts";
import { codeMatches, formatReference, generateCode, hashCode } from "./codes";
import { getCentSender } from "./sender";

/**
 * PayNow micro-deposit verification.
 *
 * Quay sends S$0.01 to the UEN proxy on the merchant's SGQR sticker, carrying
 * a reference code. The merchant reads it off their bank statement and enters
 * it. Passing proves they can see deposits into that exact account, which is
 * the account the sticker pays into and therefore the thing actually at risk.
 *
 * The check is a challenge we issue, not evidence the claimant selects. That
 * is the whole point: anything the claimant hands over, they can shop for —
 * which is precisely how document review failed, since an ACRA business
 * profile is a public record anyone can buy for S$5.50.
 */

/** How long a merchant has to read their statement and come back. */
const CODE_TTL_MS = 24 * 60 * 60 * 1000;

export type IssueOutcome =
  | { status: "issued"; reference: string; expiresAt: Date; sent: boolean }
  | { status: "conflict"; message: string }
  | { status: "failed"; reason: string };

/**
 * Issue a code and ask the rail to send the cent.
 *
 * Ordering matters: the row moves to `awaiting_code` BEFORE the send is
 * attempted. If it were the other way round, a crash between send and write
 * would leave a cent in the wild with no record of what code it carried, and
 * the merchant holding a code that verifies against nothing.
 */
export async function issueVerification(params: {
  submissionId: string;
  uen: string;
  /** ACRA-registered name. Wise requires an account holder name. */
  accountHolderName: string;
  /** Full address for the payout. Null when ACRA could not supply it. */
  address?: AcraEntityDetail["address"] | null;
}): Promise<IssueOutcome> {
  const code = generateCode();
  const reference = formatReference(code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  try {
    await startVerification({
      id: params.submissionId,
      codeHashHex: Buffer.from(hashCode(code)).toString("hex"),
      reference,
      expiresAt,
    });
  } catch (e) {
    if (e instanceof KybStoreError && e.status === 409) {
      return { status: "conflict", message: e.message };
    }
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }

  const sender = getCentSender();
  const result = await sender.send({
    uen: params.uen,
    reference,
    accountHolderName: params.accountHolderName,
    address: params.address ?? null,
  });

  if (result.status === "sent") {
    await markCentSent(params.submissionId).catch((e) => {
      // The cent is already gone; failing to record that is bad but not worth
      // failing the request over. The merchant can still verify.
      console.error(
        `[verification] sent but failed to record for ${params.submissionId}: ${e}`,
      );
    });
    return { status: "issued", reference, expiresAt, sent: true };
  }

  if (result.status === "queued") {
    // A human still has to push the button. The row IS the queue.
    return { status: "issued", reference, expiresAt, sent: false };
  }

  return { status: "failed", reason: result.reason };
}

export type VerifyOutcome =
  | { status: "verified" }
  | { status: "wrong"; remaining: number }
  | { status: "locked" }
  | { status: "unavailable" }
  | { status: "no_pending_code" };

/**
 * Check a code the merchant typed.
 *
 * The attempt is consumed BEFORE the comparison, so a wrong guess costs an
 * attempt whether or not the comparison path throws. Comparison itself is
 * constant-time over fixed-length hashes (see codes.ts).
 */
export async function verifyCode(
  submissionId: string,
  submitted: string,
): Promise<VerifyOutcome> {
  const attempt = await consumeCodeAttempt(submissionId);
  if (!attempt.allowed) {
    if (attempt.reason === "unavailable") return { status: "unavailable" };
    await markCodeFailed(submissionId).catch(() => {});
    return { status: "locked" };
  }

  const expected = await getCodeHash(submissionId);
  if (!expected) {
    // No live code: expired and swept, already verified, or locked out.
    return { status: "no_pending_code" };
  }

  if (!codeMatches(submitted, expected)) {
    if (attempt.remaining <= 0) {
      await markCodeFailed(submissionId).catch(() => {});
      return { status: "locked" };
    }
    return { status: "wrong", remaining: attempt.remaining };
  }

  await markVerified(submissionId, "paynow_microdeposit");
  return { status: "verified" };
}

/**
 * Best-effort payout address for the send. Never throws and never blocks:
 * ACRA is a convenience here, and a missing address only means the operator
 * fills it in by hand on the manual rail.
 */
export async function resolvePayoutAddress(
  uen: string,
  entityName: string,
): Promise<{ address: AcraEntityDetail["address"] | null; line: string | null }> {
  const detail = await lookupEntityDetail(uen, entityName);
  if (detail.status !== "found") return { address: null, line: null };
  return {
    address: detail.record.address,
    line: formatAddressLine(detail.record),
  };
}

export { MAX_ATTEMPTS } from "./attempts";
export {
  MAX_REFERENCE_LENGTH,
  formatReference,
  generateCode,
  hashCode,
  normalizeCodeInput,
  codeMatches,
} from "./codes";
export type { CentSender, CentSendRequest, CentSendResult } from "./sender";
export { FakeCentSender, ManualCentSender, getCentSender } from "./sender";
