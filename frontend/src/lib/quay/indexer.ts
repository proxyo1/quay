
import { eventsForTransaction } from "@/lib/quay/events";
import { TYPE_PACKAGE, USDSUI, getSharePrice } from "@/lib/quay/scallop";
import type { SuiClient } from "@/lib/sui-client";

/**
 * Receipt reconciliation: derives the underlying USDsui amount a merchant
 * actually received for a yield-routed payment.
 *
 * A normal `payments::pay<USDsui>` receipt records the USDsui amount
 * directly — `token_type = USDsui`, `amount = N USDsui units`. The
 * indexer just passes that through.
 *
 * A yield-routed receipt is `payments::pay<SCALLOP_USDSUI>` — its
 * `token_type` is the sCoin wrapper and `amount` is the SHARE amount.
 * To recover the underlying USDsui amount the merchant earned the
 * indexer needs Scallop's `MintEvent` from the SAME transaction (joined
 * on tx digest, per D9). The `deposit_amount` field on that event is
 * the canonical USDsui amount — no float math, no off-chain price-feed
 * race.
 *
 * When the MintEvent can't be found (shouldn't happen on a healthy tx
 * but the indexer must be robust): we multiply the share amount by the
 * CURRENT live share price as a "best effort" estimate. Callers can
 * pass `currentSharePrice` to avoid an extra RPC if they already have
 * one cached.
 */

export interface ReceiptInput {
  /** The tx digest carrying the PaymentReceipt — used as the join key. */
  txDigest: string;
  /** `PaymentReceipt.token_type.name` — full Sui type tag without 0x prefix. */
  tokenType: string;
  /** `PaymentReceipt.amount` — in `token_type` units. */
  amount: bigint;
}

export interface ReceiptReconciliation {
  /** Echoes the input — handy for callers that map over arrays of receipts. */
  txDigest: string;
  tokenType: string;
  receiptAmount: bigint;
  /** True when the payment was yield-routed (`token_type` is `SCALLOP_USDSUI`). */
  yieldRouted: boolean;
  /**
   * Underlying USDsui amount (6 decimals) the merchant actually received.
   * Equal to `receiptAmount` for non-yield-routed receipts.
   *
   * `null` only when reconciliation failed (no MintEvent + no fallback
   * share price supplied) — callers should fall back to displaying the
   * raw `receiptAmount` with the sCoin label.
   */
  underlyingAmount: bigint | null;
  /**
   * How `underlyingAmount` was derived:
   *   - `"direct"`     — receipt's token isn't yield-routed; amount IS
   *                      the underlying USDsui amount
   *   - `"mint_event"` — joined with same-tx MintEvent; exact
   *   - `"share_math"` — fallback: multiplied share × current share price
   *                      (lossy float math; only used when the MintEvent
   *                      isn't recoverable)
   *   - `"unresolved"` — yield-routed but no MintEvent + no fallback;
   *                      `underlyingAmount` is null
   */
  source: "direct" | "mint_event" | "share_math" | "unresolved";
}

/**
 * True when a Sui type tag points at Scallop's USDsui sCoin wrapper.
 * Tag may or may not have a leading `0x` — both forms accepted.
 */
export function isYieldRoutedTokenType(typeName: string): boolean {
  return typeName.includes("::scallop_usdsui::SCALLOP_USDSUI");
}

interface MintEventParsed {
  deposit_amount: string;
  deposit_asset: { name: string };
  mint_amount: string;
  mint_asset: { name: string };
}

/**
 * Look up the `MintEvent` emitted in the same tx as a yield-routed
 * receipt and return its parsed fields. Returns `null` when the tx has
 * no MintEvent or the RPC call fails.
 *
 * One roundtrip per call (the transaction is asked for its own events).
 * Callers processing batches of receipts should map+await with bounded
 * concurrency rather than calling this serially.
 *
 * Returns `null` for a digest the node has pruned — transaction history is
 * not retained indefinitely, so an old receipt simply cannot be reconciled
 * this way and the caller falls back to its other paths.
 */
