/**
 * DeepBook v3 limit-order helpers — Feature 1 building blocks.
 *
 * ──── Why this module exists, and why the UI doesn't use it yet ────
 *
 * The plan's Feature 1 ("Rate-Lock via DeepBook Limit Orders") lets a payer
 * tap "Lock Rate" and freeze the displayed SGD→SUI quote for 3 minutes via
 * a post-only limit order on DeepBook. The order sits in the user's
 * BalanceManager; on Pay the order is cancelled and the freed coin is handed
 * to `payments::pay<T>`. If the user abandons, the order auto-expires and
 * funds stay in their BalanceManager.
 *
 * The wrapping below is real (BalanceManager bootstrap, place limit, try
 * cancel + withdraw). It is NOT wired into PayPanel because three frictions
 * make Feature 1 a V0.5 item, not V0:
 *
 *   1. **One-time BalanceManager + deposit step.** A new user has to sign a
 *      separate tx to create their BM and deposit funds before they can
 *      place any limit order. That's a 2-signature flow just to lock a
 *      rate on a sub-$10 hawker payment.
 *
 *   2. **Token mismatch on testnet.** DeepBook's testnet SUI/USDC pool uses
 *      `DBUSDC`, a different Move type than the `USDC_TESTNET` the merchant
 *      onboards with. A cancel-and-pay PTB that withdraws DBUSDC can't
 *      directly satisfy `payments::pay<USDC_TESTNET>`. On mainnet the types
 *      align; on testnet they don't.
 *
 *   3. **Cetus Aggregator already provides slippage protection** for the
 *      actually-volatile leg (the swap itself), via `minOut`. The "lock"
 *      pattern matters most when there's no atomic swap step — which isn't
 *      Quay's flow.
 *
 * Mainnet path: bring this online after CCTP USDC lands (resolves friction
 * #2) and after the BalanceManager bootstrap UX is folded into onboarding
 * (resolves friction #1).
 */

import type { DeepBookClient } from "@mysten/deepbook-v3";
import { Transaction } from "@mysten/sui/transactions";

/** Display key for a DeepBook pool — see `testnetPools` in the SDK. */
export type PoolKey = "SUI_DBUSDC" | "DEEP_SUI" | "WAL_SUI" | "DEEP_DBUSDC" | "DBTC_DBUSDC";

/** Display key for a DeepBook coin — see `testnetCoins` / `mainnetCoins`. */
export type CoinKey = "SUI" | "DEEP" | "DBUSDC" | "DBUSDT" | "WAL" | "DBTC" | "USDC";

export interface PlaceLockOrderInputs {
  poolKey: PoolKey;
  balanceManagerKey: string;
  /** Unique client-side order ID for this lock. Used to find + cancel later. */
  clientOrderId: string;
  /**
   * Limit price in DeepBook's price units (8 decimals against quote/base).
   * Caller computes from Pyth quote.
   */
  price: bigint;
  /** Quantity in base-token smallest units. */
  quantity: bigint;
  /** True = bid (buying base, spending quote). False = ask (selling base). */
  isBid: boolean;
  /** Unix ms when the limit auto-expires. */
  expirationMs: number;
}

/**
 * Build a PTB that places a post-only limit order. The caller is responsible
 * for ensuring the BalanceManager (`balanceManagerKey`) exists and has been
 * funded with the side of the trade the limit will spend.
 *
 * Post-only ensures the order joins the book as a maker — it cannot cross
 * an existing taker and accidentally execute at signing time.
 */
export function buildPlaceLimitTx(
  deepbook: DeepBookClient,
  input: PlaceLockOrderInputs,
): Transaction {
  const tx = new Transaction();
  deepbook.deepBook.placeLimitOrder({
    poolKey: input.poolKey,
    balanceManagerKey: input.balanceManagerKey,
    clientOrderId: input.clientOrderId,
    price: input.price,
    quantity: input.quantity,
    isBid: input.isBid,
    expiration: input.expirationMs,
    // OrderType POST_ONLY = 3 in the SDK's enum. The constant isn't exported
    // by name in the public types but matches the on-chain Move enum.
    orderType: 3,
    payWithDeep: false,
  })(tx);
  return tx;
}

/**
 * Build a PTB that creates and shares a new BalanceManager owned by the
 * caller. Returns the tx so the caller can append a deposit in the same
 * transaction. Most users only call this once per wallet.
 */
export function buildCreateBalanceManagerTx(deepbook: DeepBookClient): Transaction {
  const tx = new Transaction();
  deepbook.balanceManager.createAndShareBalanceManager()(tx);
  return tx;
}

/**
 * Look up the user's existing BalanceManager IDs. Returns the first one or
 * `null` when the user has none — the caller should bootstrap via
 * `buildCreateBalanceManagerTx` in that case.
 */
export async function findUserBalanceManager(
  deepbook: DeepBookClient,
  owner: string,
): Promise<string | null> {
  const ids = await deepbook.getBalanceManagerIds(owner);
  return ids[0] ?? null;
}

/**
 * Build a "cancel-and-pay" PTB:
 *   1. `tryCancelOrder` the lock — no-op if it already filled or expired
 *   2. Withdraw the freed coin from the BalanceManager into the wallet
 *   3. Caller appends `payments::pay<T>` with the withdrawn coin
 *
 * Returns the tx with the cancel + withdraw already wired; the caller must
 * append the final `payments::pay<T>` move call before signing.
 *
 * NOT exported yet because the testnet DBUSDC ≠ USDC mismatch blocks the
 * "withdrawn coin → payments::pay" hand-off on the demo network. Once on
 * mainnet (or once Quay merchants can opt-in to receiving DBUSDC), this
 * unlocks the full Feature 1 flow.
 */
export function buildCancelAndWithdrawTx(
  deepbook: DeepBookClient,
  poolKey: PoolKey,
  balanceManagerKey: string,
  orderId: string,
  withdrawCoinKey: CoinKey,
  withdrawAmount: number,
  recipient: string,
): Transaction {
  const tx = new Transaction();
  // The SDK exposes the strict `cancelOrder` (aborts on already-filled /
  // expired order ids). The full Feature 1 flow needs a try-cancel pattern
  // for graceful expiry handling; callers should pre-check liveness with
  // `getOrder` and only emit the cancel call when the order is still open.
  // A direct on-chain `try_cancel` exists in the underlying Move module but
  // isn't surfaced in this SDK release — track ts-sdks upstream for it.
  deepbook.deepBook.cancelOrder(poolKey, balanceManagerKey, orderId)(tx);
  deepbook.balanceManager.withdrawFromManager(
    balanceManagerKey,
    withdrawCoinKey,
    withdrawAmount,
    recipient,
  )(tx);
  return tx;
}
