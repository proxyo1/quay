import { describe, test, expect } from "bun:test";

import { COIN_TYPES } from "@/lib/quay/pay";
import {
  buildMerchantProfileBytes,
  DEFAULT_RECEIVE_TOKEN,
  LEGACY_RECEIVE_TOKEN,
  parseMerchantProfile,
  resolveProfile,
  PROFILE_SCHEMA_VERSION,
} from "../profileSchema";

const FAKE_BLOB_ID = "fakeblobid123";

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

describe("parseMerchantProfile", () => {
  test("parses a well-formed v1 profile (USDC default)", () => {
    const bytes = buildMerchantProfileBytes({
      logoBlobId: "logo123",
      preferredReceiveToken: COIN_TYPES.USDC_TESTNET,
      merchantName: "Curry Times",
      nowMs: 1_730_000_000_000,
    });
    const result = parseMerchantProfile(bytes, FAKE_BLOB_ID);
    expect(result.kind).toBe("v1");
    if (result.kind !== "v1") throw new Error("unreachable");
    expect(result.profile.v).toBe(PROFILE_SCHEMA_VERSION);
    expect(result.profile.preferred_receive_token).toBe(COIN_TYPES.USDC_TESTNET);
    expect(result.profile.logo_blob_id).toBe("logo123");
    expect(result.profile.merchant_name).toBe("Curry Times");
    expect(result.profile.updated_at_ms).toBe(1_730_000_000_000);
  });

  test("parses a v1 profile with SUI as the receive token", () => {
    const bytes = buildMerchantProfileBytes({
      logoBlobId: null,
      preferredReceiveToken: COIN_TYPES.SUI,
    });
    const result = parseMerchantProfile(bytes, FAKE_BLOB_ID);
    expect(result.kind).toBe("v1");
    if (result.kind !== "v1") throw new Error("unreachable");
    expect(result.profile.preferred_receive_token).toBe(COIN_TYPES.SUI);
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
        preferred_receive_token: COIN_TYPES.SUI,
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
        preferred_receive_token: "0xbad::scam::SCAM",
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
      preferredReceiveToken: COIN_TYPES.USDC_TESTNET,
    });
    const resolved = resolveProfile(parseMerchantProfile(bytes, FAKE_BLOB_ID));
    expect(resolved.receiveToken).toBe(COIN_TYPES.USDC_TESTNET);
    expect(resolved.logoBlobId).toBe("L");
  });

  test("legacy → defaults to SUI", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const resolved = resolveProfile(parseMerchantProfile(png, FAKE_BLOB_ID));
    expect(resolved.receiveToken).toBe(LEGACY_RECEIVE_TOKEN);
    expect(resolved.receiveToken).toBe(COIN_TYPES.SUI);
    expect(resolved.logoBlobId).toBe(FAKE_BLOB_ID);
    expect(resolved.merchantName).toBeUndefined();
  });
});

describe("constants sanity", () => {
  test("DEFAULT_RECEIVE_TOKEN is USDC (V0 product decision)", () => {
    expect(DEFAULT_RECEIVE_TOKEN).toBe(COIN_TYPES.USDC_TESTNET);
  });

  test("LEGACY_RECEIVE_TOKEN is SUI (backward compat)", () => {
    expect(LEGACY_RECEIVE_TOKEN).toBe(COIN_TYPES.SUI);
  });
});

describe("buildMerchantProfileBytes round-trip", () => {
  test("missing merchant_name is omitted from JSON, not stringified as undefined", () => {
    const bytes = buildMerchantProfileBytes({
      logoBlobId: null,
      preferredReceiveToken: COIN_TYPES.SUI,
      nowMs: 1,
    });
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain('"merchant_name":undefined');
  });

  test("uses the provided nowMs (deterministic for tests)", () => {
    const bytes = buildMerchantProfileBytes({
      logoBlobId: null,
      preferredReceiveToken: COIN_TYPES.SUI,
      nowMs: 42,
    });
    const parsed = parseMerchantProfile(bytes, FAKE_BLOB_ID);
    if (parsed.kind !== "v1") throw new Error("expected v1");
    expect(parsed.profile.updated_at_ms).toBe(42);
  });
});
