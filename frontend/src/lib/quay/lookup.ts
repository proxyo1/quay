import { blake2b } from "@noble/hashes/blake2.js";

import type { SuiClient } from "@/lib/sui-client";
import {
  isNotFoundError,
  MerchantEntryBcs,
  MerchantRegistryBcs,
  vectorU8FieldName,
} from "@/lib/quay/move-bcs";
import { fetchBlob, WalrusFetchError } from "@/lib/walrus/client";
import {
  LEGACY_RECEIVE_TOKEN,
  parseMerchantProfile,
  resolveProfile,
  type SupportedReceiveToken,
  type YieldRouting,
} from "@/lib/walrus/profileSchema";

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
  const obj = await sui.getObject({ objectId: registryId, include: { content: true } });
  const content = obj.object?.content;
  if (!content) {
    throw new Error(`registry ${registryId} not found or has no content`);
  }
  const registry = MerchantRegistryBcs.parse(content);
  const tableId = registry.entries.id;
  if (typeof tableId !== "string") {
    throw new Error(`registry ${registryId} has no entries table`);
  }
  tableIdCache.set(registryId, tableId);
  return tableId;
}

export type UenLookupResult =
  | { claimed: false }
  | {
      claimed: true;
      owner: string;
      /** Raw UEN bytes recovered from the on-chain `uen_raw` field (D1). */
      uenRaw: string | null;
      /**
       * Walrus blob ID for the merchant's profile (D5). Caller constructs
       * the aggregator URL via `getBlobUrl()`. `null` if not set.
       */
      metadataBlobId: string | null;
      /**
       * 32-byte blake2b256 of the issuer-verified evidence (D8). Empty
       * vector when the merchant was registered via `register_for_testing`
       * (test-only).
       */
      evidenceHashHex: string;
    };

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
    const field = await sui.getDynamicField({
      parentId: tableId,
      name: vectorU8FieldName(hash),
    });
    const valueBytes = field.dynamicField?.value?.bcs;
    if (!valueBytes) return { claimed: false };

    // BCS gives typed fields directly, so none of the old
    // "number[] or string?" defensiveness is needed.
    const entry = MerchantEntryBcs.parse(valueBytes);
    const owner = entry.sui_address;
    if (typeof owner !== "string") return { claimed: false };

    return {
      claimed: true,
      owner,
      uenRaw: new TextDecoder().decode(Uint8Array.from(entry.uen_raw)),
      metadataBlobId: entry.metadata_uri ?? null,
      evidenceHashHex: toHex(Uint8Array.from(entry.evidence_hash)),
    };
  } catch (e) {
    // An absent dynamic field means the UEN is unclaimed. gRPC reports that as
    // an object-not-found throw rather than an empty result.
    if (isNotFoundError(e)) return { claimed: false };
    throw e;
  }
}

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** One registered UEN owned by an address, as the terminal and wallet show it. */
export interface OwnedMerchantEntry {
  uen: string;
  metadataBlobId: string | null;
  /** Digest of the registration tx, when the event carried one. */
  digest: string | null;
  /** Registration time in epoch millis. */
  timestamp: number;
}

/**
 * Every UEN registered to `owner`, newest first.
 *
 * Shared by `/app/merchant/terminal` and `/app/merchant/wallet`, which
 * previously carried near-identical copies of this — including two separate
 * hand-rolled decoders for `uen_raw`.
 *
 * This enumerates the registry table rather than replaying
 * `MerchantRegistered` events, and that distinction is load-bearing: Sui's
 * GraphQL endpoint retains only a recent window of event history. Mainnet
 * registrations from May 2026 return **zero** event rows today, so the
 * event-based version silently told long-standing merchants they had no UENs.
 * The table is current state and cannot age out.
 *
 * Cost is one paginated scan of the table. That is fine at the registry's
 * present size and is the same read the terminal already did per merchant; if
 * the registry ever grows past a few thousand entries this wants an index
 * (an owner → uen_hash table on chain, or a server-side cache) rather than a
 * bigger `maxEntries`.
 */
