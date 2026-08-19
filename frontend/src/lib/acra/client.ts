/**
 * ACRA open-data client (data.gov.sg CKAN datastore).
 *
 * No API key, no SLA, no documented rate limit, monthly refresh. Treat every
 * response as untrusted external data and every failure as non-fatal: a
 * merchant onboards on the strength of the PayNow micro-deposit, never on
 * whether this lookup succeeded.
 *
 *   lookupAcraUen()      one exact-filter call. Name, status, type, postal.
 *   lookupEntityDetail() second call for the FULL address a payout needs.
 *
 * Named `lookupAcraUen` rather than `lookupUen` because `lib/quay` already
 * exports `lookupUen` for the on-chain registry, and routes import both.
 *
 * Always query with `filters={"uen":...}` (exact). Never `q=`, which is
 * ranked full-text and returns fuzzy matches for short tokens.
 */

import {
  DATAGOV_BASE,
  UEN_DATASET_ACRA,
  UEN_DATASET_OTHER,
  detailDatasetFor,
} from "./datasets";
import type {
  AcraEntityDetail,
  AcraLookup,
  AcraUenRecord,
} from "./types";

/** data.gov.sg has no SLA. Budget it hard and move on. */
const DEFAULT_TIMEOUT_MS = 2_500;

/** Raw CKAN envelope. Fields are `unknown` until decoded. */
interface DatastoreResponse {
  success?: boolean;
  result?: { records?: Record<string, unknown>[] };
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  // ACRA writes "na" (and occasionally "NA") for absent values rather than
  // leaving the column empty. Treat it as absent or it ends up rendered to
  // merchants as a street called "na".
  if (!t || t.toLowerCase() === "na") return null;
  return t;
}

async function queryDatastore(
  resourceId: string,
  uen: string,
  timeoutMs: number,
): Promise<AcraLookup<Record<string, unknown>>> {
  const url = new URL(DATAGOV_BASE);
  url.searchParams.set("resource_id", resourceId);
  url.searchParams.set("filters", JSON.stringify({ uen }));
  url.searchParams.set("limit", "1");

  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      status: "unavailable",
      reason: reason.includes("timed out") || reason.includes("abort")
        ? `timeout after ${timeoutMs}ms`
        : reason,
    };
  }

  if (!res.ok) {
    return { status: "unavailable", reason: `HTTP ${res.status}` };
  }

  let body: DatastoreResponse;
  try {
    body = (await res.json()) as DatastoreResponse;
  } catch {
    return { status: "unavailable", reason: "response was not JSON" };
  }

  const records = body.result?.records;
  if (!Array.isArray(records)) {
    // Shape drift. Loud, because it means our decoders are now wrong.
    return { status: "unavailable", reason: "unexpected response shape" };
  }
  if (records.length === 0) return { status: "not_found" };

  return { status: "found", record: records[0] };
}

// ───────────────────────── Collection 1: UEN register ─────────────────────

function decodeUenRecord(row: Record<string, unknown>): AcraUenRecord | null {
  const uen = str(row.uen);
  const entityName = str(row.entity_name);
  if (!uen || !entityName) return null;
  return {
    uen,
    entityName,
    issuanceAgency: str(row.issuance_agency_desc) ?? "unknown",
    status: str(row.uen_status_desc) ?? "unknown",
    entityType: str(row.entity_type_desc) ?? "unknown",
    uenIssueDate: str(row.uen_issue_date),
    streetName: str(row.reg_street_name),
    postalCode: str(row.reg_postal_code),
  };
}

/**
 * Confirm a UEN exists and learn its registered name.
 *
 * Checks the ACRA-issued register first, then the other-agencies register.
 * A hit in the second means the UEN is real but belongs to a society or
 * similar rather than an ACRA business; the caller decides what to do with
 * that (it is not, by itself, a reason to reject).
 */
export async function lookupAcraUen(
  uen: string,
  opts: { timeoutMs?: number } = {},
): Promise<AcraLookup<AcraUenRecord>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const normalized = uen.trim().toUpperCase();

  for (const dataset of [UEN_DATASET_ACRA, UEN_DATASET_OTHER]) {
    const raw = await queryDatastore(dataset, normalized, timeoutMs);
    if (raw.status === "unavailable") return raw;
    if (raw.status === "not_found") continue;

    const decoded = decodeUenRecord(raw.record);
    if (!decoded) {
      return { status: "unavailable", reason: "row missing uen or entity_name" };
    }
    return { status: "found", record: decoded };
  }

  return { status: "not_found" };
}

// ────────────────────── Collection 2: corporate detail ────────────────────

function decodeDetail(row: Record<string, unknown>): AcraEntityDetail | null {
  const uen = str(row.uen);
  const entityName = str(row.entity_name);
  if (!uen || !entityName) return null;
  return {
    uen,
    entityName,
    // NOTE the different column names from collection 1. Do not merge the
    // two decoders: these would silently read as undefined.
    entityStatus: str(row.entity_status_description),
    entityType: str(row.entity_type_description),
    companyType: str(row.company_type_description),
    registrationDate: str(row.registration_incorporation_date),
    primarySsicCode: str(row.primary_ssic_code),
    primarySsicDescription: str(row.primary_ssic_description),
    address: {
      block: str(row.block),
      streetName: str(row.street_name),
      buildingName: str(row.building_name),
      levelNo: str(row.level_no),
      unitNo: str(row.unit_no),
      postalCode: str(row.postal_code),
      country: "SG",
    },
  };
}

/**
 * The full address, for the PayNow payout. Requires the entity name because
 * collection 2 is filed by first letter and cannot be searched by UEN.
 *
 * A miss here is genuinely ambiguous: it may mean the entity is not in that
 * letter's file because the name differs between the two datasets. Callers
 * must not report it to a merchant as "not registered" — collection 1 already
 * answered that question.
 */
export async function lookupEntityDetail(
  uen: string,
  entityName: string,
  opts: { timeoutMs?: number } = {},
): Promise<AcraLookup<AcraEntityDetail>> {
  const raw = await queryDatastore(
    detailDatasetFor(entityName),
    uen.trim().toUpperCase(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (raw.status !== "found") return raw;

  const decoded = decodeDetail(raw.record);
  if (!decoded) {
    return { status: "unavailable", reason: "row missing uen or entity_name" };
  }
  return { status: "found", record: decoded };
}

/**
 * Flatten an ACRA address into the single line Wise's `singapore_paynow`
 * recipient wants for `address.firstLine`. See docs/wise-paynow-probe.md.
 */
export function formatAddressLine(detail: AcraEntityDetail): string | null {
  const { block, streetName, levelNo, unitNo } = detail.address;
  if (!streetName) return null;
  const unit = levelNo && unitNo ? `#${levelNo}-${unitNo}` : null;
  return [block, streetName, unit].filter(Boolean).join(" ");
}
