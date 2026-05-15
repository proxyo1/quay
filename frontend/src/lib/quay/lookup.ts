import { blake2b } from "@noble/hashes/blake2.js";
import type { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";

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

    const metadataBlobId =
      typeof value?.metadata_uri === "string" ? (value.metadata_uri as string) : null;

    // uen_raw comes back as either number[] (BCS-decoded) or string.
    const uenRawRaw = value?.uen_raw;
    let uenRaw: string | null = null;
    if (Array.isArray(uenRawRaw)) {
      uenRaw = new TextDecoder().decode(new Uint8Array(uenRawRaw as number[]));
    } else if (typeof uenRawRaw === "string") {
      uenRaw = uenRawRaw;
    }

    const evidenceHashRaw = value?.evidence_hash;
    let evidenceHashHex = "";
    if (Array.isArray(evidenceHashRaw)) {
      evidenceHashHex = toHex(Uint8Array.from(evidenceHashRaw as number[]));
    } else if (typeof evidenceHashRaw === "string") {
      evidenceHashHex = evidenceHashRaw;
    }

    return {
      claimed: true,
      owner,
      uenRaw,
      metadataBlobId,
      evidenceHashHex,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("notExists") || msg.includes("does not exist")) {
      return { claimed: false };
    }
    throw e;
  }
}

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
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
