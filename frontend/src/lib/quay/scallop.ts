import type { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";
import type {
  Transaction,
  TransactionObjectArgument,
} from "@mysten/sui/transactions";

/**
 * Thin Scallop client for the yield-routing feature.
 *
 * Scope (Phase 3): just enough to mint into Scallop's USDsui reserve, redeem
 * back out, read share price + pool cash, and gate every payment on a 30s-
 * cached health check (E7, D7). No SDK dependency — the upstream
 * `@scallop-io/sui-scallop-sdk` is 235 KB gzipped after tree-shaking
 * (see Phase 1 verification §Check 3), which is too heavy when we only
 * need four PTB calls and two RPC reads.
 *
 * Key facts from Phase 1 mainnet verification (2026-05-15):
 *  - The original Scallop main market is at `MARKET_OBJECT` below. A second
 *    market exists (`0xed80ed...`) but only carries 3 assets and does NOT
 *    list USDsui — we use the main market exclusively.
 *  - The whitelist is in `AllowAll` mode (zkLogin addresses can mint/redeem).
 *  - The supply path does NOT call Pyth. The pre-flight only checks
 *    whitelist + cap headroom + (optionally) market liquidity.
 *  - Scallop upgrades the protocol package opaquely. **Type identifiers**
 *    (e.g. `<lineage_root>::reserve::MarketCoin<T>`) stay pinned to the
 *    original publish ID forever, but the **call target** is the latest
 *    upgrade. We separate the two as `TYPE_PACKAGE` vs `CALL_PACKAGE`.
 *    The cron at /api/cron/scallop-monitor refreshes `CALL_PACKAGE` in
 *    Supabase `feature_flags.metadata.last_seen_package`; helpers accept
 *    an override so callers can pass the live value at PTB build time.
 */

// ─── Canonical addresses (mainnet, OLD market that has USDsui) ──────────

/**
 * Lineage root of the Scallop protocol package. **Types are pinned here**
 * (e.g. `${TYPE_PACKAGE}::reserve::MarketCoin<USDsui>` is the canonical
 * type-tag regardless of which upgraded package is "current"). Never
 * changes — Move's upgrade model keeps the type system stable at the
 * original publish ID.
 */
export const TYPE_PACKAGE =
  "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";

/**
 * Current callable protocol package (Phase 1 devInspect baseline). Rotates
 * with each Scallop upgrade — prefer the runtime value from
 * `feature_flags.metadata.last_seen_package` when available.
 */
export const DEFAULT_CALL_PACKAGE =
  "0xde5c09ad171544aa3724dc67216668c80e754860f419136a68d78504eb2e2805";

/**
 * sCoin converter package (`s_coin_converter::mint_s_coin` and
 * `burn_s_coin`). Separate package from the protocol; also rotates with
 * upgrades but on its own cadence.
 */
export const DEFAULT_SCOIN_CONVERTER_PACKAGE =
  "0x80ca577876dec91ae6d22090e56c39bc60dce9086ab0729930c6900bc4162b4c";

/** Shared Market object — the supply / borrow state for all reserves. */
export const MARKET_OBJECT =
  "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";

/** Shared Version object — gates calls via `assert_current_version`. */
export const VERSION_OBJECT =
  "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7";

/**
 * Inner Table UID for `Market.vault.balance_sheets.table`. Stable across
 * package upgrades (the Market struct is long-lived). Captured at Phase 1.
 */
const BALANCE_SHEETS_TABLE_ID =
  "0x8708eb23153bdc4b345c9f536fe05b62206f3f55629b26389d4fe5f129bd8368";

const CLOCK_ID = "0x6";

// ─── Asset config (USDsui) ──────────────────────────────────────────────

export interface ScallopAsset {
  /** Underlying coin type, e.g. `0x...::usdsui::USDSUI`. */
  readonly coinType: string;
  /** sCoin wrapper type (what merchants actually hold). */
  readonly sCoinType: string;
  /**
   * sCoin treasury shared object — needed in PTBs that wrap/unwrap via
   * `s_coin_converter`. Mutable shared object reference.
   */
  readonly sCoinTreasury: string;
  /** Coin decimals (matches the underlying — sCoin is 1:1 unit-for-unit). */
  readonly decimals: number;
}

export const USDSUI: ScallopAsset = {
  coinType:
    "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI",
  sCoinType:
    "0x4dc741a062c216e7ac1c47a4034a8941112a5aa5516c128da10f0be2397e836d::scallop_usdsui::SCALLOP_USDSUI",
  sCoinTreasury:
    "0xba68a930f4f35b589071e1247c44ada1c5e28cb3fac437b2cc6f8d9491c3b4bb",
  decimals: 6,
} as const;

/** `Coin<MarketCoin<T>>` type-arg helper. Uses `TYPE_PACKAGE`, never the call package. */
export function marketCoinTypeOf(coinType: string): string {
  return `${TYPE_PACKAGE}::reserve::MarketCoin<${coinType}>`;
}

// ─── PTB builders ───────────────────────────────────────────────────────

export interface MintCallParams {
  /** Coin<T> to deposit. Result of `tx.splitCoins`, aggregator output, etc. */
  readonly coin: TransactionObjectArgument;
  /** Asset to deposit (e.g. `USDSUI`). */
  readonly asset: ScallopAsset;
  /** Override the current Scallop call package (default: `DEFAULT_CALL_PACKAGE`). */
  readonly callPackage?: string;
}

/**
 * Appends `scallop::mint::mint<T>(version, market, coin, clock)` to the
 * PTB and returns the resulting `Coin<MarketCoin<T>>` argument.
 *
 * Callers normally want `buildMintWithSCoinWrap` instead, which adds the
 * `mint_s_coin` step so merchants receive a proper `Coin<SCALLOP_T>`
 * (displays nicely in Sui wallets). Use raw `buildMintCall` only when
 * the next PTB step consumes `MarketCoin<T>` directly.
 */
export function buildMintCall(
  tx: Transaction,
  params: MintCallParams,
): TransactionObjectArgument {
  const callPackage = params.callPackage ?? DEFAULT_CALL_PACKAGE;
  return tx.moveCall({
    target: `${callPackage}::mint::mint`,
    typeArguments: [params.asset.coinType],
    arguments: [
      tx.object(VERSION_OBJECT),
      tx.object(MARKET_OBJECT),
      params.coin,
      tx.object(CLOCK_ID),
    ],
  });
}

export interface MintWithSCoinWrapParams extends MintCallParams {
  /** Override the sCoin converter package (default: `DEFAULT_SCOIN_CONVERTER_PACKAGE`). */
  readonly sCoinConverterPackage?: string;
}

/**
 * Composes `mint::mint<T>` then `s_coin_converter::mint_s_coin<sT, T>`, so
 * the caller receives a `Coin<SCALLOP_T>` — the same shape every recent
 * mainnet supply tx uses (verified against tx
 * `3x57gaaPoLpxkhdqQC64BTangLH4ytG99vWrfAfsjFXQ` at Phase 1). PaymentReceipt
 * will record `token_type = SCALLOP_T`, which is a simpler join than the
 * raw `MarketCoin<T>` event reconciliation.
 */
export function buildMintWithSCoinWrap(
  tx: Transaction,
  params: MintWithSCoinWrapParams,
): TransactionObjectArgument {
  const converterPackage =
    params.sCoinConverterPackage ?? DEFAULT_SCOIN_CONVERTER_PACKAGE;
  const marketCoin = buildMintCall(tx, params);
  return tx.moveCall({
    target: `${converterPackage}::s_coin_converter::mint_s_coin`,
    typeArguments: [params.asset.sCoinType, params.asset.coinType],
    arguments: [tx.object(params.asset.sCoinTreasury), marketCoin],
  });
}

export interface RedeemCallParams {
  /** `Coin<MarketCoin<T>>` to redeem (typically from an `burn_s_coin` step). */
  readonly marketCoin: TransactionObjectArgument;
  readonly asset: ScallopAsset;
  readonly callPackage?: string;
}

/**
 * Appends `scallop::redeem::redeem<T>(version, market, marketCoin, clock)`
 * and returns the resulting `Coin<T>` (underlying — principal + interest).
 *
 * The amount returned is determined by Scallop's exchange rate at the
 * current block (`marketCoinAmount × sharePrice`), gated only by pool
 * liquidity (error 81921 / 81924 if cash is insufficient — pre-check
 * with `getPoolCash` and offer partial-redeem disclosure per DR4).
 */
export function buildRedeemCall(
  tx: Transaction,
  params: RedeemCallParams,
): TransactionObjectArgument {
  const callPackage = params.callPackage ?? DEFAULT_CALL_PACKAGE;
  return tx.moveCall({
    target: `${callPackage}::redeem::redeem`,
    typeArguments: [params.asset.coinType],
    arguments: [
      tx.object(VERSION_OBJECT),
      tx.object(MARKET_OBJECT),
      params.marketCoin,
      tx.object(CLOCK_ID),
    ],
  });
}

export interface RedeemFromSCoinParams {
  /** `Coin<SCALLOP_T>` to unwrap + redeem. */
  readonly sCoin: TransactionObjectArgument;
  readonly asset: ScallopAsset;
  readonly callPackage?: string;
  readonly sCoinConverterPackage?: string;
}

/**
 * Composes `s_coin_converter::burn_s_coin<sT, T>` then `redeem::redeem<T>`,
 * returning the unwrapped `Coin<T>`. This is the toggle-OFF and the
 * "Move to cash" path.
 */
export function buildRedeemFromSCoin(
  tx: Transaction,
  params: RedeemFromSCoinParams,
): TransactionObjectArgument {
  const converterPackage =
    params.sCoinConverterPackage ?? DEFAULT_SCOIN_CONVERTER_PACKAGE;
  const marketCoin = tx.moveCall({
    target: `${converterPackage}::s_coin_converter::burn_s_coin`,
    typeArguments: [params.asset.sCoinType, params.asset.coinType],
    arguments: [tx.object(params.asset.sCoinTreasury), params.sCoin],
  });
  return buildRedeemCall(tx, { ...params, marketCoin });
}

// ─── Reads ──────────────────────────────────────────────────────────────

export interface BalanceSheet {
  /** Free liquidity in the reserve (USDsui units). Used for redeem gating. */
  readonly cash: bigint;
  /** Borrowed amount (USDsui units). */
  readonly debt: bigint;
  /** Protocol revenue accumulator (USDsui units, deducted from supply value). */
  readonly revenue: bigint;
  /** Outstanding sCoin supply (sUSDsui units). */
  readonly marketCoinSupply: bigint;
}

interface SuiMoveStructField<T> {
  readonly type: string;
  readonly fields: T;
}

interface BalanceSheetFields {
  readonly cash: string;
  readonly debt: string;
  readonly revenue: string;
  readonly market_coin_supply: string;
}

interface BalanceSheetWrapper {
  readonly id: { readonly id: string };
  readonly name: SuiMoveStructField<{ readonly name: string }>;
  readonly value: SuiMoveStructField<BalanceSheetFields>;
}

/**
 * Reads the on-chain BalanceSheet for an asset by dynamic-field lookup
 * against `Market.vault.balance_sheets.table`. Returns `null` if the
 * reserve doesn't exist (asset not listed on Scallop).
 *
 * Cost: one RPC roundtrip. Caching is the caller's responsibility — the
 * pool state changes every block, so callers that need accuracy (e.g.
 * `getPoolCash` before a redeem) must NOT cache, while displays can
 * cache for a few seconds.
 */
export async function readBalanceSheet(
  client: SuiClient,
  coinType: string,
): Promise<BalanceSheet | null> {
  const r = await client.getDynamicFieldObject({
    parentId: BALANCE_SHEETS_TABLE_ID,
    name: {
      type: "0x1::type_name::TypeName",
      value: { name: stripLeading0x(coinType) },
    },
  });
  const content = r.data?.content;
  if (!content || content.dataType !== "moveObject") return null;
  const wrapper = content.fields as unknown as BalanceSheetWrapper;
  const v = wrapper.value?.fields;
  if (!v) return null;
  return {
    cash: BigInt(v.cash),
    debt: BigInt(v.debt),
    revenue: BigInt(v.revenue),
    marketCoinSupply: BigInt(v.market_coin_supply),
  };
}

/**
 * Underlying-asset price per sCoin unit (e.g. 1.0165 USDsui / sUSDsui at
 * the time of Phase 1 verification). Multiply a merchant's sCoin balance
 * by this to get their earning-balance in underlying terms.
 *
 * Returns 1.0 if the reserve has zero supply (genesis edge — pool just
 * opened). Throws if the reserve doesn't exist; caller should pre-check
 * with `readBalanceSheet` if that's a real possibility.
 *
 * Precision note: float division is fine for display (we're showing 2-4
 * decimals of SGD). For settlement math, use the underlying amount from
 * Scallop's `MintEvent` or `RedeemEvent` directly — those are exact.
 */
export async function getSharePrice(
  client: SuiClient,
  coinType: string,
): Promise<number> {
  const bs = await readBalanceSheet(client, coinType);
  if (!bs) throw new Error(`Scallop reserve not found for ${coinType}`);
  if (bs.marketCoinSupply === 0n) return 1.0;
  const numerator = bs.cash + bs.debt - bs.revenue;
  return Number(numerator) / Number(bs.marketCoinSupply);
}

/**
 * Free pool liquidity for the reserve. A redeem of more than `cash` will
 * abort on-chain (error 81921 / 81924); use this to clamp the requested
 * amount before showing the partial-redeem disclosure (DR4).
 */
export async function getPoolCash(
  client: SuiClient,
  coinType: string,
): Promise<bigint> {
  const bs = await readBalanceSheet(client, coinType);
  if (!bs) throw new Error(`Scallop reserve not found for ${coinType}`);
  return bs.cash;
}

export interface MarketState {
  /** True if `AllowAllKey` dynamic field is present on the Market UID. */
  readonly allowAll: boolean;
  /** Configured supply cap for the asset (underlying units). */
  readonly supplyLimit: bigint;
  /** Currently supplied = cash + debt − revenue (underlying units). */
  readonly suppliedUnderlying: bigint;
  /** Convenience: `suppliedUnderlying / supplyLimit` as a float in [0, 1]. */
  readonly utilization: number;
}

/**
 * One-shot read of everything `preflightScallopHealthy` needs. Exposed
 * for the cron monitor (Phase 5) and for the wallet UI's "Earning"
 * display, which shows the live cap usage as a trust signal.
 *
 * Three parallel RPCs:
 *  1. AllowAllKey dynamic field check
 *  2. SupplyLimitKey value
 *  3. BalanceSheet for the asset
 */
export async function readMarketState(
  client: SuiClient,
  asset: ScallopAsset,
): Promise<MarketState> {
  const [allowAll, supplyLimit, bs] = await Promise.all([
    isAllowAllSet(client),
    readSupplyLimit(client, asset.coinType),
    readBalanceSheet(client, asset.coinType),
  ]);
  if (!bs) throw new Error(`Scallop reserve not found for ${asset.coinType}`);
  const supplied = bs.cash + bs.debt - bs.revenue;
  return {
    allowAll,
    supplyLimit,
    suppliedUnderlying: supplied,
    utilization:
      supplyLimit === 0n ? 1 : Number(supplied) / Number(supplyLimit),
  };
}

const ALLOWALL_KEY_TYPE =
  "0x1318fdc90319ec9c24df1456d960a447521b0a658316155895014a6e39b5482f::whitelist::AllowAllKey";

/** Verifies the `AllowAllKey` dynamic field is set on the Market UID. */
async function isAllowAllSet(client: SuiClient): Promise<boolean> {
  const r = await client.getDynamicFieldObject({
    parentId: MARKET_OBJECT,
    name: { type: ALLOWALL_KEY_TYPE, value: { dummy_field: false } },
  });
  return r.data?.content?.dataType === "moveObject";
}

const SUPPLY_LIMIT_KEY_TYPE =
  "0x6e641f0dca8aedab3101d047e96439178f16301bf0b57fe8745086ff1195eb3e::market_dynamic_keys::SupplyLimitKey";

interface SupplyLimitWrapper {
  readonly value: string;
}

async function readSupplyLimit(
  client: SuiClient,
  coinType: string,
): Promise<bigint> {
  const r = await client.getDynamicFieldObject({
    parentId: MARKET_OBJECT,
    name: {
      type: SUPPLY_LIMIT_KEY_TYPE,
      value: {
        type: { name: stripLeading0x(coinType) },
      },
    },
  });
  const content = r.data?.content;
  if (!content || content.dataType !== "moveObject") {
    throw new Error(`SupplyLimitKey not found for ${coinType}`);
  }
  const wrapper = content.fields as unknown as SupplyLimitWrapper;
  return BigInt(wrapper.value);
}

// ─── Pre-flight health check (D7 + E7 30s cache) ────────────────────────

const PREFLIGHT_TTL_MS = 30_000;
const MIN_CAP_HEADROOM = 0.01; // 1% — if cap is >99% full, fail closed

interface PreflightCache {
  readonly ok: boolean;
  readonly state: MarketState | null;
  readonly at: number;
}

const preflightCache = new Map<string, PreflightCache>();

/**
 * Returns true when Scallop is in a state where yield-routing should
 * proceed for `asset`. Cached for 30s per asset (E7 — eliminates redundant
 * RPC under retry patterns; the worst-case staleness is one 30s window
 * where a pause hasn't been detected for this user, and the PTB still
 * aborts on chain if the pause did happen).
 *
 * Fail-closed: any RPC error → returns `false` for the TTL window.
 *
 * Pure read; no PTB side effects, no logging. Callers wrap with their
 * own logging context (e.g. /scan logs which path it took).
 */
export async function preflightScallopHealthy(
  client: SuiClient,
  asset: ScallopAsset,
): Promise<boolean> {
  const cached = preflightCache.get(asset.coinType);
  const now = Date.now();
  if (cached && now - cached.at < PREFLIGHT_TTL_MS) return cached.ok;
  try {
    const state = await readMarketState(client, asset);
    const ok =
      state.allowAll &&
      state.suppliedUnderlying < state.supplyLimit &&
      state.utilization < 1 - MIN_CAP_HEADROOM;
    preflightCache.set(asset.coinType, { ok, state, at: now });
    return ok;
  } catch {
    preflightCache.set(asset.coinType, { ok: false, state: null, at: now });
    return false;
  }
}

/**
 * Test/ops hook: drops cached pre-flight results so the next call hits
 * the chain. The cron monitor calls this after detecting a Scallop state
 * change to force every server instance to revalidate within the next
 * request, instead of waiting up to 30s.
 */
export function resetPreflightCache(): void {
  preflightCache.clear();
}

// ─── Internals ──────────────────────────────────────────────────────────

/**
 * Sui RPC compares TypeName dynamic-field keys WITHOUT a leading `0x` and
 * WITHOUT padding zeros (e.g. `2::sui::SUI`, not `0x2::sui::SUI`). The
 * type tags we use everywhere else carry the `0x` prefix — strip it here.
 */
function stripLeading0x(typeTag: string): string {
  return typeTag.startsWith("0x") ? typeTag.slice(2) : typeTag;
}
