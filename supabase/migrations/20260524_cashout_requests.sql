-- Merchant USDsui -> SGD cash-out (manual Wise-sandbox demo)
--
-- Tracks each cash-out attempt as a state machine so the two non-atomic
-- legs (on-chain USDsui transfer to treasury, then Wise SGD payout) can
-- never silently lose a merchant's money. Every transition is persisted;
-- `confirm` is idempotent on `sui_digest`; stuck rows are recoverable via
-- scripts/cashout-redrive.ts.
--
-- THIS IS A DEMO TABLE. The whole cash-out flow is custodial-by-treasury
-- and sandbox-only; it gets deleted when the licensed V2 settlement leg
-- lands (see TODOS line 67). Do not build production reporting on it.
--
-- State machine:
--   signed     -> row created at /api/cashout/initiate (merchant signed the
--                 sponsored USDsui->treasury tx; net_sgd/fee/rate LOCKED here)
--   received   -> /api/cashout/confirm verified the USDsui landed in treasury
--   paying     -> Wise quote+recipient+transfer created, funding in flight
--   paid_out   -> Wise transfer funded (terminal success)
--   failed     -> any post-receipt failure (terminal until re-driven)
--
-- Apply via Mysten Supabase MCP or `supabase migration up`.

create table if not exists public.cashout_requests (
    id uuid primary key default gen_random_uuid(),

    -- Merchant Sui address (zkLogin) that signed the transfer and whose
    -- USDsui is being cashed out. The on-chain verify binds the tx sender
    -- to this value.
    owner text not null,

    -- Singapore UEN the merchant is registered under (for the audit trail
    -- and ops lookup). Not used for the payout itself.
    uen text,

    -- Amount of USDsui being cashed out, in 6-decimal microunits.
    amount_usdsui_minor bigint not null check (amount_usdsui_minor > 0),

    -- LOCKED quote (D4): the Pyth USD/SGD rate and the net SGD the merchant
    -- agreed to at sign time. `confirm` pays exactly net_sgd_minor regardless
    -- of later rate drift. fee_bps is Quay's FX fee (25 = 0.25%).
    rate_sgd_per_usd numeric not null check (rate_sgd_per_usd > 0),
    fee_bps integer not null default 25 check (fee_bps >= 0 and fee_bps < 10000),
    net_sgd_minor bigint not null check (net_sgd_minor > 0),

    -- The merchant-supplied Wise recipient fields (bank account + bank code,
    -- or PayNow proxy), shaped by Wise's account-requirements schema. Holds
    -- PII — protected by service-only RLS below, same posture as KYB.
    recipient jsonb not null,

    -- Sui tx digest of the USDsui->treasury transfer. NULL until confirm.
    -- UNIQUE so the same on-chain transfer can never drive two payouts
    -- (idempotency + replay guard). Postgres allows multiple NULLs.
    sui_digest text unique,

    -- Wise sandbox identifiers, filled as the payout progresses.
    wise_quote_id text,
    wise_recipient_id text,
    wise_transfer_id text,

    status text not null default 'signed'
        check (status in ('signed','received','paying','paid_out','failed')),

    -- Set when status='failed'. Operator-facing; surfaced to the merchant
    -- as a generic "payout pending" message, never the raw reason.
    failure_reason text,

    created_at timestamptz not null default now(),
    received_at timestamptz,
    paid_out_at timestamptz
);

-- Ops re-drive scan: find non-terminal / failed rows oldest-first.
create index if not exists cashout_requests_status_created_idx
    on public.cashout_requests (status, created_at);

-- Merchant history / ops lookup by owner.
create index if not exists cashout_requests_owner_idx
    on public.cashout_requests (owner);

-- RLS: service-role-only, same defense-in-depth posture as kyb_submissions.
-- The application mediates all reads/writes via authenticated server routes.
alter table public.cashout_requests enable row level security;

drop policy if exists "cashout_service_only_select" on public.cashout_requests;
create policy "cashout_service_only_select" on public.cashout_requests
    for select using (false);

drop policy if exists "cashout_service_only_insert" on public.cashout_requests;
create policy "cashout_service_only_insert" on public.cashout_requests
    for insert with check (false);

drop policy if exists "cashout_service_only_update" on public.cashout_requests;
create policy "cashout_service_only_update" on public.cashout_requests
    for update using (false);

drop policy if exists "cashout_service_only_delete" on public.cashout_requests;
create policy "cashout_service_only_delete" on public.cashout_requests
    for delete using (false);

-- Kill switch for the whole cash-out flow (UI section + /api/cashout/*).
-- Off by default: flip to true (ops, from the Supabase dashboard) only for
-- the demo window, flip back instantly if Wise sandbox misbehaves on stage.
insert into public.feature_flags (flag_name, enabled, last_changed_reason)
values ('cashout_enabled', false, 'cash-out demo seed; flip on for the demo only')
on conflict (flag_name) do nothing;
