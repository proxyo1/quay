/**
 * Canonical receipt JSON builder (D20).
 *
 * The bytes produced here are what gets uploaded to Walrus and content-hashed.
 * Phase 5 verifier dApp fetches by blob_id, decodes with this schema, and
 * cross-references the on-chain PaymentReceipt event.
 *
 * Schema versioning: the JSON itself carries `schema_version: 1` at the root.
 * That's independent of the BCS v2 discriminator in `quote_metadata` —
 * see [quote-metadata.ts](../sgqr/quote-metadata.ts) for the on-wire format.
 *
 * Determinism: callers should build the receipt with the same field order
 * and stringify so the resulting bytes hash deterministically across browser
 * + server runs. `stringifyReceipt` enforces canonical key ordering.
 */

export const RECEIPT_SCHEMA_VERSION = 1 as const;

export interface ReceiptQuote {
  /** Pyth or other oracle feed identifier used. */
  feed?: string;
  /** Price snapshot in USD as a decimal string. */
  price_usd?: string;
  /** SGD/USD rate snapshot if applicable. */
  sgd_per_usd?: string;
  /** Free-form extra fields preserved across versions. */
  [k: string]: unknown;
}

export interface Receipt {
  /** Always 1 for the V0 schema. Future bumps require a /verify migration. */
  schema_version: typeof RECEIPT_SCHEMA_VERSION;
  /** Deterministic receipt ID from the Move contract:
   *  blake2b256(uen_hash || payer || timestamp_ms || amount). 32-byte hex. */
  receipt_id: string;
  /** Sui address (0x-prefixed) that initiated the pay tx. */
  payer: string;
  /** Sui address that received the funds (the merchant's wallet). */
  merchant: string;
  /** Raw UEN string (recovered from on-chain `uen_raw` field). */
  uen_raw: string;
  /** Amount in token base units (e.g., MIST for SUI), as a decimal string. */
  amount: string;
  /** Sui Move type name of the coin (e.g., "0x2::sui::SUI"). */
  token_type: string;
  /** SGD-equivalent amount in minor units, mirroring PaymentReceipt event. */
  sgd_minor_units: number;
  /** Clock timestamp at pay-tx time, in milliseconds. */
  timestamp_ms: number;
  /** Quote inputs used to compute the SGD amount (mirrors v1 quote_metadata). */
  quote?: ReceiptQuote;
  /** Optional UTF-8 memo from the payer. */
  memo?: string;
}

export interface BuildReceiptInputs {
  receiptIdHex: string; // 64-char hex, lowercase preferred
  payer: string;
  merchant: string;
  uenRaw: string;
  amount: bigint;
  tokenType: string;
  sgdMinorUnits: number;
  timestampMs: number;
  quote?: ReceiptQuote;
  memo?: string;
}

/**
 * Build a Receipt object suitable for stringification + Walrus upload.
 *
 * Throws if any required field is empty / malformed. Callers in
 * `/api/receipts` rely on this validation to reject bad client input.
 */
export function buildReceipt(input: BuildReceiptInputs): Receipt {
  if (!/^[0-9a-fA-F]{64}$/.test(input.receiptIdHex)) {
    throw new Error("receipt_id must be 64-char hex");
  }
  if (!/^0x[0-9a-fA-F]+$/.test(input.payer)) {
    throw new Error("payer must be a 0x-prefixed Sui address");
  }
  if (!/^0x[0-9a-fA-F]+$/.test(input.merchant)) {
    throw new Error("merchant must be a 0x-prefixed Sui address");
  }
  if (input.uenRaw.length === 0) throw new Error("uen_raw required");
  if (input.amount <= 0n) throw new Error("amount must be > 0");
  if (!Number.isFinite(input.timestampMs) || input.timestampMs <= 0) {
    throw new Error("timestamp_ms must be positive");
  }

  const receipt: Receipt = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    receipt_id: input.receiptIdHex.toLowerCase(),
    payer: input.payer,
    merchant: input.merchant,
    uen_raw: input.uenRaw,
    amount: input.amount.toString(),
    token_type: input.tokenType,
    sgd_minor_units: input.sgdMinorUnits,
    timestamp_ms: input.timestampMs,
  };
  if (input.quote) receipt.quote = input.quote;
  if (input.memo) receipt.memo = input.memo;
  return receipt;
}

/**
 * Deterministic JSON stringification — sorts keys alphabetically at every
 * level. Different runtimes (Node, browser, Bun) and different field-
 * insertion orders all produce the same bytes, so the Walrus upload's
 * content hash is reproducible.
 */
export function stringifyReceipt(receipt: Receipt): string {
  return canonicalStringify(receipt);
}

export function receiptToBytes(receipt: Receipt): Uint8Array {
  return new TextEncoder().encode(stringifyReceipt(receipt));
}

function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in receipt");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") {
    // Receipts only use bigint via .toString() in buildReceipt; reject raw bigint
    // here to surface mistakes loudly.
    throw new Error("bigint values must be stringified before canonical encode");
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return (
      "{" +
      keys
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonicalStringify((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  }
  throw new Error(`canonicalStringify: unsupported value type ${typeof value}`);
}
