import "server-only";

import { NextResponse } from "next/server";

import {
  buildReceipt,
  receiptToBytes,
  type BuildReceiptInputs,
} from "@/lib/receipts/builder";
import {
  uploadBlob,
  WalrusRateLimitError,
  WalrusUploadError,
} from "@/lib/walrus/client";

export const runtime = "nodejs";

/**
 * Pre-tx receipt upload endpoint (D3).
 *
 * Flow:
 *   1. Frontend POSTs receipt fields (BuildReceiptInputs JSON)
 *   2. We validate, canonical-stringify, upload to Walrus
 *   3. Return { blob_id, size } so the frontend can stitch the blob_id
 *      into the pay tx's quote_metadata (v2 BCS) before submission
 *
 * Rate limit per source IP (V0: 10/min in-memory) to bound orphan-blob
 * farming (D14). Walrus errors map to 429/502 with typed responses so
 * the client can render the right user-facing message per D7.
 */

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_PER_WINDOW = 10;
const ipUsage = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(ip: string): { ok: true } | { ok: false; retryAt: number } {
  const now = Date.now();
  const e = ipUsage.get(ip);
  if (!e || now - e.windowStart > RATE_WINDOW_MS) {
    ipUsage.set(ip, { count: 1, windowStart: now });
    return { ok: true };
  }
  if (e.count >= RATE_MAX_PER_WINDOW) {
    return { ok: false, retryAt: e.windowStart + RATE_WINDOW_MS };
  }
  e.count += 1;
  return { ok: true };
}

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

interface ReceiptRequestBody {
  receipt_id_hex: string;
  payer: string;
  merchant: string;
  uen_raw: string;
  /** Stringified bigint, e.g., "1000000". */
  amount: string;
  token_type: string;
  sgd_minor_units: number;
  timestamp_ms: number;
  quote?: Record<string, unknown>;
  memo?: string;
}

function toInputs(body: ReceiptRequestBody): BuildReceiptInputs {
  if (typeof body.amount !== "string" || !/^[0-9]+$/.test(body.amount)) {
    throw new Error("amount must be a decimal string");
  }
  return {
    receiptIdHex: body.receipt_id_hex,
    payer: body.payer,
    merchant: body.merchant,
    uenRaw: body.uen_raw,
    amount: BigInt(body.amount),
    tokenType: body.token_type,
    sgdMinorUnits: body.sgd_minor_units,
    timestampMs: body.timestamp_ms,
    quote: body.quote,
    memo: body.memo,
  };
}

export async function POST(req: Request) {
  const ip = clientIp(req);

  // Skip rate limit in development for iterative testing parity with /api/sponsor/register.
  if (process.env.NODE_ENV !== "development") {
    const rl = checkRateLimit(ip);
    if (!rl.ok) {
      return NextResponse.json(
        {
          error: "rate limit: too many receipt uploads",
          retry_at_ms: rl.retryAt,
          window_ms: RATE_WINDOW_MS,
          max_per_window: RATE_MAX_PER_WINDOW,
        },
        { status: 429 },
      );
    }
  }

  let body: ReceiptRequestBody;
  try {
    body = (await req.json()) as ReceiptRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  let inputs: BuildReceiptInputs;
  try {
    inputs = toInputs(body);
  } catch (e) {
    return NextResponse.json(
      { error: `invalid receipt fields: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  }

  let bytes: Uint8Array;
  try {
    const receipt = buildReceipt(inputs);
    bytes = receiptToBytes(receipt);
  } catch (e) {
    return NextResponse.json(
      { error: `receipt build failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  }

  try {
    const result = await uploadBlob(bytes);
    return NextResponse.json({
      blob_id: result.blobId,
      size: result.size,
      certified_epoch: result.certifiedEpoch,
    });
  } catch (e) {
    if (e instanceof WalrusRateLimitError) {
      return NextResponse.json(
        { error: "Walrus publisher rate-limited; retry shortly", upstream: "walrus" },
        { status: 429 },
      );
    }
    if (e instanceof WalrusUploadError) {
      return NextResponse.json(
        {
          error: `Walrus upload failed: ${e.message}`,
          retryable: e.retryable,
          upstream: "walrus",
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: `unexpected: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
}
