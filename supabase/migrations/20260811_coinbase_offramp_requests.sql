-- Coinbase CDP Offramp cash-out requests.
--
-- Deliberately a separate table from `cashout_requests` rather than a reuse:
-- that table's columns are Wise-named (wise_quote_id, wise_transfer_id,
-- recipient bank details) and its status enum describes a payout Quay
-- executes, not a widget order the merchant completes on Coinbase. Keeping
-- them apart also means `scripts/cashout-redrive.ts` — which re-drives the
-- *Wise* leg — can never pick up a Coinbase row.
--
-- State machine (transitions enforced in code by a pure nextStatus function,
-- see lib/server/coinbase-offramp-store.ts):
--
--   created ──▶ committed ──▶ sent ──▶ settled
--      │            │           │
--      │            │           └──▶ refunded  (Coinbase cancelled post-send)
--      │            └───────────────▶ expired  (deadline passed, nothing sent)
--      └────────────────────────────▶ failed

create table if not exists public.coinbase_offramp_requests (
    id uuid primary key default gen_random_uuid(),

    -- Merchant's Sui address (tx sender and coin owner).
    owner text not null,
    uen text,

    -- Coinbase's handle for this *merchant*, not this order: stable, opaque,
    -- and under 50 chars (a Sui address is 66, so it cannot be used directly).
    partner_user_ref text not null,

    -- Amounts. bigints are stored as text and parsed in the app, matching
    -- cashout_requests, so no value is ever routed through a float.
    amount_usdsui_minor text not null,
    sell_amount_usdc_minor text,
    cashout_total_sgd_minor text,
    coinbase_fee_sgd_minor text,

    -- Coinbase order identifiers and the deposit address it issues once the
    -- merchant commits. `to_address` does not exist before that point.
    coinbase_quote_id text,
    coinbase_transaction_id text,
    to_address text,

    -- Canonical idempotency key: one row per on-chain send. The unique index
    -- is what makes a replayed digest a 409 rather than a double payout.
    sui_digest text unique,

    -- Redeem leg, when the merchant had funds in Scallop.
    redeemed_share_minor text,
    leftover_share_minor text,
    partial_redeem boolean not null default false,
    performance_fee_underlying_minor text,
    share_price_at_quote double precision,
    redeem_digest text,

    -- Coinbase's own deadline, as reported by the API. NOT a computed +30m:
    -- a guessed clock can disagree with the order that is actually expiring.
    deadline_at timestamptz,

    status text not null default 'created',
    failure_reason text,

    created_at timestamptz not null default now(),
    committed_at timestamptz,
    sent_at timestamptz,
    settled_at timestamptz
);

-- Per-owner in-flight lock: at most one open cash-out per merchant.
--
-- Needed for two independent reasons. First, `partner_user_ref` is a per-
-- merchant handle, so the transaction list would otherwise return several open
-- orders and `to_address` could bind to an abandoned one. Second, owned coin
-- object versions are pinned at tx.build() time, so any concurrent flow on the
-- same address (a second cash-out, a withdraw, a yield toggle) invalidates
-- them.
create unique index if not exists coinbase_offramp_one_open_per_owner
    on public.coinbase_offramp_requests (owner)
    where status in ('created', 'committed', 'sent');

-- Reconcile cron scan: oldest non-terminal rows first.
create index if not exists coinbase_offramp_status_created_idx
    on public.coinbase_offramp_requests (status, created_at);

-- Merchant history / ops lookup.
create index if not exists coinbase_offramp_owner_idx
    on public.coinbase_offramp_requests (owner);

-- RLS: service-role-only, same posture as cashout_requests and kyb_submissions.
alter table public.coinbase_offramp_requests enable row level security;

drop policy if exists "coinbase_offramp_service_only_select" on public.coinbase_offramp_requests;
create policy "coinbase_offramp_service_only_select" on public.coinbase_offramp_requests
    for select using (false);

drop policy if exists "coinbase_offramp_service_only_insert" on public.coinbase_offramp_requests;
create policy "coinbase_offramp_service_only_insert" on public.coinbase_offramp_requests
    for insert with check (false);

drop policy if exists "coinbase_offramp_service_only_update" on public.coinbase_offramp_requests;
create policy "coinbase_offramp_service_only_update" on public.coinbase_offramp_requests
    for update using (false);

drop policy if exists "coinbase_offramp_service_only_delete" on public.coinbase_offramp_requests;
create policy "coinbase_offramp_service_only_delete" on public.coinbase_offramp_requests
    for delete using (false);

-- Kill switch for the whole rail (UI section + /api/offramp/coinbase/*).
-- Off by default. There is no offramp sandbox, so every end-to-end test is
-- real money against production Coinbase — this stays off until a capped live
-- run has been done deliberately.
insert into public.feature_flags (flag_name, enabled, last_changed_reason)
values (
    'coinbase_offramp_enabled',
    false,
    'Coinbase offramp seed; no sandbox exists, so flip on only for a capped live run'
)
on conflict (flag_name) do nothing;
