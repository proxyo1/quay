import { crc16OfString, crcToHex4 } from "./crc16";
import type {
  AdditionalData,
  MerchantAccountInfo,
  PayNowInfo,
  PointOfInitiation,
  ProxyType,
  SgqrPayload,
} from "./types";
import { SgqrParseError } from "./types";

const TWO_DIGIT = /^\d{2}$/;

/** Tokenize a TLV string into `[tag, length, value]` triples. */
function tokenize(input: string, startOffset = 0): Array<{ tag: string; length: number; value: string; offset: number }> {
  const out: Array<{ tag: string; length: number; value: string; offset: number }> = [];
  let i = 0;
  while (i < input.length) {
    if (input.length - i < 4) {
      throw new SgqrParseError({
        kind: "MALFORMED_TLV",
        offset: startOffset + i,
        reason: `expected tag+length (4 chars), found ${input.length - i}`,
      });
    }
    const tag = input.slice(i, i + 2);
    const lenStr = input.slice(i + 2, i + 4);
    if (!TWO_DIGIT.test(tag)) {
      throw new SgqrParseError({
        kind: "MALFORMED_TLV",
        offset: startOffset + i,
        reason: `non-digit tag '${tag}'`,
      });
    }
    if (!TWO_DIGIT.test(lenStr)) {
      throw new SgqrParseError({
        kind: "MALFORMED_TLV",
        offset: startOffset + i + 2,
        reason: `non-digit length '${lenStr}' for tag '${tag}'`,
      });
    }
    const length = parseInt(lenStr, 10);
    const valueStart = i + 4;
    const valueEnd = valueStart + length;
    if (valueEnd > input.length) {
      throw new SgqrParseError({
        kind: "DECLARED_LENGTH_OVERFLOW",
        tag,
        declaredLength: length,
        remaining: input.length - valueStart,
      });
    }
    const value = input.slice(valueStart, valueEnd);
    out.push({ tag, length, value, offset: startOffset + i });
    i = valueEnd;
  }
  return out;
}

function decodePointOfInitiation(value: string): PointOfInitiation {
  if (value === "11") return "static";
  if (value === "12") return "dynamic";
  return "unknown";
}

function decodeProxyType(value: string): ProxyType {
  if (value === "0") return "mobile";
  if (value === "2") return "uen";
  if (value === "5") return "vpa";
  return "unknown";
}

function parseMerchantAccountInfo(tag: string, raw: string): MerchantAccountInfo {
  const fields: Record<string, string> = {};
  let guid = "";
  try {
    const subs = tokenize(raw);
    for (const s of subs) {
      fields[s.tag] = s.value;
      if (s.tag === "00") guid = s.value;
    }
  } catch (e) {
    // A non-TLV MAI value (rare but valid for some legacy schemes) — surface
    // the raw value but no parsed fields.
    if (!(e instanceof SgqrParseError)) throw e;
  }
  return { tag, raw, guid, fields };
}

function parseAdditionalData(raw: string): AdditionalData {
  const data: AdditionalData = { raw: {} };
  try {
    for (const s of tokenize(raw)) {
      data.raw[s.tag] = s.value;
      // EMVCo Tag 62 sub-tag assignments
      if (s.tag === "01") data.billNumber = s.value;
      else if (s.tag === "02") data.referenceLabel = s.value;
      else if (s.tag === "05") data.referenceLabel = s.value;
      else if (s.tag === "06") data.customerLabel = s.value;
      else if (s.tag === "07") data.terminalLabel = s.value;
      else if (s.tag === "08") data.purposeOfTransaction = s.value;
    }
  } catch (e) {
    if (!(e instanceof SgqrParseError)) throw e;
  }
  return data;
}

/**
 * Parse an SGQR / EMVCo MPM payload string. Throws SgqrParseError on
 * structural problems; sets `crcValid=false` on CRC mismatches (does not throw)
 * so callers can decide whether to surface the mismatch as an error or accept
 * a malformed code with a warning.
 */
