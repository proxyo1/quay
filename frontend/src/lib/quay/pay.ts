import type { AggregatorClient } from "@cetusprotocol/aggregator-sdk";
import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";

import {
  appendSwapToPtb,
  assertOutputWithinSlippage,
  minAcceptableOut,
  quoteRoute,
} from "@/lib/dex/aggregator";
import {
  USDSUI,
  buildMintWithSCoinWrap,
  type ScallopAsset,
} from "@/lib/quay/scallop";
import { QUAY } from "@/lib/sui-config";

export const COIN_TYPES = {
  SUI: "0x2::sui::SUI",
  /**
   * Testnet "USDC" — Sui ecosystem testnet stablecoin issued by Mysten.
   * This is NOT Circle USDC; for mainnet we'd substitute the real Circle
   * package ID. Kept here so PayPanel can offer a USDC source on testnet
   * once liquidity is wired (Day 5.5+).
   */
  USDC_TESTNET: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
  /**
   * USDsui — Bridge/Stripe's Sui-native stablecoin. Mainnet-only; the
   * mainnet receive token. Same address constant also lives in scallop.ts
   * (`USDSUI.coinType`) — keep both in sync if Bridge ever republishes.
   */
  USDSUI:
    "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI",
} as const;

export type CoinTypeKey = keyof typeof COIN_TYPES;

/**
 * Maximum bytes for the on-chain `quote_metadata` field. Eng-subagent CRITICAL
 * fix: with DEX routing details appended to the existing Pyth envelope, a
 * naive `JSON.stringify` can push the field past 1 KB. Sui charges event
 * emission by size and large events hurt indexer performance, so cap hard.
 *
 * If a future schema legitimately needs more, bump this AND audit indexer
 * costs at the same time — never silently raise the cap.
 */
export const QUOTE_METADATA_MAX_BYTES = 2048;

export class QuoteMetadataTooLargeError extends Error {
  readonly actualBytes: number;
  constructor(actualBytes: number) {
    super(
      `quote_metadata is ${actualBytes} bytes; max is ${QUOTE_METADATA_MAX_BYTES}. ` +
        `Trim the metadata or bump QUOTE_METADATA_MAX_BYTES (and audit indexer cost first).`,
    );
    this.name = "QuoteMetadataTooLargeError";
    this.actualBytes = actualBytes;
  }
}

export interface BuildPaySuiInputs {
  uen: string;
  /** SUI amount in MIST. */
  mistAmount: bigint;
  /** Human-readable SGD minor units (e.g., 150 = $1.50). Emitted on PaymentReceipt. */
  sgdMinorUnits: number;
  /** Optional UTF-8 memo (encoded as vector<u8>). */
  memo?: string;
  /**
   * Optional BCS-serialized quote metadata. For Day 5 we emit the off-chain
   * quote inputs we used to compute the SGD price so auditors can replay
   * the rate the user accepted.
   */
  quoteMetadata?: Uint8Array;
}

/**
 * Build a `payments::pay<SUI>` PTB that splits `mistAmount` MIST off the
 * caller's gas coin and forwards it to the registered merchant.
 *
 * The split-from-gas pattern keeps the demo simple: no separate SUI coin
 * selection, no coin-merging dance, and Sui's gas accounting handles the
 * rest. On Day 5.5+ we'll add a Cetus swap step in front of the pay call
 * to support paying with non-SUI source tokens.
 */
export function buildPaySuiTx(input: BuildPaySuiInputs): Transaction {
  const { uen, mistAmount, sgdMinorUnits, memo, quoteMetadata } = input;
  if (mistAmount <= 0n) throw new Error("mistAmount must be > 0");

  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(mistAmount)]);

  const memoArg = memo
    ? tx.pure.option("vector<u8>", Array.from(new TextEncoder().encode(memo)))
    : tx.pure.option("vector<u8>", null);

  const quoteArg = quoteMetadata
    ? tx.pure.option("vector<u8>", Array.from(quoteMetadata))
    : tx.pure.option("vector<u8>", null);

  tx.moveCall({
    target: `${QUAY.packageId}::payments::pay`,
    typeArguments: [COIN_TYPES.SUI],
    arguments: [
      tx.object(QUAY.registryId),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(uen))),
      coin,
      memoArg,
      tx.pure.u64(BigInt(sgdMinorUnits)),
      quoteArg,
      tx.object(QUAY.clockId),
    ],
  });
  return tx;
}

/**
 * BCS-encode a compact quote-metadata blob for the on-chain PaymentReceipt.
 * Layout (versioned): magic "SQR1" + JSON bytes. JSON keeps it forward-
 * compatible — the Move side just stores `vector<u8>` and emits it.
 *
 * Throws `QuoteMetadataTooLargeError` if the encoded blob exceeds
 * `QUOTE_METADATA_MAX_BYTES`. Callers MUST handle this — silently truncating
 * would corrupt the audit trail.
 */
