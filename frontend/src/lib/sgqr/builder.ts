import { crc16OfString, crcToHex4 } from "./crc16";

/**
 * SGQR builder — generates valid EMVCo MPM payloads with correct CRC-16.
 *
 * Primary purpose: produce test fixtures so the parser can be round-trip
 * verified. NOT intended as a production builder (we don't issue SGQR codes
 * — merchants do that via their bank / NETS).
 */

export interface BuildOptions {
  pointOfInitiation?: "11" | "12"; // 11=static, 12=dynamic
  payNow?: {
    proxyType: "0" | "2" | "5"; // 0=mobile, 2=UEN, 5=VPA
    proxyValue: string;
    editable?: boolean;
    expiryDate?: string; // YYYYMMDD
  };
  /** Inject a custom MAI under a specific tag (overrides PayNow if same tag). */
  customMai?: Array<{ tag: string; fields: Record<string, string> }>;
  merchantCategoryCode?: string; // 4 digits, default "0000"
  transactionCurrency?: string; // "702" for SGD
  transactionAmount?: string;
  countryCode?: string; // "SG"
  merchantName: string;
  merchantCity: string;
  postalCode?: string;
  additionalData?: { billNumber?: string; referenceLabel?: string };
}

function tlv(tag: string, value: string): string {
  if (tag.length !== 2 || !/^\d{2}$/.test(tag)) {
    throw new Error(`Invalid tag '${tag}'`);
  }
  const len = value.length;
  if (len > 99) throw new Error(`Tag ${tag} value too long (${len} chars)`);
  return tag + len.toString().padStart(2, "0") + value;
}

function buildMaiPayNow(opt: NonNullable<BuildOptions["payNow"]>): string {
  let inner = tlv("00", "SG.PAYNOW");
  inner += tlv("01", opt.proxyType);
  inner += tlv("02", opt.proxyValue);
  inner += tlv("03", opt.editable ? "1" : "0");
  if (opt.expiryDate) inner += tlv("04", opt.expiryDate);
  return inner;
}

function buildMaiCustom(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([tag, value]) => tlv(tag, value))
    .join("");
}

/** Build a complete SGQR string with a valid trailing CRC-16. */
export function buildSgqr(opt: BuildOptions): string {
  let body = "";
  body += tlv("00", "01"); // Payload format indicator
  body += tlv("01", opt.pointOfInitiation ?? "11");

  // MAIs
  let usedPayNowTag = false;
  if (opt.customMai) {
    for (const c of opt.customMai) {
      body += tlv(c.tag, buildMaiCustom(c.fields));
      if (c.tag === "26") usedPayNowTag = true;
    }
  }
  if (opt.payNow && !usedPayNowTag) {
    body += tlv("26", buildMaiPayNow(opt.payNow));
  }

  body += tlv("52", opt.merchantCategoryCode ?? "0000");
  body += tlv("53", opt.transactionCurrency ?? "702");
  if (opt.transactionAmount) body += tlv("54", opt.transactionAmount);
  body += tlv("58", opt.countryCode ?? "SG");
  body += tlv("59", opt.merchantName);
  body += tlv("60", opt.merchantCity);
  if (opt.postalCode) body += tlv("61", opt.postalCode);
  if (opt.additionalData) {
    let inner = "";
    if (opt.additionalData.billNumber) inner += tlv("01", opt.additionalData.billNumber);
    if (opt.additionalData.referenceLabel) inner += tlv("05", opt.additionalData.referenceLabel);
    body += tlv("62", inner);
  }

  // CRC field — the literal "6304" is included in the CRC computation
  const withCrcPrefix = body + "6304";
  const crc = crcToHex4(crc16OfString(withCrcPrefix));
  return withCrcPrefix + crc;
}

/** Build with a deliberately-bad CRC (last 4 chars set to "DEAD"). */
export function buildSgqrWithBadCrc(opt: BuildOptions): string {
  const good = buildSgqr(opt);
  return good.slice(0, -4) + "DEAD";
}
