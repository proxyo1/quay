import type { AggregatorClient } from "@cetusprotocol/aggregator-sdk";
import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";

import {
  appendSwapToPtb,
  assertOutputWithinSlippage,
  minAcceptableOut,
  quoteRoute,
} from "@/lib/dex/aggregator";
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
   * The full Coin<T> object id the payer is paying from. The PTB will split
   * the required input off this coin. For SUI this is normally `tx.gas`;
   * for non-SUI coins the caller resolves the user's largest balance.
   */
  payerCoin: TransactionObjectArgument;
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

  let payCoin: TransactionObjectArgument;
  let routedVia: "direct" | "aggregator";
  let expectedInputAmount: bigint;
  let venues: string[];

  if (input.payerCoinType === input.merchantReceiveType) {
    // Same token — split the exact amount off the payer's coin, no aggregator.
    [payCoin] = tx.splitCoins(input.payerCoin, [tx.pure.u64(input.outputAmount)]);
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
      [payCoin] = tx.splitCoins(input.payerCoin, [tx.pure.u64(input.outputAmount)]);
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
      const [inputCoinForSwap] = tx.splitCoins(input.payerCoin, [
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

  const memoArg = input.memo
    ? tx.pure.option("vector<u8>", Array.from(new TextEncoder().encode(input.memo)))
    : tx.pure.option("vector<u8>", null);

  const quoteArg = input.quoteMetadata
    ? tx.pure.option("vector<u8>", Array.from(input.quoteMetadata))
    : tx.pure.option("vector<u8>", null);

  tx.moveCall({
    target: `${QUAY.packageId}::payments::pay`,
    typeArguments: [input.merchantReceiveType],
    arguments: [
      tx.object(QUAY.registryId),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(input.uen))),
      payCoin,
      memoArg,
      tx.pure.u64(BigInt(input.sgdMinorUnits)),
      quoteArg,
      tx.object(QUAY.clockId),
    ],
  });

  return { tx, routedVia, expectedInputAmount, minOutAcceptable, venues };
}
