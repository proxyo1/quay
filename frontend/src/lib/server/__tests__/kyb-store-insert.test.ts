import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * REGRESSION (eng review E6).
 *
 * `kyb_submissions` was created with five NOT NULL document columns, and
 * `InsertSubmissionInput` required all five. The moment onboarding stopped
 * collecting a document, every insert would have failed at both the type
 * level and the database level. The migration relaxed the constraints; this
 * pins the application half.
 *
 * The repo convention is lib-only unit tests with Supabase-touching paths
 * verified manually, so rather than reaching for a database this captures the
 * row that would be written and asserts its shape. That is the part that
 * regressed, and it is the part a type change can silently break.
 */

let captured: Record<string, unknown> | null = null;

/**
 * Opt-in, because `mock.module` is global for the whole test run: replacing
 * the module unconditionally would hand this fake to every other test file
 * that touches Supabase, and dropping an export would break any file that
 * imports it. So the real surface is preserved and the fake only engages
 * while this file's tests are running.
 */
let fakeActive = false;

function fakeClient() {
  return {
    from() {
      return {
        insert(row: Record<string, unknown>) {
          captured = row;
          return {
            select() {
              return {
                single: async () => ({
                  data: { id: "row-id", submitted_at: "2026-08-20T00:00:00.000Z" },
                  error: null,
                }),
              };
            },
          };
        },
      };
    },
  };
}

const actualSupabase = await import("../supabase");

mock.module("../supabase", () => ({
  ...actualSupabase,
  getSupabaseClient: () =>
    fakeActive ? fakeClient() : actualSupabase.getSupabaseClient(),
}));

const { insertSubmission } = await import("../kyb-store");

beforeEach(() => {
  captured = null;
  fakeActive = true;
});

afterAll(() => {
  fakeActive = false;
});

describe("insertSubmission without a document", () => {
  test("succeeds and writes nulls for every document column", async () => {
    const out = await insertSubmission({
      walletAddress: "0xabc",
      uen: "200817984R",
      businessName: "GOOGLE ASIA PACIFIC PTE. LTD.",
    });

    expect(out.id).toBe("row-id");
    expect(captured).not.toBeNull();
    expect(captured!.ciphertext_blob_id).toBeNull();
    expect(captured!.ciphertext_nonce).toBeNull();
    expect(captured!.wrapped_dek).toBeNull();
    expect(captured!.original_mime_type).toBeNull();
    expect(captured!.kyb_doc_hash).toBeNull();
  });

  test("carries the registered name, the trading name and the ACRA snapshot", async () => {
    await insertSubmission({
      walletAddress: "0xabc",
      uen: "53250767C",
      businessName: "AH HOCK F&B ENTERPRISE",
      tradingName: "Ah Hock Chicken Rice",
      acraSnapshot: {
        entity_name: "AH HOCK F&B ENTERPRISE",
        entity_status: "Registered",
        entity_type: "Sole Proprietorship/ Partnership",
        checked_at_ms: 1_755_648_000_000,
        note: null,
      },
    });

    // The registered name is what gets bound on chain; the trading name is
    // what payers see. Conflating them is what made merchants abandon at the
    // confirmation step.
    expect(captured!.business_name).toBe("AH HOCK F&B ENTERPRISE");
    expect(captured!.trading_name).toBe("Ah Hock Chicken Rice");
    expect(captured!.acra_snapshot).toMatchObject({ entity_status: "Registered" });
  });

  test("starts in pending, not approved", async () => {
    // Auto-approval happens by verifying the code, never at insert time.
    await insertSubmission({ walletAddress: "0xabc", uen: "200817984R" });
    expect(captured!.status).toBe("pending");
  });
});

describe("insertSubmission with the legacy document shape", () => {
  test("still encodes the document columns as bytea literals", async () => {
    // Pre-existing rows must stay readable and the legacy call shape must
    // keep working until the document subsystem is deleted.
    await insertSubmission({
      walletAddress: "0xabc",
      uen: "200817984R",
      businessName: "ACME PTE LTD",
      ciphertextBlobId: "blob123",
      ciphertextNonceB64: Buffer.from([1, 2, 3]).toString("base64"),
      wrappedDekB64: Buffer.from([4, 5, 6]).toString("base64"),
      originalMimeType: "application/pdf",
      kybDocHashHex: "ab".repeat(32),
    });

    expect(captured!.ciphertext_blob_id).toBe("blob123");
    expect(captured!.ciphertext_nonce).toBe("\\x010203");
    expect(captured!.wrapped_dek).toBe("\\x040506");
    expect(captured!.original_mime_type).toBe("application/pdf");
    expect(captured!.kyb_doc_hash).toBe("\\x" + "ab".repeat(32));
  });
});
