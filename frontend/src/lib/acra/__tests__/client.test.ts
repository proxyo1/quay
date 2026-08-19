import { afterEach, describe, expect, test } from "bun:test";

import { formatAddressLine, lookupAcraUen, lookupEntityDetail } from "../client";
import { detailDatasetFor } from "../datasets";

/**
 * No network. data.gov.sg has no SLA and a monthly refresh, so a test that
 * called it would be both slow and flaky, and would tell us nothing about our
 * decoding that a fixture cannot.
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.toString() : String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const UEN_ROW = {
  uen: "200817984R",
  entity_name: "GOOGLE ASIA PACIFIC PTE. LTD.",
  issuance_agency_desc: "ACRA",
  uen_status_desc: "Registered",
  entity_type_desc: "Local Company",
  uen_issue_date: "2008-09-11",
  reg_street_name: "BEACH ROAD",
  reg_postal_code: "189767",
};

const DETAIL_ROW = {
  uen: "200817984R",
  entity_name: "GOOGLE ASIA PACIFIC PTE. LTD.",
  entity_status_description: "Live Company",
  entity_type_description: "Local Company",
  company_type_description: "Private Company Limited by Shares",
  registration_incorporation_date: "2008-09-11",
  primary_ssic_code: "63901",
  primary_ssic_description: "PROVISION OF FINANCIAL ADMINISTRATION",
  block: "38",
  street_name: "BEACH ROAD",
  building_name: "SOUTH BEACH TOWER",
  level_no: "23",
  unit_no: "11",
  postal_code: "189767",
};

describe("lookupAcraUen", () => {
  test("decodes a found row", async () => {
    stubFetch(() => json({ result: { records: [UEN_ROW] } }));
    const out = await lookupAcraUen("200817984R");
    expect(out.status).toBe("found");
    if (out.status !== "found") return;
    expect(out.record.entityName).toBe("GOOGLE ASIA PACIFIC PTE. LTD.");
    expect(out.record.status).toBe("Registered");
    expect(out.record.postalCode).toBe("189767");
  });

  test("queries by exact filter, never full-text", async () => {
    // `q=` is ranked full-text and returns fuzzy matches for short tokens,
    // which for a UEN would be actively wrong.
    const calls = stubFetch(() => json({ result: { records: [UEN_ROW] } }));
    await lookupAcraUen("200817984R");
    expect(calls[0]).toContain("filters=");
    expect(calls[0]).toContain("200817984R");
    expect(calls[0]).not.toContain("&q=");
  });

  test("uppercases the UEN before querying", async () => {
    const calls = stubFetch(() => json({ result: { records: [UEN_ROW] } }));
    await lookupAcraUen("200817984r");
    expect(calls[0]).toContain("200817984R");
  });

  test("falls through to the other-agencies register before giving up", async () => {
    const calls = stubFetch((url) =>
      url.includes("d_b1d2b840ab9e993570c037b706b39bb8")
        ? json({ result: { records: [{ ...UEN_ROW, issuance_agency_desc: "Registry of Societies" }] } })
        : json({ result: { records: [] } }),
    );
    const out = await lookupAcraUen("T09SS0255G");
    expect(calls).toHaveLength(2);
    expect(out.status).toBe("found");
    if (out.status !== "found") return;
    expect(out.record.issuanceAgency).toBe("Registry of Societies");
  });

  test("absent from both registers is not_found, not an error", async () => {
    // The register refreshes monthly, so a company incorporated three weeks
    // ago is legitimately missing. This must never read as a rejection.
    stubFetch(() => json({ result: { records: [] } }));
    expect((await lookupAcraUen("999999999Z")).status).toBe("not_found");
  });

  test("an upstream 5xx is unavailable, distinct from not_found", async () => {
    stubFetch(() => json({ error: "boom" }, 503));
    const out = await lookupAcraUen("200817984R");
    expect(out.status).toBe("unavailable");
    if (out.status !== "unavailable") return;
    expect(out.reason).toContain("503");
  });

  test("a network failure is unavailable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    const out = await lookupAcraUen("200817984R");
    expect(out.status).toBe("unavailable");
  });

  test("a timeout is reported as a timeout", async () => {
    globalThis.fetch = (async () => {
      throw new Error("The operation timed out.");
    }) as typeof fetch;
    const out = await lookupAcraUen("200817984R", { timeoutMs: 5 });
    expect(out.status).toBe("unavailable");
    if (out.status !== "unavailable") return;
    expect(out.reason).toContain("timeout");
  });

  test("a non-JSON body is unavailable, not a crash", async () => {
    stubFetch(() => new Response("<html>maintenance</html>", { status: 200 }));
    expect((await lookupAcraUen("200817984R")).status).toBe("unavailable");
  });

  test("schema drift is unavailable, not a silently empty record", async () => {
    // If data.gov.sg renames the envelope, we must notice rather than report
    // every UEN as unregistered.
    stubFetch(() => json({ result: { rows: [UEN_ROW] } }));
    expect((await lookupAcraUen("200817984R")).status).toBe("unavailable");
  });

  test("a row missing entity_name is unavailable, not half-decoded", async () => {
    stubFetch(() => json({ result: { records: [{ uen: "200817984R" }] } }));
    expect((await lookupAcraUen("200817984R")).status).toBe("unavailable");
  });

  test('ACRA\'s "na" placeholder decodes to null, not the string "na"', async () => {
    stubFetch(() =>
      json({ result: { records: [{ ...UEN_ROW, reg_street_name: "na" }] } }),
    );
    const out = await lookupAcraUen("200817984R");
    if (out.status !== "found") throw new Error("expected found");
    expect(out.record.streetName).toBeNull();
  });
});

describe("lookupEntityDetail", () => {
  test("decodes the full address the payout needs", async () => {
    stubFetch(() => json({ result: { records: [DETAIL_ROW] } }));
    const out = await lookupEntityDetail("200817984R", "GOOGLE ASIA PACIFIC PTE. LTD.");
    if (out.status !== "found") throw new Error("expected found");
    expect(out.record.address.block).toBe("38");
    expect(out.record.address.postalCode).toBe("189767");
    expect(out.record.entityStatus).toBe("Live Company");
  });

  test("uses the dataset for the first letter of the entity name", async () => {
    const calls = stubFetch(() => json({ result: { records: [DETAIL_ROW] } }));
    await lookupEntityDetail("200817984R", "GOOGLE ASIA PACIFIC PTE. LTD.");
    expect(calls[0]).toContain(detailDatasetFor("GOOGLE ASIA PACIFIC PTE. LTD."));
  });

  test("does not share the UEN-register decoder", async () => {
    // The two datasets use different column names for the same concepts
    // (entity_type_desc vs entity_type_description). A shared decoder would
    // yield undefined here rather than throwing.
    stubFetch(() => json({ result: { records: [DETAIL_ROW] } }));
    const out = await lookupEntityDetail("200817984R", "GOOGLE");
    if (out.status !== "found") throw new Error("expected found");
    expect(out.record.entityType).toBe("Local Company");
  });
});

describe("detailDatasetFor", () => {
  test("files by the raw first character, without normalization", () => {
    // "THE COFFEE BEAN" lives under T, not C: ACRA files by the registered
    // name as written, so the comparison normalizer must not be applied here.
    expect(detailDatasetFor("THE COFFEE BEAN")).toBe(detailDatasetFor("TAN & TAN"));
    expect(detailDatasetFor("THE COFFEE BEAN")).not.toBe(detailDatasetFor("COFFEE BEAN"));
  });

  test("names starting with a digit or symbol fall to OTHERS", () => {
    expect(detailDatasetFor("3M SINGAPORE")).toBe(detailDatasetFor("@HOME PTE LTD"));
  });
});

describe("formatAddressLine", () => {
  test("builds the single line a PayNow payout wants", async () => {
    stubFetch(() => json({ result: { records: [DETAIL_ROW] } }));
    const out = await lookupEntityDetail("200817984R", "GOOGLE");
    if (out.status !== "found") throw new Error("expected found");
    expect(formatAddressLine(out.record)).toBe("38 BEACH ROAD #23-11");
  });

  test("returns null without a street, rather than a misleading fragment", async () => {
    stubFetch(() =>
      json({ result: { records: [{ ...DETAIL_ROW, street_name: null }] } }),
    );
    const out = await lookupEntityDetail("200817984R", "GOOGLE");
    if (out.status !== "found") throw new Error("expected found");
    expect(formatAddressLine(out.record)).toBeNull();
  });
});