export function parseSgqr(input: string): SgqrPayload {
  if (input == null || input.length === 0) {
    throw new SgqrParseError({ kind: "EMPTY_INPUT" });
  }

  // The CRC field is always the LAST 8 chars: "63" + "04" + 4 hex chars.
  if (input.length < 8) {
    throw new SgqrParseError({
      kind: "INVALID_CRC_FORMAT",
      reason: `input too short (${input.length} chars) to contain CRC`,
    });
  }
  const crcPrefix = input.slice(-8, -4);
  const crcValueDeclared = input.slice(-4);
  if (crcPrefix !== "6304") {
    throw new SgqrParseError({
      kind: "INVALID_CRC_FORMAT",
      reason: `expected trailing '6304XXXX' CRC field, found '${crcPrefix}${crcValueDeclared}'`,
    });
  }
  if (!/^[0-9A-Fa-f]{4}$/.test(crcValueDeclared)) {
    throw new SgqrParseError({
      kind: "INVALID_CRC_FORMAT",
      reason: `CRC value '${crcValueDeclared}' is not 4 hex chars`,
    });
  }

  const covered = input.slice(0, -4); // includes the literal "6304"
  const crcExpected = crcToHex4(crc16OfString(covered));
  const crcValid = crcExpected.toUpperCase() === crcValueDeclared.toUpperCase();

  // Tokenize the body (everything before "6304XXXX") at the top level.
  const body = input.slice(0, -8);
  const top = tokenize(body);

  const payload: SgqrPayload = {
    payloadFormatIndicator: "",
    pointOfInitiationMethod: "unknown",
    merchantAccountInfo: [],
    crc: crcValueDeclared.toUpperCase(),
    crcValid,
    raw: input,
  };

  for (const t of top) {
    const tagNum = parseInt(t.tag, 10);
    if (t.tag === "00") {
      payload.payloadFormatIndicator = t.value;
    } else if (t.tag === "01") {
      payload.pointOfInitiationMethod = decodePointOfInitiation(t.value);
    } else if (tagNum >= 2 && tagNum <= 51) {
      payload.merchantAccountInfo.push(parseMerchantAccountInfo(t.tag, t.value));
    } else if (t.tag === "52") {
      payload.merchantCategoryCode = t.value;
    } else if (t.tag === "53") {
      payload.transactionCurrency = t.value;
    } else if (t.tag === "54") {
      payload.transactionAmount = t.value;
    } else if (t.tag === "58") {
      payload.countryCode = t.value;
    } else if (t.tag === "59") {
      payload.merchantName = t.value;
    } else if (t.tag === "60") {
      payload.merchantCity = t.value;
    } else if (t.tag === "61") {
      payload.postalCode = t.value;
    } else if (t.tag === "62") {
      payload.additionalData = parseAdditionalData(t.value);
    }
  }

  if (!payload.payloadFormatIndicator) {
    throw new SgqrParseError({ kind: "MISSING_MANDATORY_TAG", tag: "00" });
  }
  return payload;
}

/**
 * Extract the PayNow MAI from a parsed payload. Returns null if no
 * SG.PAYNOW MAI is present.
 *
 * Looks across all MAI tags 02..51 for one whose sub-tag 00 (GUID) equals
 * "SG.PAYNOW". If multiple are present, returns the first.
 */
export function extractPayNow(payload: SgqrPayload): PayNowInfo | null {
  for (const mai of payload.merchantAccountInfo) {
    if (mai.guid.toUpperCase() !== "SG.PAYNOW") continue;
    const proxyType = decodeProxyType(mai.fields["01"] ?? "");
    const proxyValue = mai.fields["02"] ?? "";
    const editable = (mai.fields["03"] ?? "0") === "1";
    const expiryDate = mai.fields["04"];
    return {
      tag: mai.tag,
      proxyType,
      proxyValue,
      editable,
      expiryDate,
    };
  }
  return null;
}

/**
 * Convenience: parse + extract PayNow in one call. Throws on structural
 * errors; returns `{ payload, payNow }` where `payNow` may be null.
 */
export function parsePayNowQr(input: string): { payload: SgqrPayload; payNow: PayNowInfo | null } {
  const payload = parseSgqr(input);
  return { payload, payNow: extractPayNow(payload) };
}

/** Singapore UEN basic shape: 8–10 alphanumeric chars (varies by entity type). */
export function looksLikeUen(s: string): boolean {
  return /^[A-Za-z0-9]{8,10}$/.test(s);
}
