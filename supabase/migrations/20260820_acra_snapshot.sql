-- ACRA snapshot captured at claim time, for evidence_content v2.
--
-- The on-chain `evidence_hash` commits to the facts an approval rested on.
-- With document review gone, those facts are: the UEN, the claimer, the
-- verification method, and what the government register said at the time.
--
-- Why store it rather than re-fetch at finalize:
--
--   1. The register refreshes monthly. A re-fetch could hash a DIFFERENT fact
--      than the one the claim was actually accepted under, which would make
--      the commitment describe something that never happened.
--   2. Finalize must be deterministic. Re-fetching makes the evidence hash
--      depend on when the merchant happened to land their transaction, and on
--      whether data.gov.sg was up at that moment.
--
-- Shape (all keys always present, null when unknown — JCS treats an absent
-- key and a null value as different bytes, so the convention has to be fixed):
--
--   {
--     "entity_name":    "GOOGLE ASIA PACIFIC PTE. LTD." | null,
--     "entity_status":  "Registered" | null,
--     "entity_type":    "Local Company" | null,
--     "checked_at_ms":  1755648000000,
--     "note":           "ACRA unavailable: timeout after 2500ms" | null
--   }
--
-- `note` records WHY a lookup produced nothing, so an auditor replaying an
-- attestation can tell "the register said this business is deregistered"
-- apart from "we could not reach the register".

alter table public.kyb_submissions
    add column if not exists acra_snapshot jsonb;

comment on column public.kyb_submissions.acra_snapshot is
    'ACRA register state at claim time. Hashed into evidence_content v2; never re-fetched at finalize.';
