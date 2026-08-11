import "server-only";

import { NextResponse } from "next/server";

import { insertSubmission, KybStoreError } from "@/lib/server/kyb-store";
import { mintPollingToken } from "@/lib/server/polling-token";
import { lookupUen } from "@/lib/quay";
import { looksLikeUen } from "@/lib/sgqr";
import { QUAY } from "@/lib/sui-config";
import {
  uploadBlob,
  WalrusRateLimitError,
  WalrusUploadError,
} from "@/lib/walrus/client";
import { getSuiClient } from "@/lib/sui-client";

export const runtime = "nodejs";

/**
 * Merchant KYB submission.
 *
 * Receives an already-encrypted document (client-side AES-256-GCM + NaCl
 * sealed-box-wrapped DEK), uploads the ciphertext to Walrus, and inserts
 * a pending row in `kyb_submissions`. Returns a polling token bound to
 * the submission so /api/kyb/status can be called statelessly.
 *
 * The server NEVER sees plaintext doc bytes or the DEK. Decryption
 * happens only in the admin's browser at review time, using a key derived
 * from the admin's wallet signature.
 */

const MAX_CIPHERTEXT_BYTES = 5 * 1024 * 1024 + 64; // 5 MB doc + GCM tag headroom
const MAX_NONCE_BYTES = 24; // typical 12, room for AAD-bound variants
const MAX_WRAPPED_DEK_BYTES = 256; // sealed-box of 32 bytes = 80 bytes, headroom
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const sui = getSuiClient();

interface SubmitRequestBody {
  uen?: string;
  business_name?: string;
  ciphertext_b64?: string;
  ciphertext_nonce_b64?: string;
  wrapped_dek_b64?: string;
  kyb_doc_hash_hex?: string;
  original_mime_type?: string;
  claimer?: string;
}

interface SubmitResponseBody {
  submission_id: string;
  polling_token: string;
  status: "pending";
  submitted_at: string;
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: SubmitRequestBody;
  try {
    body = (await req.json()) as SubmitRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // ── Validate inputs ──
  if (!body.uen || !looksLikeUen(body.uen)) {
    return NextResponse.json({ error: `UEN '${body.uen ?? ""}' invalid` }, { status: 400 });
  }
  if (!body.claimer || !/^0x[0-9a-fA-F]+$/.test(body.claimer)) {
    return NextResponse.json({ error: "claimer address invalid" }, { status: 400 });
  }
  if (!body.ciphertext_b64 || !body.ciphertext_nonce_b64 || !body.wrapped_dek_b64) {
    return NextResponse.json(
      { error: "ciphertext_b64, ciphertext_nonce_b64, wrapped_dek_b64 all required" },
      { status: 400 },
    );
  }
  if (!body.kyb_doc_hash_hex || !/^[0-9a-fA-F]{64}$/.test(body.kyb_doc_hash_hex)) {
    return NextResponse.json(
      { error: "kyb_doc_hash_hex must be a 64-char hex string (32 bytes)" },
      { status: 400 },
    );
  }
  if (!body.original_mime_type || !ALLOWED_MIME.has(body.original_mime_type)) {
    return NextResponse.json(
      { error: `original_mime_type must be one of ${[...ALLOWED_MIME].join(", ")}` },
      { status: 400 },
    );
  }

  let ciphertext: Uint8Array;
  let nonce: Uint8Array;
  let wrappedDek: Uint8Array;
  try {
    ciphertext = Buffer.from(body.ciphertext_b64, "base64");
    nonce = Buffer.from(body.ciphertext_nonce_b64, "base64");
    wrappedDek = Buffer.from(body.wrapped_dek_b64, "base64");
  } catch {
    return NextResponse.json({ error: "base64 decode failed" }, { status: 400 });
  }
  if (ciphertext.length === 0 || ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    return NextResponse.json(
      { error: `ciphertext size out of range (got ${ciphertext.length} bytes)` },
      { status: 413 },
    );
  }
  if (nonce.length === 0 || nonce.length > MAX_NONCE_BYTES) {
    return NextResponse.json({ error: "nonce size out of range" }, { status: 400 });
  }
  if (wrappedDek.length === 0 || wrappedDek.length > MAX_WRAPPED_DEK_BYTES) {
    return NextResponse.json({ error: "wrapped_dek size out of range" }, { status: 400 });
  }

  // ── Pre-flight: UEN already on-chain? ──
  try {
    const onChain = await lookupUen(sui, QUAY.registryId, body.uen);
    if (onChain.claimed) {
      return NextResponse.json(
        { error: `UEN ${body.uen} is already claimed on chain by ${onChain.owner}` },
        { status: 409 },
      );
    }
  } catch (e) {
    // RPC blip — don't block submission, the on-chain register_merchant
    // call at finalize-time will reject the dup with E_UEN_ALREADY_CLAIMED.
    console.warn(
      `[/api/kyb/submit] UEN preflight failed, proceeding anyway: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  // ── Upload ciphertext to Walrus (hard-fail before any DB write). ──
  let blobId: string;
  try {
    const uploaded = await uploadBlob(ciphertext as Uint8Array<ArrayBuffer>);
    blobId = uploaded.blobId;
  } catch (e) {
    if (e instanceof WalrusRateLimitError) {
      return NextResponse.json(
        { error: "Walrus rate-limited; retry shortly", upstream: "walrus" },
        { status: 429 },
      );
    }
    if (e instanceof WalrusUploadError) {
      return NextResponse.json(
        { error: `ciphertext upload failed: ${e.message}`, upstream: "walrus", retryable: e.retryable },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: `unexpected: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  // ── Insert pending row. Partial unique idx may 409 on dup wallet/UEN. ──
  let inserted: { id: string; submittedAt: string };
  try {
    inserted = await insertSubmission({
      walletAddress: body.claimer,
      uen: body.uen,
      businessName: body.business_name?.trim() || undefined,
      ciphertextBlobId: blobId,
      ciphertextNonceB64: body.ciphertext_nonce_b64,
      wrappedDekB64: body.wrapped_dek_b64,
      originalMimeType: body.original_mime_type,
      kybDocHashHex: body.kyb_doc_hash_hex.toLowerCase(),
    });
  } catch (e) {
    if (e instanceof KybStoreError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: `db error: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  // ── Mint polling token for status checks. ──
  let pollingToken: string;
  try {
    pollingToken = await mintPollingToken({
      submissionId: inserted.id,
      walletAddress: body.claimer,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `failed to mint polling token: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  const response: SubmitResponseBody = {
    submission_id: inserted.id,
    polling_token: pollingToken,
    status: "pending",
    submitted_at: inserted.submittedAt,
  };
  return NextResponse.json(response);
}
