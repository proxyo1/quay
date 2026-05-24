import "server-only";

import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { NextResponse } from "next/server";

import { getSupabaseClient } from "@/lib/server/supabase";
import {
  resetFeatureFlagCache,
  type FeatureFlagRow,
} from "@/lib/server/feature-flags";
import {
  TYPE_PACKAGE,
  USDSUI,
  readMarketState,
  resetPreflightCache,
  resolveProtocolPackage,
  type MarketState,
} from "@/lib/quay/scallop";

export const runtime = "nodejs";

/**
 * Weekly Scallop state monitor (D10).
 *
 * Invoked by `vercel.json`'s cron entry (Mondays 06:00 UTC). Reads the
 * live Scallop USDsui reserve state, compares against the baseline in
 * `feature_flags.metadata`, writes the observation back, and AUTO-FLIPS
 * `enabled = false` on hard anomalies:
 *
 *   - `whitelist_rejected`  — `AllowAllKey` dynamic field disappeared
 *                             (Scallop flipped to RejectAll; no one can
 *                             mint/redeem; existing balances are stuck
 *                             until Scallop reverts)
 *   - `reserve_removed`     — USDsui balance-sheet dynamic field gone
 *                             (asset delisted)
 *   - `supply_cap_full`     — supplied ≥ cap (mints will abort with 81922)
 *
 * Soft observations that update metadata but DO NOT flip the flag:
 *
 *   - `package_upgraded`    — Scallop publishes upgrades routinely; the
 *                             cron records the new package id so the
 *                             sponsor endpoints route there on the next
 *                             call. Flipping the flag on every upgrade
 *                             would create false outages.
 *   - `utilization_drift`   — pure observation; the wallet/UI may want
 *                             to surface it but the feature stays on.
 *
 * Auth: Vercel adds `Authorization: Bearer ${CRON_SECRET}` when invoking
 * crons on production deployments. Locally / in dev where CRON_SECRET
 * isn't set, the check is skipped so you can curl the endpoint to test
 * the logic. Set `CRON_SECRET` in production to enforce.
 *
 * Idempotent: safe to invoke multiple times. Each call reads, decides,
 * writes — no accumulated state.
 *
 * Returns a JSON summary. Successful runs return `ok: true`; failures
 * return HTTP 500 with the error (Vercel logs the response body to the
 * cron dashboard for triage).
 */

const FEATURE_FLAG_NAME = "yield_routing.scallop.usdsui";
const MIN_CAP_HEADROOM = 0.01; // 1% — same threshold preflightScallopHealthy uses

// Scallop's main market is mainnet-only. Hard-coded to mainnet RPC even
// though Quay itself is on testnet today (Phase 6+ flips to mainnet after
// the Move audit; the cron stays pointed at Scallop mainnet either way).
const SCALLOP_RPC = getFullnodeUrl("mainnet");

interface Anomaly {
  kind:
    | "whitelist_rejected"
    | "reserve_removed"
    | "supply_cap_full"
    | "package_upgraded"
    | "package_unresolved"
    | "utilization_drift";
  /** True if this should flip the global flag off. */
  hard: boolean;
  /** Human-readable message for logs. */
  message: string;
  /** Old vs new state for diff visibility. */
  before?: string;
  after?: string;
}

interface MonitorResponse {
  ok: boolean;
  checked_at: string;
  state: {
    allowAll: boolean;
    supplyLimit: string;
    suppliedUnderlying: string;
    utilization: number;
  } | null;
  current_package: string | null;
  anomalies: Anomaly[];
  flag_flipped: boolean;
  previous_enabled: boolean;
  new_enabled: boolean;
  error?: string;
}

