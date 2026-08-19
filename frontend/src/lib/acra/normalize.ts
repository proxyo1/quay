/**
 * Entity-name normalization.
 *
 * This is the load-bearing function of the ACRA integration: every
 * name-match decision routes through it, so it lives on its own with
 * table-driven tests rather than inline in a route.
 *
 * ACRA stores names uppercase with inconsistent punctuation. The same
 * business appears as "AH HOCK F&B PTE. LTD.", "AH HOCK F&B PTE LTD" and
 * "Ah Hock F and B Private Limited" depending on who typed it. None of
 * those differences are meaningful, and treating them as mismatches would
 * fail real merchants.
 *
 * What this deliberately does NOT do is fuzzy matching. Levenshtein-style
 * closeness would let "AH HOCK" match "AH HOK", and since the name is one
 * of the inputs bound on chain, a near-miss must read as a mismatch and be
 * flagged rather than quietly accepted.
 */

import type { NameMatch } from "./types";

/**
 * Legal-form suffixes that carry no identifying information. Order matters:
 * longer forms are stripped first so "PRIVATE LIMITED" does not leave a
 * dangling "PRIVATE" behind after "LIMITED" is removed.
 */
const SUFFIXES = [
  "PRIVATE LIMITED",
  "PTE LTD",
  "PTE LIMITED",
  "PUBLIC LIMITED",
  "LIMITED LIABILITY PARTNERSHIP",
  "LIMITED PARTNERSHIP",
  "LLP",
  "LTD",
  "LP",
  "PL",
];

/**
 * Canonical form for comparison. Not for display: never show the output of
 * this to a merchant, it is deliberately lossy.
 */
export function normalizeEntityName(raw: string): string {
  let s = raw.normalize("NFKD").toUpperCase();

  // "&" and "AND" are interchangeable in practice ("F&B" vs "F AND B").
  s = s.replace(/&/g, " AND ");

  // Punctuation carries no meaning here: "PTE. LTD." === "PTE LTD".
  // Keep alphanumerics and spaces only.
  s = s.replace(/[^A-Z0-9]+/g, " ");

  s = s.replace(/\s+/g, " ").trim();

  // A leading article is not part of the identity, and ACRA is inconsistent
  // about it. Note this is for COMPARISON only — the letter dataset still
  // files "THE COFFEE BEAN" under T (see detailDatasetFor).
  s = s.replace(/^THE /, "");

  // Strip one trailing legal form. Only one: "X PTE LTD LTD" is not a thing,
  // and looping would eat meaningful words from names like "LTD LTD SUPPLIES".
  for (const suffix of SUFFIXES) {
    if (s.endsWith(` ${suffix}`)) {
      s = s.slice(0, -(suffix.length + 1)).trim();
      break;
    }
  }

  return s;
}

/**
 * How a merchant-supplied name relates to the ACRA-registered one.
 *
 * "normalized" is a pass: it means the names differ only in punctuation,
 * case, articles or legal form. "mismatch" means they are different names
 * and a human should look.
 */
export function compareEntityNames(
  claimed: string | null | undefined,
  registered: string | null | undefined,
): NameMatch {
  if (!claimed?.trim() || !registered?.trim()) return "unknown";
  if (claimed.trim() === registered.trim()) return "exact";

  const a = normalizeEntityName(claimed);
  const b = normalizeEntityName(registered);
  if (!a || !b) return "unknown";

  return a === b ? "normalized" : "mismatch";
}
