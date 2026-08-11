/**
 * BCS schemas for the on-chain Move structs Quay reads.
 *
 * Under JSON-RPC, `getObject({ showContent: true })` returned Move structs
 * pre-parsed into a JSON `fields` bag, so readers could just walk
 * `content.fields.entries.fields.id.id`. gRPC does not do that — it returns the
 * raw BCS bytes of the struct and expects the caller to decode them. These
 * schemas are that decoder.
 *
 * They must stay byte-for-byte in step with `move/quay/sources/payments.move`.
 * BCS is positional: reorder two fields here, or change a `u64` to a `u8`, and
 * decoding silently produces garbage rather than throwing. Treat this file the
 * same way `lib/server/kyb-attestation.ts` treats `ClaimMessage`.
 */

import { bcs } from "@mysten/sui/bcs";

/**
 * `sui::table::Table<K, V>` — the on-chain struct is `{ id: UID, size: u64 }`.
 * The keys and values live in dynamic fields hanging off `id`, not inline, so
 * the type parameters do not appear in the encoding at all.
 */
export const TableBcs = bcs.struct("Table", {
  id: bcs.Address,
  size: bcs.u64(),
});

/** `quay::payments::MerchantRegistry` (payments.move). */
export const MerchantRegistryBcs = bcs.struct("MerchantRegistry", {
  id: bcs.Address,
  issuer_pubkey: bcs.vector(bcs.u8()),
  chain_id: bcs.u8(),
  admin: bcs.Address,
  /** key = blake2b256(b"PAYNOW_UEN_V1" || uen_bytes) */
  entries: TableBcs,
  used_nonces: TableBcs,
});

/** `quay::payments::MerchantEntry` — the value stored per claimed UEN. */
export const MerchantEntryBcs = bcs.struct("MerchantEntry", {
  sui_address: bcs.Address,
  claimed_at_ms: bcs.u64(),
  uen_raw: bcs.vector(bcs.u8()),
  metadata_uri: bcs.option(bcs.string()),
  evidence_hash: bcs.vector(bcs.u8()),
});

/**
 * Encode a `vector<u8>` dynamic-field key the way `getDynamicField` wants it.
 * The gRPC API takes the field *name* as BCS bytes plus its type string, where
 * JSON-RPC took a plain JSON value.
 */
export function vectorU8FieldName(bytes: Uint8Array): {
  type: string;
  bcs: Uint8Array;
} {
  return {
    type: "vector<u8>",
    bcs: bcs.vector(bcs.u8()).serialize(bytes).toBytes(),
  };
}

/**
 * gRPC signals "this dynamic field does not exist" by throwing with an
 * object-not-found message rather than returning an empty result, so every
 * optional lookup has to pattern-match on it. Kept in one place because the
 * wording is the only thing separating "unclaimed UEN" from a real outage —
 * misclassify it and an RPC failure reads as "this UEN is free to claim".
 */
export function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("not found") ||
    msg.includes("notExists") ||
    msg.includes("does not exist") ||
    msg.includes("NOT_FOUND")
  );
}
