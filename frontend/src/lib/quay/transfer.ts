import type { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

import { USDSUI } from "./scallop";

/**
 * Shared builder for a sponsored USDsui transfer (D4). Used by both
 * /api/cashout/initiate (destination = treasury) and /api/sponsor/withdraw
 * (destination = an arbitrary address). Keeping it in one place means the
 * coin-merge correctness fix (D2) lives once.
 *
 * A merchant's USDsui is fragmented across one coin object per received
 * payment, so the existing single-largest-coin pattern (buildPayAnyTokenPtb)
 * is insufficient here. We gather ALL the merchant's USDsui coins, merge
 * them into one, and split off the exact amount.
 *
 * Liquid USDsui only: a merchant earning yield holds SCALLOP_USDSUI, not
 * raw USDsui, so getCoins(USDSUI) returns ~0 for them and this throws
 * `InsufficientUsdsuiError` (the caller surfaces "turn earning off first").
 *
 * Gas: the sponsor pays (setGasOwner), so the merchant needs no SUI and
 * there is no SUI gas-coin interaction with the USDsui being moved. The
 * caller signs the returned tx as the sponsor; the merchant zkLogin-signs.
 */

export class InsufficientUsdsuiError extends Error {
  haveMinor: bigint;
  wantMinor: bigint;
  constructor(haveMinor: bigint, wantMinor: bigint) {
    super(
      `insufficient liquid USDsui: have ${haveMinor}, need ${wantMinor} (microunits)`,
    );
    this.name = "InsufficientUsdsuiError";
    this.haveMinor = haveMinor;
    this.wantMinor = wantMinor;
  }
}

export interface BuildSponsoredUsdsuiTransferInput {
  sui: SuiClient;
  /** Merchant address (tx sender + coin owner). */
  owner: string;
  /** Where the USDsui goes (treasury for cash-out, arbitrary addr for withdraw). */
  destination: string;
  /** Amount in USDsui microunits (6 decimals). */
  amountMinor: bigint;
  /** Sponsor address that owns/pays the gas coin. */
  sponsorAddress: string;
  /** Gas budget in MIST. Defaults to 20M (merge can touch many objects). */
  gasBudgetMist?: bigint;
}

/** Sum the merchant's liquid USDsui and return all coin object ids. */
async function collectUsdsuiCoins(
  sui: SuiClient,
  owner: string,
): Promise<{ totalMinor: bigint; coinObjectIds: string[] }> {
  let cursor: string | null | undefined = undefined;
  let totalMinor = 0n;
  const coinObjectIds: string[] = [];
  // Page through every USDsui coin object the merchant owns.
  for (;;) {
    const page = await sui.getCoins({
      owner,
      coinType: USDSUI.coinType,
      cursor: cursor ?? null,
    });
    for (const c of page.data) {
      coinObjectIds.push(c.coinObjectId);
      totalMinor += BigInt(c.balance);
    }
    if (!page.hasNextPage || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { totalMinor, coinObjectIds };
}

/**
 * Gasless "send all USDsui" via `0x2::coin::send_funds` (Sui protocol-level
 * gasless stablecoin transfers, mainnet v125). Emits one `send_funds` per
 * USDsui coin the owner holds — every input coin is consumed — to
 * `destination`, with gas zeroed. The protocol covers gas, so there's no
 * sponsor and the merchant needs no SUI. The caller zkLogin-signs the
 * returned tx and submits it with that single signature (no co-sign).
 *
 * All-or-nothing: `send_funds` takes a whole `Coin` by value and `split`
 * isn't in the gasless allowlist, so this withdraws the entire balance.
 * Partial amounts must use the sponsored path. Verified on mainnet via
 * scripts/gasless-withdraw-spike.ts (recipient receives a normal spendable
 * Coin, no redemption step).
 */
export async function buildGaslessUsdsuiSendAll(input: {
  sui: SuiClient;
  owner: string;
  destination: string;
}): Promise<{ tx: Transaction; totalMinor: bigint; coinCount: number }> {
  const { totalMinor, coinObjectIds } = await collectUsdsuiCoins(input.sui, input.owner);
  if (coinObjectIds.length === 0 || totalMinor === 0n) {
    throw new InsufficientUsdsuiError(0n, 1n);
  }
  const tx = new Transaction();
  for (const id of coinObjectIds) {
    tx.moveCall({
      target: "0x2::coin::send_funds",
      typeArguments: [USDSUI.coinType],
      arguments: [tx.object(id), tx.pure.address(input.destination)],
    });
  }
  tx.setSender(input.owner);
  // Gasless: no gas coin, zero budget/price — the protocol recognizes the
  // qualifying PTB (allowlisted coin ops on an allowlisted stablecoin) and
  // covers the cost.
  tx.setGasPayment([]);
  tx.setGasBudget(0n);
  tx.setGasPrice(0n);
  return { tx, totalMinor, coinCount: coinObjectIds.length };
}

export async function buildSponsoredUsdsuiTransfer(
  input: BuildSponsoredUsdsuiTransferInput,
): Promise<Transaction> {
  if (input.amountMinor <= 0n) throw new Error("amountMinor must be > 0");

  const { totalMinor, coinObjectIds } = await collectUsdsuiCoins(
    input.sui,
    input.owner,
  );
  if (totalMinor < input.amountMinor) {
    throw new InsufficientUsdsuiError(totalMinor, input.amountMinor);
  }

  const tx = new Transaction();
  tx.setSender(input.owner);
  tx.setGasOwner(input.sponsorAddress);
  tx.setGasBudget(input.gasBudgetMist ?? 20_000_000n);

  const primary = tx.object(coinObjectIds[0]);
  if (coinObjectIds.length > 1) {
    tx.mergeCoins(
      primary,
      coinObjectIds.slice(1).map((id) => tx.object(id)),
    );
  }
  const [out] = tx.splitCoins(primary, [tx.pure.u64(input.amountMinor)]);
  tx.transferObjects([out], tx.pure.address(input.destination));

  return tx;
}