export function encodeQuoteMetadata(meta: Record<string, unknown>): Uint8Array {
  const magic = new TextEncoder().encode("SQR1");
  const body = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(magic.length + body.length);
  out.set(magic, 0);
  out.set(body, magic.length);
  if (out.length > QUOTE_METADATA_MAX_BYTES) {
    throw new QuoteMetadataTooLargeError(out.length);
  }
  return out;
}

// ─── Feature 2: pay-any-token, settle-any-token ─────────────────────────

/**
 * Where the input coin comes from inside the PTB.
 *
 *   `"gas"`               → split off `tx.gas` (used for SUI inputs; dapp-kit
 *                           resolves the wallet's gas coin at sign time).
 *   `{ objectId: "..." }` → reference a specific `Coin<T>` object the user
 *                           already holds (used for non-SUI inputs; the
 *                           caller picks the user's largest balance via
 *                           `suiClient.getCoins({ owner, coinType })`).
 *
 * Keeping this as a discriminator means `buildPayAnyTokenPtb` is the only
 * thing that needs to know about Sui's gas-coin special case — callers just
 * tell us "use gas" or "use this object."
 */
export type PayerCoinSource = "gas" | { readonly objectId: string };

/**
 * Caller-supplied yield-routing instruction (Phase 6).
 *
 * `buildPayAnyTokenPtb` does not perform its own health check or profile
 * read — it expects the caller (typically `/scan`) to have already verified:
 *   1. Merchant's profile has `yield_routing.enabled === true`
 *   2. `merchantReceiveType` is exactly `USDSUI.coinType`
 *   3. `preflightScallopHealthy()` returned true within the last 30s
 *   4. The Scallop call package was resolved (override via `callPackage`
 *      if the cron observed an upgrade since last build)
 *
 * If all four hold, set `enabled: true` and the PTB will insert
 * `mint_s_coin` after the aggregator/split step, settling to the merchant
 * as `Coin<SCALLOP_USDSUI>` (the wrapped, wallet-friendly sCoin).
 */
export interface YieldRoutingHint {
  enabled: boolean;
  /** Override Scallop's current callable package id (rotates per upgrade). */
  callPackage?: string;
  /** Override the sCoin converter package id (rotates per upgrade). */
  sCoinConverterPackage?: string;
  /** Asset config; defaults to `USDSUI` from scallop.ts. */
  asset?: ScallopAsset;
}

export interface BuildPayAnyTokenInputs {
  /** Aggregator client from `getDexClients(suiClient).cetusAggregator`. */
  cetus: AggregatorClient;
  /** Merchant identifier — the UEN on the SGQR. */
  uen: string;
  /** Sui Move type of the token the payer holds and will spend. */
  payerCoinType: string;
  /** Sui Move type of the token the merchant wants to receive. */
  merchantReceiveType: string;
  /**
   * How to find the input coin inside the PTB. See `PayerCoinSource` above.
   */
  payerCoinSource: PayerCoinSource;
  /**
   * The exact amount of `merchantReceiveType` the merchant must receive
   * (smallest units, e.g. MIST for SUI, 6-decimal microunits for USDC).
   */
  outputAmount: bigint;
  /** Human-readable SGD minor units (e.g. 150 = $1.50). Emitted on PaymentReceipt. */
  sgdMinorUnits: number;
  /** Optional UTF-8 memo. */
  memo?: string;
  /** Optional quote metadata. Subject to QUOTE_METADATA_MAX_BYTES. */
  quoteMetadata?: Uint8Array;
  /** Slippage tolerance in basis points (default 100 = 1%). */
  slippageBps?: number;
  /**
   * Optional yield-routing instruction. When `enabled: true` and the
   * `merchantReceiveType` matches the asset's underlying coin type, the
   * PTB mints into Scallop and the merchant receives the sCoin wrapper.
   * See `YieldRoutingHint` for the full caller contract.
   */
  yieldRouting?: YieldRoutingHint;
}

export interface BuildPayAnyTokenResult {
  tx: Transaction;
  /** Whether the aggregator was used or the payer/merchant tokens matched. */
  routedVia: "direct" | "aggregator";
  /** Expected input amount the payer commits. For "direct" equals outputAmount. */
  expectedInputAmount: bigint;
  /** Minimum the merchant will accept after slippage (smallest units of merchantReceiveType). */
  minOutAcceptable: bigint;
  /** Venues the aggregator traversed (UI breadcrumb). Empty for "direct". */
  venues: string[];
  /**
   * True when the PTB includes the Scallop mint + sCoin wrap step.
   * Payment lands on the merchant as `Coin<SCALLOP_USDSUI>` instead of
   * `Coin<USDsui>`. The PaymentReceipt's `token_type` will reflect the
   * sCoin type; the indexer joins with Scallop's `MintEvent` on tx digest
   * to recover the underlying USDsui amount.
   */
  yieldRouted: boolean;
}

/**
 * Build a PTB that pays the merchant in their preferred token while the
 * payer spends a different token. When payer and merchant tokens match,
 * the aggregator is skipped entirely (no routing fee).
 *
 * The returned PTB is ready to sign; gas object selection is handled by
 * the dapp-kit signer at sign time.
 */