function authorize(req: Request): { ok: true } | { ok: false; status: number } {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Local / preview — no secret configured, allow.
    return { ok: true };
  }
  const got = req.headers.get("authorization");
  if (got === `Bearer ${expected}`) return { ok: true };
  return { ok: false, status: 401 };
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: auth.status },
    );
  }

  const checkedAt = new Date().toISOString();
  const sui = new SuiClient({ network: "mainnet", url: SCALLOP_RPC });

  // 1. Load current flag row + baseline metadata.
  const supabase = getSupabaseClient();
  if (!supabase) {
    return NextResponse.json(
      {
        ok: false,
        checked_at: checkedAt,
        state: null,
        current_package: null,
        anomalies: [],
        flag_flipped: false,
        previous_enabled: false,
        new_enabled: false,
        error: "supabase not configured (no SUPABASE_URL / SUPABASE_SERVICE_KEY)",
      } satisfies MonitorResponse,
      { status: 500 },
    );
  }

  const { data: flagData, error: flagErr } = await supabase
    .from("feature_flags")
    .select("flag_name, enabled, last_changed_at, last_changed_reason, metadata")
    .eq("flag_name", FEATURE_FLAG_NAME)
    .maybeSingle();

  if (flagErr || !flagData) {
    return NextResponse.json(
      {
        ok: false,
        checked_at: checkedAt,
        state: null,
        current_package: null,
        anomalies: [],
        flag_flipped: false,
        previous_enabled: false,
        new_enabled: false,
        error: `feature_flags row missing: ${flagErr?.message ?? "no row"}`,
      } satisfies MonitorResponse,
      { status: 500 },
    );
  }

  const flag = flagData as FeatureFlagRow;
  const previousEnabled = flag.enabled;
  const baseline = flag.metadata as Record<string, unknown>;
  const baselinePackage =
    typeof baseline.last_seen_package === "string"
      ? baseline.last_seen_package
      : null;
  const baselineUtilization =
    typeof baseline.last_seen_utilization === "number"
      ? baseline.last_seen_utilization
      : null;

  // 2. Read live Scallop state.
  let state: MarketState;
  let currentPackage: string | null;
  try {
    [state, currentPackage] = await Promise.all([
      readMarketState(sui, USDSUI),
      discoverCurrentPackage(sui),
    ]);
  } catch (e) {
    // Don't flip the flag on transient RPC failure — just log and bail.
    return NextResponse.json(
      {
        ok: false,
        checked_at: checkedAt,
        state: null,
        current_package: null,
        anomalies: [],
        flag_flipped: false,
        previous_enabled: previousEnabled,
        new_enabled: previousEnabled,
        error: `Scallop read failed: ${e instanceof Error ? e.message : String(e)}`,
      } satisfies MonitorResponse,
      { status: 500 },
    );
  }

  // 3. Detect anomalies.
  const anomalies: Anomaly[] = [];
  if (!state.allowAll) {
    anomalies.push({
      kind: "whitelist_rejected",
      hard: true,
      message:
        "Scallop whitelist no longer in AllowAll mode — mints/redeems gated",
    });
  }
  if (state.supplyLimit === 0n) {
    anomalies.push({
      kind: "reserve_removed",
      hard: true,
      message: "USDsui supply cap dropped to 0 — reserve effectively delisted",
    });
  }
  if (state.utilization >= 1 - MIN_CAP_HEADROOM) {
    anomalies.push({
      kind: "supply_cap_full",
      hard: true,
      message: `USDsui supply cap ≥${((1 - MIN_CAP_HEADROOM) * 100).toFixed(1)}% full; mints will abort 81922`,
      before: baselineUtilization?.toFixed(4),
      after: state.utilization.toFixed(4),
    });
  }
  if (currentPackage && baselinePackage && currentPackage !== baselinePackage) {
    anomalies.push({
      kind: "package_upgraded",
      hard: false,
      message: "Scallop protocol package upgraded — routing updated",
      before: baselinePackage,
      after: currentPackage,
    });
  }
  // Discovery couldn't validate a package with mint+redeem (e.g. the latest
  // MintEvent came through a facade/wrapper). We keep the known-good baseline
  // rather than corrupt routing — this is what the 2026-05-18 incident needed.
  if (currentPackage === null && baselinePackage) {
    anomalies.push({
      kind: "package_unresolved",
      hard: false,
      message:
        "Could not resolve a Scallop protocol package exposing mint+redeem; kept last known-good package",
      before: baselinePackage,
    });
  }
  if (
    baselineUtilization !== null &&
    Math.abs(state.utilization - baselineUtilization) > 0.05
  ) {
    anomalies.push({
      kind: "utilization_drift",
      hard: false,
      message: "Utilization shifted >5% since last check",
      before: baselineUtilization.toFixed(4),
      after: state.utilization.toFixed(4),
    });
  }

  // 4. Decide whether to flip.
  const hardHit = anomalies.some((a) => a.hard);
  const newEnabled = hardHit ? false : previousEnabled;

  // 5. Compose updated metadata. Keep last-5 anomalies for context (LRU).
  const previousAnomalies = Array.isArray(baseline.anomalies)
    ? (baseline.anomalies as unknown[])
    : [];
  const newAnomalyEntries = anomalies.map((a) => ({
    ...a,
    observed_at: checkedAt,
  }));
  const updatedMetadata: Record<string, unknown> = {
    ...baseline,
    last_seen_package: currentPackage ?? baselinePackage,
    last_seen_supply_cap: state.supplyLimit.toString(),
    last_seen_supplied: state.suppliedUnderlying.toString(),
    last_seen_utilization: state.utilization,
    last_checked_at: checkedAt,
    anomalies: [...newAnomalyEntries, ...previousAnomalies].slice(0, 5),
  };

  const reason = hardHit
    ? `cron: auto-flip on hard anomaly (${anomalies.filter((a) => a.hard).map((a) => a.kind).join(", ")})`
    : anomalies.length > 0
      ? `cron: routine observation (${anomalies.map((a) => a.kind).join(", ")})`
      : `cron: routine check — no anomalies`;

  // 6. Write back. Service-role key bypasses RLS; the policy still
  // protects against accidental anon mutations.
  const { error: updateErr } = await supabase
    .from("feature_flags")
    .update({
      enabled: newEnabled,
      last_changed_reason: reason,
      metadata: updatedMetadata,
    })
    .eq("flag_name", FEATURE_FLAG_NAME);

  if (updateErr) {
    return NextResponse.json(
      {
        ok: false,
        checked_at: checkedAt,
        state: {
          allowAll: state.allowAll,
          supplyLimit: state.supplyLimit.toString(),
          suppliedUnderlying: state.suppliedUnderlying.toString(),
          utilization: state.utilization,
        },
        current_package: currentPackage,
        anomalies,
        flag_flipped: false,
        previous_enabled: previousEnabled,
        new_enabled: previousEnabled,
        error: `feature_flags write failed: ${updateErr.message}`,
      } satisfies MonitorResponse,
      { status: 500 },
    );
  }

  // Invalidate the in-memory caches across this server instance so the
  // next request sees the fresh state immediately (no 30s lag).
  resetFeatureFlagCache();
  resetPreflightCache();

  return NextResponse.json({
    ok: true,
    checked_at: checkedAt,
    state: {
      allowAll: state.allowAll,
      supplyLimit: state.supplyLimit.toString(),
      suppliedUnderlying: state.suppliedUnderlying.toString(),
      utilization: state.utilization,
    },
    current_package: currentPackage,
    anomalies,
    flag_flipped: previousEnabled !== newEnabled,
    previous_enabled: previousEnabled,
    new_enabled: newEnabled,
  } satisfies MonitorResponse);
}

/**
 * Discovers the current Scallop protocol package.
 *
 * Starting point: the most recent `${TYPE_PACKAGE}::mint::MintEvent`'s
 * `packageId`. But that id can be a facade/wrapper package rather than the
 * callable protocol package — on 2026-05-18 it was `0xd54c9437…`, which has
 * only a `scallop` module and no `mint`/`redeem`, and recording it broke
 * every redeem/mint PTB ("No module found with module name redeem").
 *
 * `resolveProtocolPackage` therefore validates the candidate exposes
 * `mint`+`redeem`, and if not, follows its linkage table to the real
 * protocol package (`TYPE_PACKAGE -> upgraded_id`). Returns `null` when no
 * valid package can be resolved — the caller then keeps the known-good
 * baseline instead of corrupting routing.
 */
async function discoverCurrentPackage(
  sui: SuiClient,
): Promise<string | null> {
  const res = await sui.queryEvents({
    query: { MoveEventType: `${TYPE_PACKAGE}::mint::MintEvent` },
    limit: 1,
    order: "descending",
  });
  const candidate = res.data[0]?.packageId ?? null;
  return resolveProtocolPackage(sui, candidate);
}
