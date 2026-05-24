import "server-only";

import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { NextResponse } from "next/server";

import { getFeatureFlag } from "@/lib/server/feature-flags";
import {
  checkAndIncrementSponsorUsage,
  loadSponsorKeypair,
} from "@/lib/server/sponsor";
import {
  DEFAULT_CALL_PACKAGE,
  USDSUI,
  buildMintWithSCoinWrap,
  buildRedeemFromSCoin,
  getPoolCash,
  getSharePrice,
  preflightScallopHealthy,
  safeCallPackage,
} from "@/lib/quay/scallop";
import {
  computeRedeemFee,
  getYieldFeeConfig,
  readCostBasis,
} from "@/lib/server/yield-cost-basis";
import { looksLikeUen } from "@/lib/sgqr";
import { QUAY, SUI_NETWORK } from "@/lib/sui-config";

export const runtime = "nodejs";

/**
 * Sponsored merchant yield-routing toggle.
 *
 * Atomically (per chunk):
 *   1. Updates `MerchantEntry.metadata_uri` to the new Walrus blob (where
 *      `yield_routing.enabled` is set to the new value).
 *   2. If turning ON  + merchant holds liquid USDsui → mints all of it
 *      into Scallop and wraps as `Coin<SCALLOP_USDSUI>` for the merchant.
 *   3. If turning OFF + merchant holds sUSDsui → redeems all of it back
 *      to liquid USDsui (partial if pool cash insufficient — leftover
 *      stays as sUSDsui until liquidity returns, surfaced in the
 *      response).
 *
 * Server-side coin fetch (D11): merchant never supplies coin IDs. The
 * server queries `sui.getCoins({ owner, coinType })` and assembles the
 * full PTB. A malicious caller can't trick us into draining someone
 * else's coins because Sui's coin ownership is enforced at the RPC layer
 * (and at PTB execution).
 *
 * Batched migration (D8 — deferred for v1): if the merchant holds >50
 * coin objects of the relevant type, the endpoint returns HTTP 413 with
 * a `too_many_coins` payload. v1 merchants get a handful of coins per
 * payment session, well under the cap; high-volume merchants will land
 * the batched path in a follow-up.
 *
 * Idempotency: `idempotency_key` (15-min TTL) — duplicate requests get
 * the cached response, preventing race-condition double-toggles. Lives
 * in-process; restarting the server clears the cache.
 *
 * Rate limit: 5/day per merchant, separate counter from update-metadata.
 *
 * Network handoff: on testnet (Quay's current network), Scallop reserves
 * don't exist — `sui.getCoins({ coinType: USDsui })` returns empty and
 * the endpoint degrades to a metadata-only update. The full
 * mint/redeem dance fires only after the global feature flag is on AND
 * the merchant actually holds the relevant coins (mainnet deploy).
 */

const DAILY_CAP = 5;
const RATE_LIMIT_LABEL = "toggle-yield";
const LOW_BALANCE_FLOOR_MIST = 40_000_000n; // 20% of 200M target
const CLOCK = "0x6";
const MAX_COINS_PER_PTB = 50;
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const FEATURE_FLAG_NAME = "yield_routing.scallop.usdsui";

const sui = new SuiClient({ network: SUI_NETWORK, url: getFullnodeUrl(SUI_NETWORK) });

interface ToggleYieldRequest {
  uen: string;
  owner: string;
  new_metadata_blob_id: string | null;
  new_yield_enabled: boolean;
  idempotency_key: string;
}

interface SponsoredTx {
  tx_bytes_b64: string;
  sponsor_signature: string;
}

interface ToggleYieldResponse {
  mode: "single";
  /** What happened beyond the metadata update. */
  migration:
    | { kind: "none"; reason: string }
    | { kind: "mint"; coin_count: number; total_underlying_minor: string }
    | {
        kind: "redeem";
        coin_count: number;
        total_share_minor: string;
        redeemable_share_minor: string;
        leftover_share_minor: string;
        partial: boolean;
        /** Underlying USDsui Quay takes as performance fee (10% of gain, by default). */
        fee_underlying_minor: string;
        /** Cost-basis the fee was computed against (USDsui underlying). */
        cost_basis_underlying_minor: string;
        /** True when the ledger didn't cover full balance (fee may be under-charged). */
        insufficient_cost_basis: boolean;
        /** Sui address that received the fee. */
        fee_recipient: string;
      };
  tx: SponsoredTx;
  sponsor_address: string;
  daily_cap: number;
}

interface IdempotencyEntry {
  at: number;
  response: ToggleYieldResponse | { error: string; status: number; body: unknown };
}

const idempotencyCache = new Map<string, IdempotencyEntry>();

function getIdempotent(key: string): IdempotencyEntry | null {
  const now = Date.now();
  const e = idempotencyCache.get(key);
  if (!e) return null;
  if (now - e.at > IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(key);
    return null;
  }
  return e;
}

