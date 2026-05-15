-- Performance-fee cost-basis ledger.
--
-- Records every yield-routed mint that hits a merchant's address, so the
-- redeem path can compute the merchant's weighted-average cost basis and
-- charge a Quay fee on the actual profit (current_value − cost_basis),
-- not on principal.
--
-- One row per (tx_digest, merchant_address). The indexer cron at
-- /api/cron/scallop-cost-basis-indexer scans PaymentReceipt events with
-- `token_type = SCALLOP_USDSUI`, joins them with the same-tx MintEvent,
-- and writes here. Redeem-time logic in /api/sponsor/{toggle-yield,
-- earn-move} reads + consumes rows FIFO.
--
-- FIFO consumption is tracked via `consumed_share_minor`; rows with
-- `consumed_share_minor == mint_share_minor` are fully drained but kept
-- as audit history. Pruning happens manually if storage becomes an issue.

create table if not exists public.yield_cost_basis (
    -- Sui tx digest where the mint landed.
    tx_digest text not null,

    -- 0x-prefixed Sui address of the receiving merchant.
    merchant_address text not null,

    -- sUSDsui (SCALLOP_USDSUI) units acquired in this mint. 6-decimal
    -- minor units. Stored as numeric to accommodate u64-sized values
    -- without JS BigInt → float drift on round-trips.
    mint_share_minor numeric not null check (mint_share_minor >= 0),

    -- Underlying USDsui (6-decimal minor units) deposited at mint time.
    -- This is the cost basis numerator for this row.
    mint_underlying_minor numeric not null check (mint_underlying_minor >= 0),

    -- How much of `mint_share_minor` has been consumed by redeems (FIFO
    -- order). Starts at 0; rises to `mint_share_minor` when fully drained.
    -- A row stays in the table after full consumption so the audit log
    -- never goes back in time.
    consumed_share_minor numeric not null default 0
        check (consumed_share_minor >= 0 AND consumed_share_minor <= mint_share_minor),

    -- Observed-at time (when the indexer wrote this row, not when the tx
    -- was confirmed on-chain — close enough for FIFO ordering at human
    -- scale).
    observed_at timestamptz not null default now(),

    primary key (tx_digest, merchant_address)
);

-- FIFO scan needs (merchant, observed_at) — primary key alone is insufficient.
create index if not exists yield_cost_basis_merchant_fifo_idx
    on public.yield_cost_basis (merchant_address, observed_at)
    where consumed_share_minor < mint_share_minor;

alter table public.yield_cost_basis enable row level security;

-- No public reads — cost-basis is per-merchant and could be sensitive if
-- aggregated. All access goes through server endpoints using the service
-- role.
drop policy if exists "yield_cost_basis_service_only" on public.yield_cost_basis;
create policy "yield_cost_basis_service_only" on public.yield_cost_basis
    for all using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');

-- ─── Fee config seeded into feature_flags.metadata ──────────────────────
--
-- Quay performance fee on yield gains. Lives in the existing
-- yield_routing.scallop.usdsui flag's metadata so ops can dial via the
-- Supabase dashboard with no redeploy.
--
--   yield_fee_bps      — basis points (10000 = 100%) charged on the
--                        positive delta between redeem value and cost
--                        basis. 1000 = 10%.
--   quay_treasury      — Sui address that receives the fee. Defaults to
--                        the existing QUAY.adminAddress (which is already
--                        the Cetus aggregator partner recipient).
--
-- The redeem endpoints read these on every call; the 10s feature-flag
-- cache keeps it cheap.
update public.feature_flags
   set metadata = metadata
       || jsonb_build_object(
              'yield_fee_bps', 1000,
              'quay_treasury', '0xa91644aa47914b16b73258c1de984e3296ef15e40a838ffd3b8fa533b27def2f'
          )
 where flag_name = 'yield_routing.scallop.usdsui'
   and not (metadata ? 'yield_fee_bps');
