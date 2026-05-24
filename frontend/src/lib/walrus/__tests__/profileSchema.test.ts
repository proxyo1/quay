import { describe, test, expect } from "bun:test";

import { COIN_TYPES } from "@/lib/quay/pay";
import { SUI_NETWORK } from "@/lib/sui-config";
import {
  buildMerchantProfileBytes,
  DEFAULT_RECEIVE_TOKEN,
  LEGACY_RECEIVE_TOKEN,
  parseMerchantProfile,
  resolveProfile,
  SUPPORTED_RECEIVE_TOKENS,
  PROFILE_SCHEMA_VERSION,
} from "../profileSchema";

const FAKE_BLOB_ID = "fakeblobid123";

// Network-aware sample tokens. The supported set differs by build
// (testnet = [SUI, USDC_TESTNET]; mainnet = [USDsui]), so the round-trip
// tests must use a token that's actually supported on the current network —
// otherwise parseMerchantProfile rejects it as "unsupported" and degrades
// to legacy, which is correct behavior but not what these cases exercise.
const PRIMARY_TOKEN = SUPPORTED_RECEIVE_TOKENS[0];
const SECONDARY_TOKEN =
  SUPPORTED_RECEIVE_TOKENS[SUPPORTED_RECEIVE_TOKENS.length - 1];

// A token that is never in any network's supported set.
const UNSUPPORTED_TOKEN = "0xbad::scam::SCAM";

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

describe("parseMerchantProfile", () => {
  test("parses a well-formed v1 profile (network default token)", () => {
    const bytes = buildMerchantProfileBytes({
      logoBlobId: "logo123",
      preferredReceiveToken: PRIMARY_TOKEN,
      merchantName: "Curry Times",
      nowMs: 1_730_000_000_000,
    });
    const result = parseMerchantProfile(bytes, FAKE_BLOB_ID);
    expect(result.kind).toBe("v1");
    if (result.kind !== "v1") throw new Error("unreachable");
    expect(result.profile.v).toBe(PROFILE_SCHEMA_VERSION);
    expect(result.profile.preferred_receive_token).toBe(PRIMARY_TOKEN);
    expect(result.profile.logo_blob_id).toBe("logo123");
    expect(result.profile.merchant_name).toBe("Curry Times");
    expect(result.profile.updated_at_ms).toBe(1_730_000_000_000);
  });

  test("parses a v1 profile with another supported token", () => {
    const bytes = buildMerchantProfileBytes({
      logoBlobId: null,
      preferredReceiveToken: SECONDARY_TOKEN,
    });
    const result = parseMerchantProfile(bytes, FAKE_BLOB_ID);
    expect(result.kind).toBe("v1");
    if (result.kind !== "v1") throw new Error("unreachable");
    expect(result.profile.preferred_receive_token).toBe(SECONDARY_TOKEN);
    expect(result.profile.logo_blob_id).toBeNull();
  });

  test("falls back to legacy on non-JSON binary blob (logo bytes)", () => {
    // First bytes of a real PNG (0x89 'P' 'N' 'G') — not valid UTF-8 JSON.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = parseMerchantProfile(png, FAKE_BLOB_ID);
    expect(result.kind).toBe("legacy");
    if (result.kind !== "legacy") throw new Error("unreachable");
    expect(result.logoBlobId).toBe(FAKE_BLOB_ID);
  });

  test("falls back to legacy on JSON that isn't a v1 profile", () => {
    const result = parseMerchantProfile(encode({ hello: "world" }), FAKE_BLOB_ID);
    expect(result.kind).toBe("legacy");
  });

  test("falls back to legacy when version is unknown", () => {
    const result = parseMerchantProfile(
      encode({
        v: 99,
        logo_blob_id: null,
        preferred_receive_token: PRIMARY_TOKEN,
        updated_at_ms: 0,
      }),
      FAKE_BLOB_ID,
    );
    expect(result.kind).toBe("legacy");
  });

  test("falls back to legacy when preferred_receive_token is unsupported", () => {
    const result = parseMerchantProfile(
      encode({
        v: 1,
        logo_blob_id: null,
        preferred_receive_token: UNSUPPORTED_TOKEN,
        updated_at_ms: 0,
      }),
      FAKE_BLOB_ID,
    );
    expect(result.kind).toBe("legacy");
  });

  test("falls back to legacy on malformed JSON", () => {
    const bytes = new TextEncoder().encode("{not valid json");
    const result = parseMerchantProfile(bytes, FAKE_BLOB_ID);
    expect(result.kind).toBe("legacy");
  });
});

describe("resolveProfile", () => {
  test("v1 → returns its receive token", () => {
    const bytes = buildMerchantProfileBytes({
      logoBlobId: "L",
      preferredReceiveToken: PRIMARY_TOKEN,
    });
    const resolved = resolveProfile(parseMerchantProfile(bytes, FAKE_BLOB_ID));
    expect(resolved.receiveToken).toBe(PRIMARY_TOKEN);
    expect(resolved.logoBlobId).toBe("L");
  });

  test("legacy → defaults to the network's legacy token", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const resolved = resolveProfile(parseMerchantProfile(png, FAKE_BLOB_ID));
    expect(resolved.receiveToken).toBe(LEGACY_RECEIVE_TOKEN);
    expect(resolved.logoBlobId).toBe(FAKE_BLOB_ID);
    expect(resolved.merchantName).toBeUndefined();
  });
});

describe("constants sanity", () => {
  // Settlement-token product decision (memory: mainnet default is USDsui,
  // not USDC). Asserted per-network so this holds across both builds.
  test("DEFAULT_RECEIVE_TOKEN matches the active network", () => {
    const expected =
      SUI_NETWORK === "mainnet" ? COIN_TYPES.USDSUI : COIN_TYPES.USDC_TESTNET;
    expect(DEFAULT_RECEIVE_TOKEN).toBe(expected);
    expect(SUPPORTED_RECEIVE_TOKENS).toContain(DEFAULT_RECEIVE_TOKEN);
  });

  test("LEGACY_RECEIVE_TOKEN matches the active network", () => {
    const expected =
      SUI_NETWORK === "mainnet" ? COIN_TYPES.USDSUI : COIN_TYPES.SUI;
    expect(LEGACY_RECEIVE_TOKEN).toBe(expected);
  });
});

describe("buildMerchantProfileBytes round-trip", () => {
  test("missing merchant_name is omitted from JSON, not stringified as undefined", () => {
    const bytes = buildMerchantProfileBytes({
      logoBlobId: null,
      preferredReceiveToken: PRIMARY_TOKEN,
      nowMs: 1,
    });
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain('"merchant_name":undefined');
  });

  test("uses the provided nowMs (deterministic for tests)", () => {
    const bytes = buildMerchantProfileBytes({
      logoBlobId: null,
      preferredReceiveToken: PRIMARY_TOKEN,
      nowMs: 42,
    });
    const parsed = parseMerchantProfile(bytes, FAKE_BLOB_ID);
    if (parsed.kind !== "v1") throw new Error("expected v1");
    expect(parsed.profile.updated_at_ms).toBe(42);
  });
});
