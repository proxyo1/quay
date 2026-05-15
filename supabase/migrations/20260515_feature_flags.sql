-- Phase 2 (E2): Runtime feature flags
--
-- Replaces build-time `NEXT_PUBLIC_*_ENABLED` env vars with a runtime row.
-- The yield-routing feature (auto-supply USDsui to Scallop) needs a kill
-- switch that can flip without a redeploy: the weekly cron at
-- /api/cron/scallop-monitor auto-flips this on hard Scallop anomalies
-- (package upgrade, whitelist RejectAll, market pause), and ops can flip
-- it manually from the Supabase dashboard.
--
-- Reads are cached ~10s per server instance, so flips propagate within
-- the cache window with no client coordination.
--
-- Apply via Mysten Supabase MCP or `supabase migration up`.

create table if not exists public.feature_flags (
    -- Stable identifier for the flag. Use dotted-namespace form:
    --   yield_routing.scallop.usdsui
    --   payments.cross_token
    flag_name text primary key,

    -- Live state. Default false: every flag starts off and must be
    -- explicitly turned on, either by migration or by ops.
    enabled boolean not null default false,

    -- Audit: when the row was last written. Updated by trigger below.
    last_changed_at timestamptz not null default now(),

    -- Free-form: human or cron reason for the most recent change.
    -- e.g. "cron: scallop package upgrade detected"
    --      "ops: pilot rollout begin"
    last_changed_reason text,

    -- Structured context for monitored flags. For yield_routing.scallop.*:
    --   { "last_seen_package": "0xde5c09ad...",
    --     "last_seen_supply_cap": "1000000000000",
    --     "last_seen_utilization": 0.795,
    --     "anomalies": [] }
    -- Schema is flag-specific; consumers should tolerate missing keys.
    metadata jsonb not null default '{}'::jsonb
);

-- Auto-update last_changed_at on any write. Bumps the timestamp even
-- when only metadata changes, which is the desired audit posture.
create or replace function public.feature_flags_touch_last_changed()
returns trigger
language plpgsql
as $$
begin
    new.last_changed_at := now();
    return new;
end;
$$;

drop trigger if exists feature_flags_touch_last_changed on public.feature_flags;
create trigger feature_flags_touch_last_changed
    before update on public.feature_flags
    for each row execute function public.feature_flags_touch_last_changed();

alter table public.feature_flags enable row level security;

-- Public anon read: feature flag state is not a secret. Both server
-- API routes and any future client-side reads can use the anon key.
drop policy if exists "feature_flags_anon_read" on public.feature_flags;
create policy "feature_flags_anon_read" on public.feature_flags
    for select using (true);

-- Writes restricted to service role only. The dashboard's table editor
-- uses the service role under the hood, and the cron monitor must run
-- with a service-key client. No public writes ever.
drop policy if exists "feature_flags_service_write" on public.feature_flags;
create policy "feature_flags_service_write" on public.feature_flags
    for all using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

-- Seed the Scallop USDsui yield-routing flag in the off state. Phase 1
-- verified the integration is technically green-lit (AllowAll, supply
-- cap headroom 49.7%, no Pyth on supply path) but the feature is gated
-- on Phase 3-8 landing first. Flip to true at the start of the internal
-- canary rollout per D13.
insert into public.feature_flags (flag_name, enabled, last_changed_reason, metadata)
values (
    'yield_routing.scallop.usdsui',
    false,
    'phase-2 migration seed; flip on at internal canary',
    jsonb_build_object(
        'protocol', 'scallop',
        'asset', 'usdsui',
        'last_seen_package', '0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805',
        'market_object', '0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9',
        'version_object', '0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7'
    )
)
on conflict (flag_name) do nothing;