export async function findMintEventForTx(
  client: SuiClient,
  txDigest: string,
): Promise<MintEventParsed | null> {
  const events = await eventsForTransaction(client, txDigest);
  // The event type is pinned to the lineage root regardless of which
  // upgraded package emitted it (Move keeps event identities stable
  // across upgrades).
  const target = `${TYPE_PACKAGE}::mint::MintEvent`;
  const found = events.find((e) => e.type === target);
  if (!found?.parsedJson) return null;
  const p = found.parsedJson as MintEventParsed;
  if (!p.deposit_amount || !p.mint_amount) return null;
  return p;
}

/**
 * Reconcile a single PaymentReceipt to its underlying USDsui amount.
 * See the file-level doc for the three reconciliation paths.
 */
export async function reconcileReceipt(
  client: SuiClient,
  receipt: ReceiptInput,
  options?: { currentSharePrice?: number },
): Promise<ReceiptReconciliation> {
  if (!isYieldRoutedTokenType(receipt.tokenType)) {
    return {
      txDigest: receipt.txDigest,
      tokenType: receipt.tokenType,
      receiptAmount: receipt.amount,
      yieldRouted: false,
      underlyingAmount: receipt.amount,
      source: "direct",
    };
  }

  const mint = await findMintEventForTx(client, receipt.txDigest);
  if (mint) {
    return {
      txDigest: receipt.txDigest,
      tokenType: receipt.tokenType,
      receiptAmount: receipt.amount,
      yieldRouted: true,
      underlyingAmount: BigInt(mint.deposit_amount),
      source: "mint_event",
    };
  }

  // Fallback: multiply share amount by share price. Try the
  // caller-provided value first to avoid an extra RPC under load.
  let sharePrice = options?.currentSharePrice;
  if (sharePrice === undefined) {
    try {
      sharePrice = await getSharePrice(client, USDSUI.coinType);
    } catch {
      sharePrice = undefined;
    }
  }
  if (sharePrice !== undefined && sharePrice > 0) {
    const underlying = BigInt(
      Math.floor(Number(receipt.amount) * sharePrice),
    );
    return {
      txDigest: receipt.txDigest,
      tokenType: receipt.tokenType,
      receiptAmount: receipt.amount,
      yieldRouted: true,
      underlyingAmount: underlying,
      source: "share_math",
    };
  }

  return {
    txDigest: receipt.txDigest,
    tokenType: receipt.tokenType,
    receiptAmount: receipt.amount,
    yieldRouted: true,
    underlyingAmount: null,
    source: "unresolved",
  };
}

/**
 * Reconcile a batch of receipts. For batches >1, fetches the current
 * Scallop share price ONCE up-front so per-receipt fallbacks don't each
 * fire their own RPC. Direct (non-yield) receipts skip the network.
 *
 * Concurrency: capped at 8 in-flight tx-event lookups (Sui RPC nodes are
 * cooperative but spraying 50 concurrent getEvents calls is rude).
 */
export async function reconcileReceipts(
  client: SuiClient,
  receipts: ReceiptInput[],
): Promise<ReceiptReconciliation[]> {
  // Cheap pre-cache: avoid N parallel share-price reads when most
  // receipts fall to the share-math fallback.
  let cachedSharePrice: number | undefined;
  if (receipts.some((r) => isYieldRoutedTokenType(r.tokenType))) {
    try {
      cachedSharePrice = await getSharePrice(client, USDSUI.coinType);
    } catch {
      cachedSharePrice = undefined;
    }
  }

  const CONCURRENCY = 8;
  const out: ReceiptReconciliation[] = new Array(receipts.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= receipts.length) return;
      out[i] = await reconcileReceipt(client, receipts[i]!, {
        currentSharePrice: cachedSharePrice,
      });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, receipts.length) }, worker),
  );
  return out;
}
