-- PayNow micro-deposit verification: schema for the onboarding rewrite.
--
-- Replaces the document-review model with proof of control over the UEN's
-- PayNow account. Quay sends S$0.01 to the UEN proxy carrying a reference
-- code; the merchant reads it off their bank statement and enters it. That
-- proves they can see deposits into the exact account the SGQR sticker pays
-- into, which is the asset actually at risk. An ACRA business profile is a
-- public record anyone can buy for S$5.50, so the document it replaces never
-- proved ownership at all (TODOS.md, and commit 5e1e744).
--
-- Three changes, in dependency order:
--   1. Document columns become nullable — onboarding stops collecting them.
--   2. New statuses for the code round-trip, added to BOTH the check
--      constraint and the race-protection index.
--   3. Verification columns for the code lifecycle + trading name.
--
-- Apply via Mysten Supabase MCP or `supabase migration up`.

-- ─── 1. Document columns become optional ──────────────────────────────
--
-- These were `not null` because every submission carried an encrypted KYB
-- document for a human to review. Nobody reviews documents any more, so
-- onboarding stops collecting them and `InsertSubmissionInput` in
-- lib/server/kyb-store.ts drops them from its required fields.
--
-- Relaxed rather than dropped: rows submitted before this migration keep
-- their ciphertext and stay decryptable by the admin key until the document
-- subsystem is deleted in a later landing. Dropping the columns now would
-- destroy the only record behind those earlier registrations.

alter table public.kyb_submissions
    alter column ciphertext_blob_id  drop not null,
    alter column ciphertext_nonce    drop not null,
    alter column wrapped_dek         drop not null,
    alter column original_mime_type  drop not null,
    alter column kyb_doc_hash        drop not null;

-- ─── 2. Statuses for the code round-trip ──────────────────────────────
--
-- State machine after this migration:
--
--   pending ──send cent──▶ awaiting_code ──correct code──▶ approved
--                              │  │                            │
--            too many wrong ───┘  └─── expires ──▶ (swept, row released)
--                    ▼                                         ▼
--               code_failed                                finalized
--
-- `approved` is retained as the terminal pre-registration state because
-- /api/kyb/finalize gates on it explicitly; a verified merchant lands there
-- exactly as an admin-approved one used to.

-- Drop the OLD status check.
--
-- The original constraint was declared inline on the column, so Postgres named
-- it automatically. That name is not a guess: it was read back from the live
-- database as `kyb_submissions_status_check` before this was written.
--
-- If it ever differs in another environment, this `if exists` silently no-ops
-- and the old narrow constraint survives beside the new one — after which
-- every `awaiting_code` insert fails while this migration reports success. So
-- verify afterwards that exactly ONE check constraint mentions `status`:
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.kyb_submissions'::regclass and contype = 'c';
--
-- (A pg_constraint discovery loop would be self-correcting, but it needs a
-- dollar-quoted DO block, and Supabase's SQL editor splits statements on
-- semicolons — which tears such a block apart. Plain DDL runs everywhere.)
alter table public.kyb_submissions
    drop constraint if exists kyb_submissions_status_check;

alter table public.kyb_submissions
    add constraint kyb_submissions_status_check
    check (status in (
        'pending',
        'awaiting_code',
        'code_failed',
        'approved',
        'rejected',
        'finalized',
        'collision'
    ));

-- The race-protection index enumerates statuses explicitly, so a new state
-- that is NOT listed here silently stops being covered. `awaiting_code` is
-- an active claim: while one merchant is reading their bank statement, no
-- one else may claim that UEN.
--
-- This is why expiry (below) is not optional. Without it, anyone who starts
-- a signup and walks away locks that UEN forever, including against the real
-- merchant, and it could be done deliberately one signup at a time.

drop index if exists kyb_submissions_one_active_per_uen;

create unique index if not exists kyb_submissions_one_active_per_uen
    on public.kyb_submissions (uen)
    where status in ('pending', 'awaiting_code', 'approved', 'finalized');

-- Same reasoning for the one-pending-per-wallet guard: a merchant sitting in
-- awaiting_code should not be able to start a second submission.
drop index if exists kyb_submissions_one_pending_per_wallet;

create unique index if not exists kyb_submissions_one_pending_per_wallet
    on public.kyb_submissions (wallet_address)
    where status in ('pending', 'awaiting_code');

-- ─── 3. Verification columns ──────────────────────────────────────────

alter table public.kyb_submissions
    -- How ownership was proven. Null until verified. Recorded in
    -- evidence_content v2 so the on-chain evidence_hash commits to which
    -- check was actually performed.
    add column if not exists verification_method text
        check (verification_method is null or verification_method in (
            'paynow_microdeposit',
            'in_person'
        )),

    -- blake2b256 of the reference code. The plaintext code is never stored:
    -- it exists in the PayNow reference and in the merchant's bank statement,
    -- and nowhere else. Compared in constant time (never `=`) so a timing
    -- side channel cannot leak it character by character.
    add column if not exists code_hash bytea,

    -- The reference string as actually sent, e.g. 'QUAY-7F3K9M'. Support
    -- needs this to answer "what should I be looking for?" without being
    -- able to reconstruct the code from the hash. Nullable: only set once
    -- the cent has actually been sent.
    add column if not exists code_reference text,

    add column if not exists code_sent_at timestamptz,

    -- Hard expiry. A sweeper releases rows past this, freeing the UEN. See
    -- the note on the uniqueness index above: without expiry an abandoned
    -- signup is a permanent denial of service on a real business.
    add column if not exists code_expires_at timestamptz,

    add column if not exists verified_at timestamptz,

    -- The name customers actually know, which for hawkers and small SMEs is
    -- routinely not the ACRA-registered entity name ("AH HOCK F&B
    -- ENTERPRISE" trading as "Ah Hock Chicken Rice"). The registered name
    -- stays in business_name and is what gets bound on chain; this is what
    -- payers see. Splitting them stops legitimate merchants abandoning at
    -- the confirmation step because the name shown is not one they use.
    add column if not exists trading_name text;

-- Sweeper lookup: expired rows still sitting in awaiting_code.
create index if not exists kyb_submissions_code_expiry_idx
    on public.kyb_submissions (code_expires_at)
    where status = 'awaiting_code';
