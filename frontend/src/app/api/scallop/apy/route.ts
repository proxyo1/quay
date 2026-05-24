import { NextResponse } from "next/server";

import { USDSUI } from "@/lib/quay/scallop";

export const runtime = "nodejs";
// Supply rates move slowly; re-fetch upstream at most every 10 min.
export const revalidate = 600;

/**
 * Live USDsui supply APY for the "Earn interest" toggle.
 *
 * Reads Scallop's public market endpoint server-side and returns the supply
 * APY for the USDsui reserve (matched by `coinType` against our `USDSUI`
 * constant, so a Scallop symbol rename can't silently hand us the wrong
 * pool). Routed through the server (not fetched in the browser) so we don't
 * depend on Scallop's CORS policy and can cache one upstream call across all
 * merchants. Any failure returns 502 with a typed `error` — the wallet UI
 * falls back to a generic range string rather than showing a wrong number.
 */
const SCALLOP_MARKET_URL = "https://sdk.api.scallop.io/api/market";

interface ScallopPool {
  coinType?: string;
  supplyApr?: number;
  supplyApy?: number;
}

interface ScallopMarket {
  pools?: ScallopPool[];
  updatedAt?: string;
}

export async function GET() {
  let market: ScallopMarket;
  try {
    const res = await fetch(SCALLOP_MARKET_URL, {
      headers: { accept: "application/json" },
      next: { revalidate },
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: "scallop_unavailable", cause: `upstream HTTP ${res.status}` },
        { status: 502 },
      );
    }
    market = (await res.json()) as ScallopMarket;
  } catch (e) {
    return NextResponse.json(
      { error: "scallop_fetch_failed", cause: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  const want = USDSUI.coinType.toLowerCase();
  const pool = market.pools?.find((p) => (p.coinType ?? "").toLowerCase() === want);
  if (!pool || typeof pool.supplyApy !== "number") {
    return NextResponse.json(
      { error: "pool_not_found", cause: "USDsui supply rate missing from Scallop market" },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      supply_apy: pool.supplyApy,
      supply_apr: typeof pool.supplyApr === "number" ? pool.supplyApr : null,
      updated_at: market.updatedAt ?? null,
    },
    { headers: { "cache-control": "public, max-age=300, stale-while-revalidate=600" } },
  );
}
