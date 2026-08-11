-- Sponsored-gas daily usage counter.
--
-- The counter lived in a per-process `Map` in lib/server/sponsor.ts, with a
-- comment noting that production would want a real store. On Vercel each
-- serverless instance starts with an empty Map, so the cap never actually
-- bound: a caller spread across N instances got N times the allowance, and a
-- redeploy reset everyone to zero. This makes it durable and shared.
--
-- Rows are keyed by the same string the application already used —
-- `<owner>` or `<owner>:<label>` — so the per-route counters
-- (`:toggle-yield`, `:earn-move`, `:coinbase-offramp`) stay separate.

create table if not exists public.sponsor_usage (
    -- `<sui_address>` or `<sui_address>:<route_label>`.
    usage_key text primary key,
    count integer not null default 0,
    -- When the current window expires and `count` resets to zero.
    reset_at timestamptz not null,
    updated_at timestamptz not null default now()
);

-- Ops: find who is hitting caps, and let a cleanup job drop expired rows.
create index if not exists sponsor_usage_reset_at_idx
    on public.sponsor_usage (reset_at);

/*
 * Atomically consume one unit of a caller's daily allowance.
 *
 * Must be a function rather than a read-then-write from the application: two
 * concurrent requests both reading count=4 against a cap of 5 would each
 * write 5 and both proceed, which is exactly the race a rate limit exists to
 * prevent. `insert … on conflict do update` under a single statement gives us
 * the row lock for free.
 *
 * Returns the post-increment state so the caller can report `reset_at` on a
 * rejection without a second query. `allowed` is false when the cap is
 * already reached; in that case `count` is left untouched.
 */
create or replace function public.consume_sponsor_usage(
    p_usage_key text,
    p_daily_cap integer,
    p_window_ms bigint
)
returns table (allowed boolean, current_count integer, reset_at timestamptz)
language plpgsql
as $$
declare
    v_now timestamptz := now();
    v_reset timestamptz;
    v_count integer;
begin
    -- Take the row lock up front so the expiry check and the increment cannot
    -- interleave with a concurrent caller.
    insert into public.sponsor_usage (usage_key, count, reset_at, updated_at)
    values (p_usage_key, 0, v_now + make_interval(secs => p_window_ms / 1000.0), v_now)
    on conflict (usage_key) do update
        set updated_at = v_now
    returning public.sponsor_usage.count, public.sponsor_usage.reset_at
    into v_count, v_reset;

    -- Expired window: start a fresh one.
    if v_reset <= v_now then
        v_count := 0;
        v_reset := v_now + make_interval(secs => p_window_ms / 1000.0);
    end if;

    if v_count >= p_daily_cap then
        update public.sponsor_usage
            set reset_at = v_reset, updated_at = v_now
            where usage_key = p_usage_key;
        return query select false, v_count, v_reset;
        return;
    end if;

    v_count := v_count + 1;
    update public.sponsor_usage
        set count = v_count, reset_at = v_reset, updated_at = v_now
        where usage_key = p_usage_key;

    return query select true, v_count, v_reset;
end;
$$;

-- RLS: service-role-only, matching cashout_requests and kyb_submissions. The
-- application mediates every read and write through server routes.
alter table public.sponsor_usage enable row level security;

drop policy if exists "sponsor_usage_service_only_select" on public.sponsor_usage;
create policy "sponsor_usage_service_only_select" on public.sponsor_usage
    for select using (false);

drop policy if exists "sponsor_usage_service_only_insert" on public.sponsor_usage;
create policy "sponsor_usage_service_only_insert" on public.sponsor_usage
    for insert with check (false);

drop policy if exists "sponsor_usage_service_only_update" on public.sponsor_usage;
create policy "sponsor_usage_service_only_update" on public.sponsor_usage
    for update using (false);

drop policy if exists "sponsor_usage_service_only_delete" on public.sponsor_usage;
create policy "sponsor_usage_service_only_delete" on public.sponsor_usage
    for delete using (false);
