/**
 * AD29: Strict allowlist on Tag 59 (Merchant Name) to prevent XSS surface
 * if a downstream consumer ever renders it via dangerouslySetInnerHTML
 * (which should never happen — but defense in depth).
 *
 * EMVCo permits ASCII printable chars for Tag 59. We tighten to a safer
 * subset: letters, digits, space, and a handful of common punctuation that
 * appear in real merchant names (period, comma, hyphen, apostrophe,
 * ampersand, parens, slash). Anything else is dropped.
 *
 * Tag 59 is capped at 25 chars by the spec; we re-enforce that to defend
 * against malformed input.
 */

const ALLOWED = /[^A-Za-z0-9 .,\-'&()/]/g;
const MAX_LEN = 25;

export function sanitizeMerchantName(name: string | undefined): string {
  if (!name) return "";
  return name.replace(ALLOWED, "").slice(0, MAX_LEN).trim();
}

/** Same allowlist for merchant city (Tag 60). */
export function sanitizeMerchantCity(city: string | undefined): string {
  if (!city) return "";
  return city.replace(ALLOWED, "").slice(0, 15).trim(); // Tag 60 max 15
}
