/**
 * Versioned `quote_metadata` codec for `PaymentReceipt.quote_metadata`.
 *
 * The Move side stores this field as `Option<vector<u8>>` — opaque bytes.
 * We use a self-describing version discriminator so the receipt verifier
 * dApp (Phase 5) and downstream indexers can route between v1 (pre-Walrus)
 * and v2 (with `receipt_blob_id`) payloads.
 *
 *   v1 (existing, on-wire):  "SQR1" + JSON-encoded quote-input fields
 *                            First byte: 0x53 ('S')
 *   v2 (this module):        0x02 || BCS(QuoteInputsV2 {
 *                              quote_inputs: vector<u8>,
 *                              receipt_blob_id: Option<vector<u8>>,
 *                            })
 *                            First byte: 0x02
 *
 * `quote_inputs` MUST be a v1 payload ("SQR1" + JSON) so v2 readers that
 * don't care about the receipt can extract the same audit data.
 *
 * Test that 0x02 doesn't collide with the v1 prefix: round-trip and version
 * detection assertions live in `__tests__/quote-metadata.test.ts`.
 */
import { bcs } from "@mysten/sui/bcs";

export const V2_DISCRIMINATOR = 0x02;

const QuoteInputsV2 = bcs.struct("QuoteInputsV2", {
  quote_inputs: bcs.vector(bcs.u8()),
  receipt_blob_id: bcs.option(bcs.vector(bcs.u8())),
});

export type QuoteMetadataVersion = 1 | 2;

export interface DecodedQuoteMetadata {
  version: QuoteMetadataVersion;
  /** Raw v1 payload bytes ("SQR1" + JSON). Present for both v1 and v2. */
  quoteInputs: Uint8Array;
  /** Walrus blob ID for the receipt proof, only present on v2 payloads. */
  receiptBlobId: string | null;
}

/**
 * Wrap an existing v1 `quote_inputs` ("SQR1" + JSON) plus optional Walrus
 * `receiptBlobId` into a v2-tagged byte string suitable for placing in the
 * `pay<T>` tx's `quote_metadata` Option<vector<u8>>.
 *
 * If `receiptBlobId` is undefined/null, the v2 payload still wraps the
 * quote inputs (useful for tests). In production, callers will only build
 * v2 when they have a blob_id to embed.
 */
export function encodeV2(
  quoteInputs: Uint8Array,
  receiptBlobId: string | null | undefined,
): Uint8Array {
  const blobBytes =
    receiptBlobId != null ? Array.from(new TextEncoder().encode(receiptBlobId)) : null;
  const body = QuoteInputsV2.serialize({
    quote_inputs: Array.from(quoteInputs),
    receipt_blob_id: blobBytes,
  }).toBytes();
  const out = new Uint8Array(1 + body.length);
  out[0] = V2_DISCRIMINATOR;
  out.set(body, 1);
  return out;
}

/**
 * Detect the on-wire version from the first byte.
 *
 * - 0x02 → v2 (this module)
 * - 0x53 ('S', start of "SQR1") → v1 (existing)
 * - anything else → throw — quote_metadata is corrupted or unknown version.
 */
export function detectVersion(bytes: Uint8Array): QuoteMetadataVersion {
  if (bytes.length === 0) throw new Error("quote_metadata: empty payload");
  const first = bytes[0];
  if (first === V2_DISCRIMINATOR) return 2;
  if (first === 0x53) return 1;
  throw new Error(
    `quote_metadata: unknown version discriminator 0x${first.toString(16).padStart(2, "0")}`,
  );
}

/**
 * Decode an on-wire `quote_metadata` payload to the structured form. Detects
 * version automatically. v1 payloads have `receiptBlobId: null` since there
 * is no Walrus reference in the older format.
 */
export function decode(bytes: Uint8Array): DecodedQuoteMetadata {
  const version = detectVersion(bytes);
  if (version === 1) {
    return { version: 1, quoteInputs: bytes, receiptBlobId: null };
  }
  // v2 — strip discriminator, BCS-decode the rest.
  const body = bytes.subarray(1);
  const parsed = QuoteInputsV2.parse(body) as {
    quote_inputs: number[];
    receipt_blob_id: number[] | null;
  };
  const quoteInputs = Uint8Array.from(parsed.quote_inputs);
  const receiptBlobId = parsed.receipt_blob_id
    ? new TextDecoder().decode(Uint8Array.from(parsed.receipt_blob_id))
    : null;
  return { version: 2, quoteInputs, receiptBlobId };
}

/**
 * Inspect the v1 inner payload (JSON after the "SQR1" magic). Returns the
 * parsed object or null if the payload isn't v1-shaped. Used by the verifier
 * dApp to render the audit fields.
 */
export function parseV1QuoteJson(quoteInputs: Uint8Array): Record<string, unknown> | null {
  if (quoteInputs.length < 4) return null;
  const magic = String.fromCharCode(
    quoteInputs[0],
    quoteInputs[1],
    quoteInputs[2],
    quoteInputs[3],
  );
  if (magic !== "SQR1") return null;
  try {
    const json = new TextDecoder().decode(quoteInputs.subarray(4));
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed != null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
