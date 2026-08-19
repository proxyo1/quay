/**
 * Shapes for ACRA open-data lookups.
 *
 * The two datasets use DIFFERENT column names for the same concepts
 * (`issuance_agency_desc` vs `issuance_agency_id`, `entity_type_desc` vs
 * `entity_type_description`), so they get separate decoders. Sharing one
 * would silently produce undefined fields rather than throwing.
 */

/** Collection 1 row: enough to confirm a UEN exists and name it. */
export interface AcraUenRecord {
  uen: string;
  entityName: string;
  /** "ACRA", "Registry of Societies", ... */
  issuanceAgency: string;
  /** "Registered" | "Deregistered" | ... */
  status: string;
  /** "Local Company" | "Sole Proprietorship/ Partnership" | ... */
  entityType: string;
  uenIssueDate: string | null;
  /** Street and postal only. NOT enough for a payout address. */
  streetName: string | null;
  postalCode: string | null;
}

/** Collection 2 row: the full address a PayNow payout requires. */
export interface AcraEntityDetail {
  uen: string;
  entityName: string;
  entityStatus: string | null;
  entityType: string | null;
  companyType: string | null;
  registrationDate: string | null;
  primarySsicCode: string | null;
  primarySsicDescription: string | null;
  address: AcraAddress;
}

export interface AcraAddress {
  block: string | null;
  streetName: string | null;
  buildingName: string | null;
  levelNo: string | null;
  unitNo: string | null;
  postalCode: string | null;
  country: string;
}

/**
 * Lookup outcome. Deliberately NOT an exception type: ACRA is a convenience
 * and a payout-address source, never a gate. Onboarding proceeds on every
 * branch of this union, so the caller cannot accidentally turn an upstream
 * blip into a rejected merchant.
 */
export type AcraLookup<T> =
  | { status: "found"; record: T }
  /** Queried successfully, no such row. Often a company registered since the
   *  last monthly refresh. Allow and flag, never reject. */
  | { status: "not_found" }
  /** data.gov.sg was unreachable, slow, rate-limiting, or changed shape. */
  | { status: "unavailable"; reason: string };

/** How a claimed name compares to the registered one. */
export type NameMatch = "exact" | "normalized" | "mismatch" | "unknown";
