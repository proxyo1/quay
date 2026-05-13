import { describe, test, expect } from "bun:test";

import {
  encodeQuoteMetadata,
  QUOTE_METADATA_MAX_BYTES,
  QuoteMetadataTooLargeError,
} from "../pay";

describe("encodeQuoteMetadata", () => {
  test("produces an SQR1 magic header followed by JSON body", () => {
    const out = encodeQuoteMetadata({ hello: "world" });
    const text = new TextDecoder().decode(out);
    expect(text.startsWith("SQR1")).toBe(true);
    expect(text.slice(4)).toBe(JSON.stringify({ hello: "world" }));
  });

  test("typical Pyth + DEX envelope fits under the cap", () => {
    const envelope = {
      v: 1,
      src: "pyth-hermes",
      sgd_minor: 350,
      usd_sgd_id: "0xeb98b8cd9c0db987e93eb98b8cd9c0db987",
      usd_sgd_price: "74000",
      usd_sgd_expo: -5,
      usd_sgd_publish_time: 1_730_000_000,
      sui_usd_id: "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69",
      sui_usd_price: "523000",
      sui_usd_expo: -6,
      sui_usd_publish_time: 1_730_000_000,
      out_token: "0x2::sui::SUI",
      out_amount: "5340000000",
      dex: {
        venue: "cetus-aggregator",
        payer_token: "0xa1ec::usdc::USDC",
        slippage_bps: 100,
      },
    };
    const out = encodeQuoteMetadata(envelope);
    expect(out.length).toBeLessThan(QUOTE_METADATA_MAX_BYTES);
  });

  test("rejects payloads that would exceed the 2 KB cap (eng safety net)", () => {
    // Build a payload comfortably over the cap.
    const padding = "x".repeat(QUOTE_METADATA_MAX_BYTES + 100);
    expect(() => encodeQuoteMetadata({ padding })).toThrow(QuoteMetadataTooLargeError);
  });

  test("the thrown error carries the actual byte count for diagnostics", () => {
    const padding = "y".repeat(QUOTE_METADATA_MAX_BYTES);
    try {
      encodeQuoteMetadata({ padding });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(QuoteMetadataTooLargeError);
      if (e instanceof QuoteMetadataTooLargeError) {
        expect(e.actualBytes).toBeGreaterThan(QUOTE_METADATA_MAX_BYTES);
      }
    }
  });
});
