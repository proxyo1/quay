/**
 * EMVCo MPM QR (SGQR) typed representation.
 *
 * Reference: EMVCo Merchant Presented Mode QR Code Specification + SGQR
 * spec (which composes EMVCo MPM with SG-specific tags 26..45 for
 * Singapore payment schemes: PayNow, NETS, GrabPay, etc.).
 *
 * EMVCo tag layout (top level):
 *   00      Payload Format Indicator (always "01")
 *   01      Point of Initiation Method ("11"=static, "12"=dynamic)
 *   02..51  Merchant Account Information (multiple; each is a nested TLV)
 *   52      Merchant Category Code (4-digit MCC)
 *   53      Transaction Currency (ISO-4217 numeric, "702"=SGD)
 *   54      Transaction Amount (optional)
 *   55      Tip / Convenience Indicator
 *   56-57   Convenience Fees (fixed / percentage)
 *   58      Country Code ("SG")
 *   59      Merchant Name (max 25 chars)
 *   60      Merchant City
 *   61      Postal Code
 *   62      Additional Data (nested TLV)
 *   63      CRC-16-CCITT-FALSE over all preceding bytes including "6304"
 *
 * Inside an SG.PAYNOW MAI:
 *   00      GUID = "SG.PAYNOW"
 *   01      Proxy Type ("0"=mobile, "2"=UEN, "5"=VPA)
 *   02      Proxy Value (UEN string, mobile number, etc.)
 *   03      Editable ("0"=fixed, "1"=editable)
 *   04      Expiry Date (YYYYMMDD)
 */

export type PointOfInitiation = "static" | "dynamic" | "unknown";

export type ProxyType =
  | "mobile" // "0"
  | "uen" // "2"
  | "vpa" // "5"
  | "unknown";

export interface MerchantAccountInfo {
  /** Top-level tag string, "02".."51". */
  tag: string;
  /** Raw value (sub-TLVs concatenated). */
  raw: string;
  /** GUID at sub-tag 00 (e.g., "SG.PAYNOW", "SG.SGQR", "SG.COM.NETS"). */
  guid: string;
  /** Parsed sub-fields keyed by 2-digit sub-tag. */
  fields: Record<string, string>;
}

export interface PayNowInfo {
  /** Source MAI tag (e.g., "26"). */
  tag: string;
  /** Proxy type (mobile / uen / vpa / unknown). */
  proxyType: ProxyType;
  /** Raw proxy value (UEN string, mobile number, etc.). */
  proxyValue: string;
  /** Editable flag. */
  editable: boolean;
  /** Expiry date (YYYYMMDD), if present. */
  expiryDate?: string;
}

/** Payment rail surfaced by `extractMerchant`. */
export type MerchantRail = "paynow" | "nets";

/**
 * Unified merchant identity extracted from an SGQR, regardless of which
 * payment rail the printed sticker uses. The on-chain Quay registry only
 * cares about the UEN — the rail is informational (for analytics + UX
 * messaging, e.g. "scanned a NETS sticker").
 *
 * Resolution order in `extractMerchant`:
 *   1. SG.PAYNOW (preferred — structured `proxy_type` + `proxy_value`)
 *   2. SG.COM.NETS (UEN embedded inside sub-tag 01; regex'd out)
 *
 * Multi-rail stickers (most chain stores) include both; the first match
 * wins. NETS-only stickers (smaller SMEs, e.g. DOT DESIGN) still work.
 */
export interface MerchantQrInfo {
  /** Source MAI tag (e.g., "26"). */
  tag: string;
  /** Which Singapore rail the GUID matched. */
  rail: MerchantRail;
  /** Proxy type. Always `"uen"` for NETS extraction (we only mine UENs). */
  proxyType: ProxyType;
  /** Raw proxy value — the UEN. */
  proxyValue: string;
  /** PayNow only: editable flag. NETS QRs don't carry this. */
  editable?: boolean;
  /** PayNow only: expiry date (YYYYMMDD). NETS QRs don't carry this. */
  expiryDate?: string;
}

export interface AdditionalData {
  /** Bill number / reference. */
  billNumber?: string;
  /** Reference label. */
  referenceLabel?: string;
  /** Customer label. */
  customerLabel?: string;
  /** Terminal label. */
  terminalLabel?: string;
  /** Purpose of transaction. */
  purposeOfTransaction?: string;
  /** Raw sub-tags. */
  raw: Record<string, string>;
}

export interface SgqrPayload {
  payloadFormatIndicator: string;
  pointOfInitiationMethod: PointOfInitiation;
  merchantAccountInfo: MerchantAccountInfo[];
  merchantCategoryCode?: string;
  transactionCurrency?: string;
  transactionAmount?: string;
  countryCode?: string;
  merchantName?: string;
  merchantCity?: string;
  postalCode?: string;
  additionalData?: AdditionalData;
  /** Last 4 hex chars of the input. */
  crc: string;
  /** Whether the CRC computed over preceding bytes matches the trailing CRC. */
  crcValid: boolean;
  /** Raw input string. */
  raw: string;
}

export type ParseError =
  | { kind: "EMPTY_INPUT" }
  | { kind: "MALFORMED_TLV"; offset: number; reason: string }
  | { kind: "DECLARED_LENGTH_OVERFLOW"; tag: string; declaredLength: number; remaining: number }
  | { kind: "INVALID_CRC_FORMAT"; reason: string }
  | { kind: "MISSING_MANDATORY_TAG"; tag: string };

export class SgqrParseError extends Error {
  detail: ParseError;
  constructor(detail: ParseError) {
    super(`SGQR parse error: ${detail.kind}`);
    this.detail = detail;
    this.name = "SgqrParseError";
  }
}