export async function buildPayAnyTokenPtb(
  input: BuildPayAnyTokenInputs,
): Promise<BuildPayAnyTokenResult> {
  if (input.outputAmount <= 0n) throw new Error("outputAmount must be > 0");
  if (input.sgdMinorUnits <= 0) throw new Error("sgdMinorUnits must be > 0");

  const slippageBps = input.slippageBps ?? 100;
  const minOutAcceptable = minAcceptableOut(input.outputAmount, slippageBps);

  const tx = new Transaction();

  // Resolve the payer-side coin reference inside this PTB. `tx.gas` is the
  // gas-coin sentinel the dapp-kit signer fills in at sign time; for non-SUI
  // tokens we wrap the object ID the caller picked from the user's wallet.
  const payerCoinRef =
    input.payerCoinSource === "gas"
      ? tx.gas
      : tx.object(input.payerCoinSource.objectId);

  // `payCoin` can come from either `splitCoins` (a nested-result coin) or
  // from the aggregator's `routerSwap` (the output coin argument). Both are
  // valid `TransactionObjectArgument`s for the `payments::pay<T>` call.
  let payCoin: TransactionObjectArgument;
  let routedVia: "direct" | "aggregator";
  let expectedInputAmount: bigint;
  let venues: string[];

  if (input.payerCoinType === input.merchantReceiveType) {
    // Same token — split the exact amount off the payer's coin, no aggregator.
    [payCoin] = tx.splitCoins(payerCoinRef, [tx.pure.u64(input.outputAmount)]);
    routedVia = "direct";
    expectedInputAmount = input.outputAmount;
    venues = [];
  } else {
    const quote = await quoteRoute(input.cetus, {
      inputCoinType: input.payerCoinType,
      outputCoinType: input.merchantReceiveType,
      amountOut: input.outputAmount,
    });
    if (quote.kind === "direct") {
      // Defensive — should not happen because we checked equality above.
      [payCoin] = tx.splitCoins(payerCoinRef, [tx.pure.u64(input.outputAmount)]);
      routedVia = "direct";
      expectedInputAmount = input.outputAmount;
      venues = [];
    } else {
      // Verify the route can plausibly deliver at our slippage tolerance.
      // Aggregator quoted `amountIn` to deliver `outputAmount`; if its
      // expected output (with slippage applied) is under `minOutAcceptable`,
      // fail loud BEFORE the user signs.
      assertOutputWithinSlippage(input.outputAmount, minOutAcceptable);

      // Split the exact required input off the payer's coin (BN.toString-safe).
      const [inputCoinForSwap] = tx.splitCoins(payerCoinRef, [
        tx.pure.u64(quote.amountIn),
      ]);
      payCoin = await appendSwapToPtb(input.cetus, {
        tx,
        route: quote.route,
        inputCoin: inputCoinForSwap,
        slippageBps,
      });
      routedVia = "aggregator";
      expectedInputAmount = quote.amountIn;
      venues = quote.venues;
    }
  }

  // Yield-routing branch. The caller already vetted the four pre-conditions
  // (see YieldRoutingHint), so we just check the type match here and apply.
  // The merchant ends up holding `Coin<SCALLOP_USDSUI>` instead of
  // `Coin<USDsui>`, but the `payments::pay` Move call is type-generic so
  // both shapes go through the same code path on-chain.
  const yieldAsset = input.yieldRouting?.asset ?? USDSUI;
  const yieldRouted =
    input.yieldRouting?.enabled === true &&
    input.merchantReceiveType === yieldAsset.coinType;

  let finalPayCoin = payCoin;
  let finalReceiveType = input.merchantReceiveType;
  if (yieldRouted) {
    // `payCoin` is `Coin<USDsui>` at this point. Mint into Scallop, wrap
    // into the sCoin treasury — same shape every recent mainnet supply tx
    // uses (verified Phase 1).
    finalPayCoin = buildMintWithSCoinWrap(tx, {
      coin: payCoin,
      asset: yieldAsset,
      callPackage: input.yieldRouting?.callPackage,
      sCoinConverterPackage: input.yieldRouting?.sCoinConverterPackage,
    });
    finalReceiveType = yieldAsset.sCoinType;
  }

  const memoArg = input.memo
    ? tx.pure.option("vector<u8>", Array.from(new TextEncoder().encode(input.memo)))
    : tx.pure.option("vector<u8>", null);

  const quoteArg = input.quoteMetadata
    ? tx.pure.option("vector<u8>", Array.from(input.quoteMetadata))
    : tx.pure.option("vector<u8>", null);

  tx.moveCall({
    target: `${QUAY.packageId}::payments::pay`,
    typeArguments: [finalReceiveType],
    arguments: [
      tx.object(QUAY.registryId),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(input.uen))),
      finalPayCoin,
      memoArg,
      tx.pure.u64(BigInt(input.sgdMinorUnits)),
      quoteArg,
      tx.object(QUAY.clockId),
    ],
  });

  return {
    tx,
    routedVia,
    expectedInputAmount,
    minOutAcceptable,
    venues,
    yieldRouted,
  };
}