export async function listOwnedMerchantEntries(
  sui: SuiClient,
  registryId: string,
  packageId: string,
  owner: string,
  maxEntries = 1000,
): Promise<OwnedMerchantEntry[]> {
  void packageId; // retained for call-site symmetry; no longer needed
  const tableId = await getEntriesTableId(sui, registryId);

  const rows: OwnedMerchantEntry[] = [];
  // Annotated because `cursor` is reassigned from `page.cursor` below, which
  // would otherwise make `page` circularly inferred.
  let cursor: string | null = null;
  let scanned = 0;

  while (scanned < maxEntries) {
    const page: Awaited<ReturnType<typeof sui.listDynamicFields<{ value: true }>>> =
      await sui.listDynamicFields({
        parentId: tableId,
        limit: Math.min(50, maxEntries - scanned),
        cursor,
        include: { value: true },
      });
    for (const field of page.dynamicFields) {
      scanned += 1;
      const raw = field.value?.bcs;
      if (!raw) continue;
      let entry;
      try {
        entry = MerchantEntryBcs.parse(raw);
      } catch {
        continue; // not a MerchantEntry — skip rather than fail the whole list
      }
      if (entry.sui_address !== owner) continue;
      const uen = new TextDecoder().decode(Uint8Array.from(entry.uen_raw));
      if (!uen) continue;
      rows.push({
        uen,
        metadataBlobId: entry.metadata_uri ?? null,
        // The registration digest lived on the event, which no longer
        // survives; callers must tolerate a null digest.
        digest: null,
        timestamp: Number(entry.claimed_at_ms),
      });
    }
    if (!page.hasNextPage || !page.cursor) break;
    cursor = page.cursor;
  }

  return rows.sort((a, b) => b.timestamp - a.timestamp);
}

/** Shape of the `MerchantRegistered` event payload. */
export interface MerchantRegisteredEvent {
  uen_hash: unknown;
  sui_address: string;
  timestamp_ms?: string;
}

// ─── Merchant profile fetch ─────────────────────────────────────────────

/**
 * The resolved merchant profile that PayPanel / scan flow needs after a
 * successful `lookupUen`. This is a thin layer on top of the Walrus profile
 * schema that hides "v1 JSON vs legacy logo blob" from callers.
 */
export interface ResolvedMerchantProfile {
  /** Walrus blob ID for the logo. May be the same blob ID as the profile
   *  itself in legacy mode (since legacy blobs ARE the logo bytes). */
  logoBlobId: string | null;
  /** Token the merchant wants to receive. Falls back to SUI for legacy. */
  receiveToken: SupportedReceiveToken;
  /** Optional display name from v1 profile; undefined for legacy. */
  merchantName: string | undefined;
  /** True if the on-chain metadata pointed at a v1 JSON profile. */
  isV1: boolean;
  /**
   * Yield-routing opt-in (Phase 6). `null` for legacy profiles or v1
   * profiles that pre-date the field. Callers treat `null` as disabled.
   */
  yieldRouting: YieldRouting | null;
}

/**
 * Resolve a merchant's profile from their on-chain `metadata_uri` blob ID.
 *
 * Graceful degradation: if the Walrus aggregator is unreachable or the blob
 * is missing, we return a `null`-logo profile with the default receive
 * token (SUI). /scan must still work even when Walrus is flaky — the
 * payment path itself doesn't depend on the logo.
 *
 * Returns `null` only if `metadataBlobId` itself is `null` (merchant
 * registered without a profile).
 */
export async function fetchMerchantProfile(
  metadataBlobId: string | null,
): Promise<ResolvedMerchantProfile | null> {
  if (!metadataBlobId) return null;

  let blobBytes: Uint8Array;
  try {
    blobBytes = await fetchBlob(metadataBlobId);
  } catch (err) {
    if (err instanceof WalrusFetchError) {
      console.warn(
        `[merchant-profile] Walrus fetch failed for ${metadataBlobId}: ${err.message}; defaulting to legacy`,
      );
      return {
        logoBlobId: metadataBlobId,
        receiveToken: LEGACY_RECEIVE_TOKEN,
        merchantName: undefined,
        isV1: false,
        yieldRouting: null,
      };
    }
    throw err;
  }

  const parsed = parseMerchantProfile(blobBytes, metadataBlobId);
  const resolved = resolveProfile(parsed);
  return {
    logoBlobId: resolved.logoBlobId,
    receiveToken: resolved.receiveToken,
    merchantName: resolved.merchantName,
    isV1: parsed.kind === "v1",
    yieldRouting: resolved.yieldRouting,
  };
}