function putIdempotent(key: string, entry: IdempotencyEntry): void {
  idempotencyCache.set(key, entry);
}

export async function POST(req: Request) {
  let body: ToggleYieldRequest;
  try {
    body = (await req.json()) as ToggleYieldRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Validation
  if (!body.uen || !body.owner || !body.idempotency_key) {
    return NextResponse.json(
      { error: "uen, owner, idempotency_key required" },
      { status: 400 },
    );
  }
  if (!looksLikeUen(body.uen)) {
    return NextResponse.json(
      { error: `UEN '${body.uen}' invalid` },
      { status: 400 },
    );
  }
  if (!/^0x[0-9a-fA-F]+$/.test(body.owner)) {
    return NextResponse.json(
      { error: "invalid owner address" },
      { status: 400 },
    );
  }
  if (typeof body.new_yield_enabled !== "boolean") {
    return NextResponse.json(
      { error: "new_yield_enabled must be boolean" },
      { status: 400 },
    );
  }
  if (
    body.new_metadata_blob_id !== null &&
    typeof body.new_metadata_blob_id !== "string"
  ) {
    return NextResponse.json(
      { error: "new_metadata_blob_id must be string | null" },
      { status: 400 },
    );
  }

  // Idempotency check — return cached response (success or error) for
  // repeat requests within the TTL.
  const cached = getIdempotent(body.idempotency_key);
  if (cached) {
    if ("error" in cached.response) {
      return NextResponse.json(cached.response.body, {
        status: cached.response.status,
      });
    }
    return NextResponse.json(cached.response);
  }

  // Global feature flag gate. Allows ops to disable the entire toggle
  // path without touching the per-merchant blob (cron auto-flips on
  // hard Scallop anomalies).
  const flag = await getFeatureFlag(FEATURE_FLAG_NAME);
  if (!flag || !flag.enabled) {
    // Three distinct failure shapes here, all surface as 503 but with
    // different operator-actionable causes:
    //   - flag === null AND Supabase isn't configured server-side → the
    //     server can't reach Supabase to read the flag (missing env vars
    //     in Vercel: SUPABASE_URL / SUPABASE_SERVICE_KEY). Most common
    //     post-deploy failure.
    //   - flag === null AND Supabase IS configured → the row genuinely
    //     doesn't exist (migration not applied, or row deleted).
    //   - flag.enabled === false → ops or the monitor cron disabled it
    //     intentionally; reason field carries the explanation.
    const supabaseConfigured = !!process.env.SUPABASE_URL &&
      !!process.env.SUPABASE_SERVICE_KEY;
    const cause = !flag
      ? supabaseConfigured
        ? "flag row not found in feature_flags table"
        : "Supabase not configured on the server (set SUPABASE_URL + SUPABASE_SERVICE_KEY in Vercel)"
      : flag.last_changed_reason ?? "flag is off";
    const body503 = {
      error: "yield routing temporarily unavailable",
      flag: FEATURE_FLAG_NAME,
      cause,
    };
    putIdempotent(body.idempotency_key, {
      at: Date.now(),
      response: { error: "disabled", status: 503, body: body503 },
    });
    return NextResponse.json(body503, { status: 503 });
  }

  // Rate limit — production-only.
  if (process.env.NODE_ENV !== "development") {
    const usageCheck = checkAndIncrementSponsorUsage(
      `${body.owner}:${RATE_LIMIT_LABEL}`,
      DAILY_CAP,
    );
    if (!usageCheck.ok) {
      const body429 = {
        error: "daily sponsored-gas cap reached for toggle-yield",
        cap: DAILY_CAP,
        reset_at_ms: usageCheck.resetAt,
      };
      return NextResponse.json(body429, { status: 429 });
    }
  }

  // Load sponsor key + balance floor.
  let sponsor;
  try {
    sponsor = loadSponsorKeypair();
  } catch (e) {
    return NextResponse.json(
      {
        error: `sponsor key unavailable: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 },
    );
  }
  const sponsorAddr = sponsor.toSuiAddress();
  const sponsorBal = await sui.getBalance({ owner: sponsorAddr });
  if (BigInt(sponsorBal.totalBalance) < LOW_BALANCE_FLOOR_MIST) {
    return NextResponse.json(
      {
        error: "sponsor balance below floor — refusing to sign",
        sponsor_balance_mist: sponsorBal.totalBalance,
        floor_mist: LOW_BALANCE_FLOOR_MIST.toString(),
      },
      { status: 503 },
    );
  }

  // Pre-flight Scallop health (D7). If unhealthy and the user is trying
  // to turn yield ON, refuse — we'd otherwise mint into a paused market.
  // For turning OFF we still let it through: stuck sUSDsui must always
  // be redeemable when possible.
  const rawCallPackage =
    typeof flag.metadata.last_seen_package === "string"
      ? flag.metadata.last_seen_package
      : DEFAULT_CALL_PACKAGE;
  // Defensive: never route to a package missing the protocol modules,
  // whatever wrote last_seen_package (cron false-positive, manual edit).
  // `redeem` is the canary — the protocol package has it, a facade doesn't.
  const callPackage = await safeCallPackage(sui, rawCallPackage, "redeem");
  if (body.new_yield_enabled) {
    const healthy = await preflightScallopHealthy(sui, USDSUI);
    if (!healthy) {
      const body503 = {
        error: "Scallop pre-flight failed — refusing to mint",
        hint: "try again later; the cron will auto-disable if the issue persists",
      };
      return NextResponse.json(body503, { status: 503 });
    }
  }

  // Server fetches owned coins (D11). For migrate-on: USDsui. For
  // migrate-off: SCALLOP_USDSUI (the sCoin wrapper). The result drives
  // the PTB shape.
  const migrationCoinType = body.new_yield_enabled
    ? USDSUI.coinType
    : USDSUI.sCoinType;
  const coinsRes = await sui.getCoins({
    owner: body.owner,
    coinType: migrationCoinType,
    limit: MAX_COINS_PER_PTB + 1,
  });
  if (coinsRes.data.length > MAX_COINS_PER_PTB) {
    const body413 = {
      error: "too_many_coins",
      coin_type: migrationCoinType,
      count: coinsRes.data.length,
      max: MAX_COINS_PER_PTB,
      hint: "batched migration (D8) deferred to a follow-up; consolidate via wallet first",
    };
    putIdempotent(body.idempotency_key, {
      at: Date.now(),
      response: { error: "too_many_coins", status: 413, body: body413 },
    });
    return NextResponse.json(body413, { status: 413 });
  }
  const coinIds = coinsRes.data.map((c) => c.coinObjectId);
  const totalAmount = coinsRes.data.reduce(
    (acc, c) => acc + BigInt(c.balance),
    0n,
  );

  // Build the PTB.
  const tx = new Transaction();
  tx.setSender(body.owner);
  tx.setGasOwner(sponsorAddr);
  // Bumped from update-metadata's 10M: we may do merge + scallop call +
  // wrap + transfer + metadata in one tx. 30M is comfortable headroom.
  tx.setGasBudget(30_000_000n);

  let migration: ToggleYieldResponse["migration"] = {
    kind: "none",
    reason: coinIds.length === 0 ? "merchant has no coins to migrate" : "skipped",
  };

  if (coinIds.length > 0) {
    if (body.new_yield_enabled) {
      // Migrate USDsui → SCALLOP_USDSUI.
      const merged = mergeAll(tx, coinIds);
      const sCoin = buildMintWithSCoinWrap(tx, {
        coin: merged,
        asset: USDSUI,
        callPackage,
      });
      tx.transferObjects([sCoin], tx.pure.address(body.owner));
      migration = {
        kind: "mint",
        coin_count: coinIds.length,
        total_underlying_minor: totalAmount.toString(),
      };
    } else {
      // Migrate SCALLOP_USDSUI → USDsui (partial if pool cash insufficient,
      // and minus the Quay performance fee on any gain).
      const merged = mergeAll(tx, coinIds);
      const [poolCash, sharePrice, ledgerRows] = await Promise.all([
        getPoolCash(sui, USDSUI.coinType),
        getSharePrice(sui, USDSUI.coinType),
        readCostBasis(body.owner),
      ]);
      const partial = computePartialRedeemSync({
        mergedShareBalance: totalAmount,
        poolCash,
        sharePrice,
      });

      const feeConfig = getYieldFeeConfig(flag);
      const feeComp = computeRedeemFee({
        ledgerRowsAsc: ledgerRows,
        onChainShareBalance: totalAmount,
        burnShareMinor: partial.redeemableShare,
        currentSharePrice: sharePrice,
        feeBps: feeConfig.feeBps,
      });

      // Determine which coin gets burnt: either the full merged sCoin
      // (no partial) or a split-off portion (partial), with the leftover
      // sCoin going back to the merchant.
      let sCoinToBurn;
      if (partial.partial) {
        const [redeemable] = tx.splitCoins(merged, [
          tx.pure.u64(partial.redeemableShare),
        ]);
        sCoinToBurn = redeemable;
      } else {
        sCoinToBurn = merged;
      }
      const underlying = buildRedeemFromSCoin(tx, {
        sCoin: sCoinToBurn,
        asset: USDSUI,
        callPackage,
      });

      // Split off the Quay fee BEFORE transferring to the merchant. If
      // the fee is 0 (no gain, or no cost-basis data), skip the split
      // entirely — saves a PTB command.
      const transferToMerchant: Parameters<typeof tx.transferObjects>[0] = [];
      if (feeComp.feeUnderlyingMinor > 0n) {
        const [feeCoin] = tx.splitCoins(underlying, [
          tx.pure.u64(feeComp.feeUnderlyingMinor),
        ]);
        tx.transferObjects(
          [feeCoin],
          tx.pure.address(feeConfig.treasuryAddress),
        );
      }
      transferToMerchant.push(underlying);
      if (partial.partial) transferToMerchant.push(merged);
      tx.transferObjects(transferToMerchant, tx.pure.address(body.owner));

      migration = {
        kind: "redeem",
        coin_count: coinIds.length,
        total_share_minor: totalAmount.toString(),
        redeemable_share_minor: partial.redeemableShare.toString(),
        leftover_share_minor: partial.leftoverShare.toString(),
        partial: partial.partial,
        fee_underlying_minor: feeComp.feeUnderlyingMinor.toString(),
        cost_basis_underlying_minor:
          feeComp.costBasisUnderlyingMinor.toString(),
        insufficient_cost_basis: feeComp.insufficientCostBasis,
        fee_recipient: feeConfig.treasuryAddress,
      };
    }
  }

  // Always: metadata update.
  tx.moveCall({
    target: `${QUAY.packageId}::payments::update_merchant_metadata`,
    arguments: [
      tx.object(QUAY.registryId),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(body.uen))),
      body.new_metadata_blob_id
        ? tx.pure.option("string", body.new_metadata_blob_id)
        : tx.pure.option("string", null),
      tx.object(CLOCK),
    ],
  });

  // Build + co-sign.
  let txBytes: Uint8Array;
  try {
    txBytes = await tx.build({ client: sui });
  } catch (e) {
    return NextResponse.json(
      {
        error: `tx build failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 },
    );
  }
  const sponsorSig = await sponsor.signTransaction(txBytes);

  const response: ToggleYieldResponse = {
    mode: "single",
    migration,
    tx: {
      tx_bytes_b64: Buffer.from(txBytes).toString("base64"),
      sponsor_signature: sponsorSig.signature,
    },
    sponsor_address: sponsorAddr,
    daily_cap: DAILY_CAP,
  };

  putIdempotent(body.idempotency_key, { at: Date.now(), response });
  return NextResponse.json(response);
}

/**
 * Merge all the merchant's coins of the relevant type into the first
 * one, returning a transaction-result argument pointing at the merged
 * coin. Caller must guarantee `coinIds.length >= 1`.
 */
function mergeAll(tx: Transaction, coinIds: string[]) {
  const [primary, ...rest] = coinIds;
  const primaryArg = tx.object(primary!);
  if (rest.length > 0) {
    tx.mergeCoins(
      primaryArg,
      rest.map((id) => tx.object(id)),
    );
  }
  return primaryArg;
}

interface PartialRedeem {
  partial: boolean;
  redeemableShare: bigint;
  leftoverShare: bigint;
}

/**
 * Compute the largest share amount we can redeem given current pool cash.
 *
 * Math: redeemable_share ≈ floor(pool_cash / share_price). We apply a
 * conservative 1% haircut on `pool_cash` to leave headroom for share-price
 * drift / concurrent borrows between this read and the tx commit.
 *
 * Float share-price multiplication is imprecise on bigint amounts; we
 * round DOWN so the on-chain redeem can never request more cash than
 * exists.
 *
 * Caller supplies the share price already (pulled in parallel with the
 * cost-basis read upstream) so this stays pure.
 */
function computePartialRedeemSync(args: {
  mergedShareBalance: bigint;
  poolCash: bigint;
  sharePrice: number;
}): PartialRedeem {
  const { mergedShareBalance, poolCash, sharePrice } = args;
  if (mergedShareBalance === 0n) {
    return { partial: false, redeemableShare: 0n, leftoverShare: 0n };
  }
  if (sharePrice <= 0) {
    // Genesis edge — assume 1:1 (every fresh reserve starts at 1.0).
    return {
      partial: false,
      redeemableShare: mergedShareBalance,
      leftoverShare: 0n,
    };
  }
  const HAIRCUT_BPS = 100n; // 1%
  const haircut = (poolCash * HAIRCUT_BPS) / 10_000n;
  const usableCash = poolCash > haircut ? poolCash - haircut : 0n;
  const sharesAtCash = BigInt(Math.floor(Number(usableCash) / sharePrice));
  if (sharesAtCash >= mergedShareBalance) {
    return {
      partial: false,
      redeemableShare: mergedShareBalance,
      leftoverShare: 0n,
    };
  }
  return {
    partial: true,
    redeemableShare: sharesAtCash,
    leftoverShare: mergedShareBalance - sharesAtCash,
  };
}
