/**
 * Merchant profile schema — versioned JSON stored as a Walrus blob.
 *
 * The on-chain `MerchantEntry.metadata_uri` field points at a Walrus blob ID.
 * Before this scaffold landed, that blob was the raw logo bytes (PNG/JPEG).
 * With merchant settlement-token choice, the blob becomes a JSON profile
 * that holds the logo blob ID alongside the merchant's preferred receive
 * token. The on-chain `metadata_uri` stays a single `Option<String>`, so
 * no Move redeploy is required — the schema migration is frontend-only.
 *
 * Backward compatibility — three states a reader will encounter:
 *
 *   1. v1 JSON profile (new format).
 *      Returns { kind: "v1", profile }.
 *
 *   2. Raw binary blob (old format — logo bytes only).
 *      Returns { kind: "legacy", logoBlobId }. Callers treat the on-chain
 *      `metadata_uri` itself as the logo blob ID and assume the default
 *      receive token (SUI).
 *
 *   3. Malformed JSON / unknown version / unknown token — treat as legacy
 *      with a console warning. Never throw on a profile read; a bad blob
 *      should degrade to the legacy code path, not break /scan.
 *
 * Day 13 work: update /merchant/onboard to write v1 blobs, /merchant/wallet
 * to support updating the preferred token (re-upload), and the scan-side
 * lookup to call `parseMerchantProfile` and use the result. None of that
 * code is in this scaffold yet.
 */

import { COIN_TYPES } from "@/lib/quay/pay";

// ─── Schema ─────────────────────────────────────────────────────────────

export const PROFILE_SCHEMA_VERSION = 1 as const;

/** Sui Move type strings the merchant may pick as their receive token. */
export const SUPPORTED_RECEIVE_TOKENS = [
  COIN_TYPES.SUI,
  COIN_TYPES.USDC_TESTNET,
] as const;

export type SupportedReceiveToken = (typeof SUPPORTED_RECEIVE_TOKENS)[number];

/** Display labels for the merchant onboard picker. */
export const RECEIVE_TOKEN_OPTIONS: Array<{
  type: SupportedReceiveToken;
  label: string;
  description: string;
}> = [
  {
    type: COIN_TYPES.USDC_TESTNET,
    label: "USDC",
    description: "Stable revenue. Recommended.",
  },
  {
    type: COIN_TYPES.SUI,
    label: "SUI",
    description: "Native Sui. Volatile against SGD.",
  },
];

/** The default receive token when a new merchant doesn't pick one. */
export const DEFAULT_RECEIVE_TOKEN: SupportedReceiveToken = COIN_TYPES.USDC_TESTNET;

/** The fallback token for legacy merchants (pre-schema blobs). */
export const LEGACY_RECEIVE_TOKEN: SupportedReceiveToken = COIN_TYPES.SUI;

export interface MerchantProfileV1 {
  v: typeof PROFILE_SCHEMA_VERSION;
  /** Walrus blob ID of the logo. `null` if the merchant skipped logo upload. */
  logo_blob_id: string | null;
  /** Sui Move type string for the token the merchant wants to receive. */
  preferred_receive_token: SupportedReceiveToken;
  /** Merchant display name (UTF-8, ≤ 64 chars). Optional. */
  merchant_name?: string;
  /** Unix epoch ms — when this profile was last written. */
  updated_at_ms: number;
}

// ─── Parse / read ───────────────────────────────────────────────────────

export type ParseResult =
  | { kind: "v1"; profile: MerchantProfileV1 }
  | { kind: "legacy"; logoBlobId: string };

/**
 * Try to parse a Walrus blob as a v1 merchant profile.
 *
 * @param blobBytes  Raw bytes returned by `fetchBlob(blobId)`.
 * @param blobId     The on-chain `metadata_uri` value (the blob ID itself).
 *                   Used as the legacy logo fallback when parsing fails.
 */
export function parseMerchantProfile(
  blobBytes: Uint8Array,
  blobId: string,
): ParseResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(blobBytes);
  } catch {
    return { kind: "legacy", logoBlobId: blobId };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "legacy", logoBlobId: blobId };
  }

  if (!isObject(json)) return { kind: "legacy", logoBlobId: blobId };
  if (json.v !== PROFILE_SCHEMA_VERSION) {
    console.warn(
      `[merchant-profile] unknown schema version ${String(json.v)} for blob ${blobId}; falling back to legacy`,
    );
    return { kind: "legacy", logoBlobId: blobId };
  }

  const logo_blob_id = typeof json.logo_blob_id === "string" ? json.logo_blob_id : null;

  const rawToken = json.preferred_receive_token;
  if (!isSupportedReceiveToken(rawToken)) {
    console.warn(
      `[merchant-profile] unsupported preferred_receive_token "${String(rawToken)}" for blob ${blobId}; falling back to legacy`,
    );
    return { kind: "legacy", logoBlobId: blobId };
  }

  const merchant_name = typeof json.merchant_name === "string" ? json.merchant_name : undefined;

  const updated_at_ms =
    typeof json.updated_at_ms === "number" && Number.isFinite(json.updated_at_ms)
      ? json.updated_at_ms
      : 0;

  return {
    kind: "v1",
    profile: {
      v: PROFILE_SCHEMA_VERSION,
      logo_blob_id,
      preferred_receive_token: rawToken,
      merchant_name,
      updated_at_ms,
    },
  };
}

/**
 * Resolve a profile (or legacy blob) into the fields callers actually use.
 * Centralizes the "default token for legacy merchants" rule.
 */
export function resolveProfile(
  result: ParseResult,
): {
  logoBlobId: string | null;
  receiveToken: SupportedReceiveToken;
  merchantName: string | undefined;
} {
  if (result.kind === "v1") {
    return {
      logoBlobId: result.profile.logo_blob_id,
      receiveToken: result.profile.preferred_receive_token,
      merchantName: result.profile.merchant_name,
    };
  }
  return {
    logoBlobId: result.logoBlobId,
    receiveToken: LEGACY_RECEIVE_TOKEN,
    merchantName: undefined,
  };
}

// ─── Build / write ──────────────────────────────────────────────────────

export interface BuildProfileInput {
  logoBlobId: string | null;
  preferredReceiveToken: SupportedReceiveToken;
  merchantName?: string;
  /** Defaults to `Date.now()`. Override for deterministic tests. */
  nowMs?: number;
}

/** Build the bytes to upload as the v1 profile blob. */
export function buildMerchantProfileBytes(input: BuildProfileInput): Uint8Array {
  const profile: MerchantProfileV1 = {
    v: PROFILE_SCHEMA_VERSION,
    logo_blob_id: input.logoBlobId,
    preferred_receive_token: input.preferredReceiveToken,
    merchant_name: input.merchantName,
    updated_at_ms: input.nowMs ?? Date.now(),
  };
  return new TextEncoder().encode(JSON.stringify(profile));
}

// ─── Internals ──────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSupportedReceiveToken(v: unknown): v is SupportedReceiveToken {
  return typeof v === "string" && (SUPPORTED_RECEIVE_TOKENS as readonly string[]).includes(v);
}
