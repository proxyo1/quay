-- Phase 4 (D8): Issuer audit log
--
-- One row per merchant attestation. The on-chain MerchantEntry holds the
-- canonical reference (evidence_hash). This table maps that hash to the
-- Walrus blob_id so the operator (and Phase 6 /m/[uen] page) can resolve
-- evidence content from the on-chain commitment.
--
-- Apply via Mysten Supabase MCP or `supabase migration up`.

create table if not exists public.issuer_audit_log (
    -- 32-byte blake2b256(evidence_content), hex-encoded (64 chars, lowercase).
    -- This is the canonical reference that also lives on-chain in
    -- MerchantEntry.evidence_hash.
    evidence_hash text primary key,

    -- Walrus blob ID for the evidence content. Frontend constructs the
    -- aggregator URL via `${WALRUS_AGGREGATOR_URL}/v1/${walrus_blob_id}`.
    walrus_blob_id text not null,

    -- blake2b256("PAYNOW_UEN_V1" || uen) — same key the Move registry uses.
    -- Hex-encoded. Lets us look up evidence for a UEN without exposing the
    -- raw UEN in the audit table.
    uen_hash text not null,

    -- Unix-ms timestamp when the issuer signed the attestation.
    signed_at_ms bigint not null,

    -- Sui address that received the attestation (the claimer/merchant).
    -- Useful for forensic queries; not load-bearing for verification.
    claimer text not null,

    -- Server insertion time for ordering / drift detection.
    created_at timestamptz not null default now()
);

-- Quick lookup by UEN hash for Phase 6 merchant page.
create index if not exists issuer_audit_log_uen_hash_idx
    on public.issuer_audit_log (uen_hash);

-- Quick lookup by claimer for operator forensics.
create index if not exists issuer_audit_log_claimer_idx
    on public.issuer_audit_log (claimer);

-- Append-only posture: deny updates and deletes at the row level. This is
-- defense-in-depth — the application code never deletes, but the policy
-- enforces that even a compromised service key can't tamper with history.
alter table public.issuer_audit_log enable row level security;

drop policy if exists "audit_log_no_updates" on public.issuer_audit_log;
create policy "audit_log_no_updates" on public.issuer_audit_log
    for update using (false);

drop policy if exists "audit_log_no_deletes" on public.issuer_audit_log;
create policy "audit_log_no_deletes" on public.issuer_audit_log
    for delete using (false);

-- Service role inserts; no public read without explicit grant. The Phase 6
-- merchant page reads via a server-side route (operator-controlled), not
-- direct browser access.
drop policy if exists "audit_log_service_insert" on public.issuer_audit_log;
create policy "audit_log_service_insert" on public.issuer_audit_log
    for insert with check (true);
