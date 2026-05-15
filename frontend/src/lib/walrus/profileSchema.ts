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
import { SUI_NETWORK } from "@/lib/sui-config";

// ─── Schema ─────────────────────────────────────────────────────────────

export const PROFILE_SCHEMA_VERSION = 1 as const;

/**
 * Network-active receive tokens.
 *
 * Testnet keeps both SUI and the Mysten-issued testnet USDC — the original
 * dogfood path. Mainnet locks settlement to USDsui only: it's the unit
 * USDsui-on-Scallop yield-routing works against (Phase 6), and offering
 * SUI-as-receive on mainnet would just create a third axis of payer/aggregator
 * complexity without a product reason. Add new mainnet tokens here only
 * when they have a wedge — not "because we can".
 *
 * The TYPE `SupportedReceiveToken` is the UNION of both networks' values,
 * so handler code that branches on token still type-checks across builds.
 * The runtime `SUPPORTED_RECEIVE_TOKENS` is whichever set is live for the
 * current network — that's what `isSupportedReceiveToken` validates against.
 */
const TESTNET_RECEIVE_TOKENS = [COIN_TYPES.SUI, COIN_TYPES.USDC_TESTNET] as const;
const MAINNET_RECEIVE_TOKENS = [COIN_TYPES.USDSUI] as const;

export type SupportedReceiveToken =
  | (typeof TESTNET_RECEIVE_TOKENS)[number]
  | (typeof MAINNET_RECEIVE_TOKENS)[number];

export const SUPPORTED_RECEIVE_TOKENS: readonly SupportedReceiveToken[] =
  SUI_NETWORK === "mainnet" ? MAINNET_RECEIVE_TOKENS : TESTNET_RECEIVE_TOKENS;

/** Display labels for the merchant onboard picker. Network-specific. */
export const RECEIVE_TOKEN_OPTIONS: Array<{
  type: SupportedReceiveToken;
  label: string;
  description: string;
}> =
  SUI_NETWORK === "mainnet"
    ? [
        {
          type: COIN_TYPES.USDSUI,
          label: "USDsui",
          description: "Bridge/Stripe Sui-native stablecoin. Yield-eligible.",
        },
      ]
    : [
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
export const DEFAULT_RECEIVE_TOKEN: SupportedReceiveToken =
  SUI_NETWORK === "mainnet" ? COIN_TYPES.USDSUI : COIN_TYPES.USDC_TESTNET;

/**
 * Fallback token when a legacy/unparseable profile is encountered.
 *
 * On testnet, legacy = raw-logo-blob merchants registered before the v1
 * JSON profile shipped — they were defaulted to SUI. On mainnet there is
 * no legacy population (mainnet ships with the v1 schema from day 1), so
 * we fall back to the network default (USDsui) — keeps the contract
 * simple: profile read failure → still produces a valid receive token.
 */
export const LEGACY_RECEIVE_TOKEN: SupportedReceiveToken =
  SUI_NETWORK === "mainnet" ? COIN_TYPES.USDSUI : COIN_TYPES.SUI;

/**
 * Yield-routing opt-in (Phase 6). When `enabled`, incoming `preferred_receive_token`
 * payments auto-deposit into the named protocol's lending pool in the same
 * PTB the payer signs — the merchant receives an interest-bearing receipt
 * coin (e.g. `Coin<SCALLOP_USDSUI>`) instead of the bare token.
 *
 * Currently only `scallop`/`usdsui` is supported; the struct is shaped for
 * multi-protocol/multi-asset expansion without a schema bump.
 *
 * Back-compat: absent field is treated as `enabled: false`. Existing
 * merchants are unaffected until they tick the wallet checkbox.
 */
export interface YieldRouting {
  enabled: boolean;
  protocol: "scallop";
  asset: "usdsui";
}

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
  /**
   * Yield-routing opt-in. Absent = disabled (back-compat for pre-Phase-6
   * profiles). See `YieldRouting` for the shape.
   */
  yield_routing?: YieldRouting;
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

  const yield_routing = parseYieldRouting(json.yield_routing);

  return {
    kind: "v1",
    profile: {
      v: PROFILE_SCHEMA_VERSION,
      logo_blob_id,
      preferred_receive_token: rawToken,
      merchant_name,
      updated_at_ms,
      ...(yield_routing ? { yield_routing } : {}),
    },
  };
}

/**
 * Resolve a profile (or legacy blob) into the fields callers actually use.
 * Centralizes the "default token for legacy merchants" rule and the
 * "yield_routing absent = disabled" rule.
 */
export function resolveProfile(
  result: ParseResult,
): {
  logoBlobId: string | null;
  receiveToken: SupportedReceiveToken;
  merchantName: string | undefined;
  yieldRouting: YieldRouting | null;
} {
  if (result.kind === "v1") {
    return {
      logoBlobId: result.profile.logo_blob_id,
      receiveToken: result.profile.preferred_receive_token,
      merchantName: result.profile.merchant_name,
      yieldRouting: result.profile.yield_routing ?? null,
    };
  }
  return {
    logoBlobId: result.logoBlobId,
    receiveToken: LEGACY_RECEIVE_TOKEN,
    merchantName: undefined,
    yieldRouting: null,
  };
}

// ─── Build / write ──────────────────────────────────────────────────────

export interface BuildProfileInput {
  logoBlobId: string | null;
  preferredReceiveToken: SupportedReceiveToken;
  merchantName?: string;
  /** Defaults to `Date.now()`. Override for deterministic tests. */
  nowMs?: number;
  /**
   * Optional yield-routing opt-in. Omit (or pass `null`) to write a
   * pre-Phase-6 profile shape — the field is absent in JSON, which old
   * readers interpret as disabled.
   */
  yieldRouting?: YieldRouting | null;
}

/** Build the bytes to upload as the v1 profile blob. */
export function buildMerchantProfileBytes(input: BuildProfileInput): Uint8Array {
  const profile: MerchantProfileV1 = {
    v: PROFILE_SCHEMA_VERSION,
    logo_blob_id: input.logoBlobId,
    preferred_receive_token: input.preferredReceiveToken,
    merchant_name: input.merchantName,
    updated_at_ms: input.nowMs ?? Date.now(),
    ...(input.yieldRouting ? { yield_routing: input.yieldRouting } : {}),
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

/**
 * Validate the `yield_routing` sub-object. Bad shape → returns null (the
 * profile reader degrades gracefully, treating it as "absent / disabled").
 * This is deliberately strict on protocol/asset enum values so a future
 * "yield_routing: { protocol: 'naviv2', ... }" doesn't get silently mis-parsed.
 */
function parseYieldRouting(v: unknown): YieldRouting | null {
  if (!isObject(v)) return null;
  if (typeof v.enabled !== "boolean") return null;
  if (v.protocol !== "scallop") return null;
  if (v.asset !== "usdsui") return null;
  return { enabled: v.enabled, protocol: "scallop", asset: "usdsui" };
}
