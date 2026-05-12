import { Transaction } from "@mysten/sui/transactions";

import { SUIQR } from "@/lib/sui-config";

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
    target: `${SUIQR.packageId}::payments::pay`,
    typeArguments: [COIN_TYPES.SUI],
    arguments: [
      tx.object(SUIQR.registryId),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(uen))),
      coin,
      memoArg,
      tx.pure.u64(BigInt(sgdMinorUnits)),
      quoteArg,
      tx.object(SUIQR.clockId),
    ],
  });
  return tx;
}

/**
 * BCS-encode a compact quote-metadata blob for the on-chain PaymentReceipt.
 * Layout (versioned): magic "SQR1" + JSON bytes. JSON keeps it forward-
 * compatible — the Move side just stores `vector<u8>` and emits it.
 */
export function encodeQuoteMetadata(meta: Record<string, unknown>): Uint8Array {
  const magic = new TextEncoder().encode("SQR1");
  const body = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(magic.length + body.length);
  out.set(magic, 0);
  out.set(body, magic.length);
  return out;
}
