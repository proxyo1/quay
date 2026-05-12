import { blake2b } from "@noble/hashes/blake2.js";
import type { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";

const PAYNOW_UEN_V1 = new TextEncoder().encode("PAYNOW_UEN_V1");

/**
 * Mirror of `payments::derive_uen_hash` in Move. The `entries` table inside
 * the registry is keyed by this hash, NOT the raw UEN, so the same derivation
 * must run on both sides for any lookup to succeed.
 */
export function deriveUenHash(uen: string): Uint8Array {
  const uenBytes = new TextEncoder().encode(uen);
  const buf = new Uint8Array(PAYNOW_UEN_V1.length + uenBytes.length);
  buf.set(PAYNOW_UEN_V1, 0);
  buf.set(uenBytes, PAYNOW_UEN_V1.length);
  return blake2b(buf, { dkLen: 32 });
}

/**
 * Resolve the UID of the `entries: Table<vector<u8>, MerchantEntry>` inside
 * the registry. `Table` in Sui Move wraps its own UID, and dynamic field
 * lookups must target that UID — not the parent registry's. Cached per
 * registry id since the table UID is stable for the lifetime of the deploy.
 */
const tableIdCache = new Map<string, string>();
export async function getEntriesTableId(
  sui: SuiClient,
  registryId: string,
): Promise<string> {
  const cached = tableIdCache.get(registryId);
  if (cached) return cached;
  const obj = await sui.getObject({ id: registryId, options: { showContent: true } });
  const content = obj.data?.content;
  if (!content || content.dataType !== "moveObject") {
    throw new Error(`registry ${registryId} not found or not a Move object`);
  }
  const fields = content.fields as {
    entries?: { fields?: { id?: { id?: string } } };
  };
  const tableId = fields.entries?.fields?.id?.id;
  if (typeof tableId !== "string") {
    throw new Error(`registry ${registryId} has no entries table`);
  }
  tableIdCache.set(registryId, tableId);
  return tableId;
}

export type UenLookupResult =
  | { claimed: false }
  | { claimed: true; owner: string; metadataUri: string | null };

/**
 * Read-only check whether a UEN is already claimed in the registry. Used as a
 * pre-flight before /api/sponsor/register so a duplicate doesn't burn a
 * sponsor signature on a guaranteed-to-fail transaction.
 *
 * Returning `notExists` from the RPC means unclaimed.
 */
export async function lookupUen(
  sui: SuiClient,
  registryId: string,
  uen: string,
): Promise<UenLookupResult> {
  const tableId = await getEntriesTableId(sui, registryId);
  const hash = deriveUenHash(uen);
  try {
    const field = await sui.getDynamicFieldObject({
      parentId: tableId,
      name: { type: "vector<u8>", value: Array.from(hash) },
    });
    if (!field.data) return { claimed: false };
    const content = field.data.content;
    if (!content || content.dataType !== "moveObject") return { claimed: false };
    const value = (content.fields as { value?: { fields?: Record<string, unknown> } })
      .value?.fields;
    const owner = value?.sui_address;
    if (typeof owner !== "string") return { claimed: false };
    const metadata = value?.metadata_uri;
    return {
      claimed: true,
      owner,
      metadataUri: typeof metadata === "string" ? metadata : null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("notExists") || msg.includes("does not exist")) {
      return { claimed: false };
    }
    throw e;
  }
}
