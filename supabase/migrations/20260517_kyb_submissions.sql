-- KYB merchant review queue
--
-- Replaces the auto-approve flow in /api/sponsor/register with a human
-- gate. Merchants submit a UEN + business name + encrypted proof-of-
-- ownership document (Bizfile or letterhead). Admin reviews via
-- /admin/kyb, decides, and the merchant returns to finalize their
-- on-chain registration.
--
-- Privacy model:
--   - Plaintext doc bytes never reach the server. Client encrypts with
--     AES-256-GCM using a random per-doc DEK; ciphertext goes to Walrus.
--   - DEK is wrapped with the admin's X25519 public key via NaCl
--     crypto_box_seal; only the admin can unwrap (private key derived
--     in-browser from their Sui wallet signature, never stored).
--   - On finalize, evidence_content (JCS-canonicalized JSON including
--     kyb_doc_hash and kyb_doc_blob_id) is hashed to evidence_hash and
--     committed on-chain via MerchantEntry.evidence_hash.
--
-- Apply via Mysten Supabase MCP or `supabase migration up`.

create table if not exists public.kyb_submissions (
    id uuid primary key default gen_random_uuid(),

    -- Sui address of the submitting merchant (zkLogin or wallet).
    -- This is the address that will sign the eventual register_merchant tx.
    wallet_address text not null,

    -- Singapore UEN being claimed. Validated to match looksLikeUen()
    -- shape server-side before insert.
    uen text not null,

    -- Optional display name shown to payers post-registration.
    business_name text,

    -- Walrus blob ID for the AES-GCM ciphertext of the KYB doc.
    ciphertext_blob_id text not null,

    -- 12-byte AES-GCM nonce used to encrypt the doc.
    ciphertext_nonce bytea not null,

    -- NaCl sealed-box wrapping of the per-doc DEK to ADMIN_KYB_PUBKEY.
    -- Only the admin's wallet-derived X25519 private key can unwrap.
    wrapped_dek bytea not null,

    -- Original MIME type of the plaintext doc (application/pdf, image/png,
    -- image/jpeg). Needed for inline rendering at review time; not sensitive.
    original_mime_type text not null,

    -- blake2b256(plaintext_doc), 32 bytes. Bound into evidence_content at
    -- finalize so the on-chain commitment also commits to the doc bytes.
    kyb_doc_hash bytea not null,

    -- State machine: pending -> approved | rejected
    --                approved -> finalized (merchant lands tx)
    --                approved -> collision (UEN claimed elsewhere mid-flight)
    status text not null default 'pending'
        check (status in ('pending','approved','rejected','finalized','collision')),

    -- Set when status='rejected'. Shown to merchant verbatim.
    rejection_reason text,

    -- 32-byte blake2b256(JCS(evidence_content)), hex-encoded, lowercase.
    -- Matches the on-chain MerchantEntry.evidence_hash and the row in
    -- issuer_audit_log. Filled at finalize.
    evidence_hash text,

    -- Walrus blob ID for the evidence_content JSON. Filled at finalize.
    evidence_blob_id text,

    submitted_at timestamptz not null default now(),
    decided_at timestamptz,
    decided_by text,  -- Admin Sui address
    finalized_at timestamptz
);

-- Admin queue ordering: newest pending first.
create index if not exists kyb_submissions_status_submitted_idx
    on public.kyb_submissions (status, submitted_at desc);

-- Wallet lookup for status polling and dup-pending check.
create index if not exists kyb_submissions_wallet_idx
    on public.kyb_submissions (wallet_address);

-- At most one pending submission per wallet. Lets merchant re-submit
-- after rejection (status='rejected' rows are excluded).
create unique index if not exists kyb_submissions_one_pending_per_wallet
    on public.kyb_submissions (wallet_address)
    where status = 'pending';

-- No two non-rejected submissions for the same UEN. Race-protects against
-- two merchants trying to claim the same UEN concurrently.
create unique index if not exists kyb_submissions_one_active_per_uen
    on public.kyb_submissions (uen)
    where status in ('pending','approved','finalized');

-- RLS: defense-in-depth — service-role-only access. The application
-- mediates all reads/writes via authenticated server routes.
alter table public.kyb_submissions enable row level security;

drop policy if exists "kyb_service_only_select" on public.kyb_submissions;
create policy "kyb_service_only_select" on public.kyb_submissions
    for select using (false);

drop policy if exists "kyb_service_only_insert" on public.kyb_submissions;
create policy "kyb_service_only_insert" on public.kyb_submissions
    for insert with check (false);

drop policy if exists "kyb_service_only_update" on public.kyb_submissions;
create policy "kyb_service_only_update" on public.kyb_submissions
    for update using (false);

drop policy if exists "kyb_service_only_delete" on public.kyb_submissions;
create policy "kyb_service_only_delete" on public.kyb_submissions
    for delete using (false);
