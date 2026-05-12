import { describe, expect, test } from "bun:test";
import { crc16OfString, crcToHex4 } from "../crc16";
import { CRC_TEST_VECTORS } from "./fixtures";

describe("CRC-16-CCITT-FALSE", () => {
  for (const v of CRC_TEST_VECTORS) {
    test(`'${v.input}' → 0x${v.expected.toString(16).padStart(4, "0").toUpperCase()}`, () => {
      expect(crc16OfString(v.input)).toBe(v.expected);
    });
  }

  test("crcToHex4 pads and uppercases", () => {
    expect(crcToHex4(0x29b1)).toBe("29B1");
    expect(crcToHex4(0x000a)).toBe("000A");
    expect(crcToHex4(0xffff)).toBe("FFFF");
  });
});
