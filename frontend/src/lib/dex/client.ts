/**
 * DEX client foundation — shared init for the Cetus Aggregator SDK.
 *
 * The SDK wraps the dapp-kit `SuiClient` so the Quay frontend has one RPC
 * pool, one retry policy, and one network config.
 *
 * Feature usage:
 *   - Feature 2 (pay-any, settle-any) → Cetus Aggregator routes across
 *     DeepBook v3 + Cetus CLMM + every other Sui DEX automatically.
 *   - Feature 3 (revenue) → `partner: QUAY_TREASURY_ADDRESS` on every
 *     routed swap; Cetus splits its swap fee back to that address.
 *
 * Feature 1 (DeepBook rate-lock via post-only limit orders) is intentionally
 * NOT here. The Cetus Aggregator's `minOut` slippage check already covers
 * the volatile-leg protection rate-lock was supposed to provide, without
 * the one-time BalanceManager bootstrap + two-tx UX. If we revisit, the
 * @mysten/deepbook-v3 SDK can be re-added; nothing else in the codebase
 * depends on it.
 */

import { AggregatorClient, Env as CetusEnv } from "@cetusprotocol/aggregator-sdk";
import type { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";

import { QUAY, SUI_NETWORK } from "@/lib/sui-config";

// ─── Network ────────────────────────────────────────────────────────────

export type DexNetwork = "testnet" | "mainnet";

// ─── Treasury / referral ────────────────────────────────────────────────

/**
 * Quay's revenue / fee-recipient address. Receives the yield-routing
 * performance fee on redeem (Phase 6) and would receive the Cetus partner
 * fee share IF Quay were registered as a Cetus partner.
 *
 * IMPORTANT: this is NOT a valid Cetus `partner` argument — the Cetus
 * Aggregator SDK expects a Cetus Partner OBJECT ID (created by the Cetus
 * team when an app applies for partner status). Passing a wallet address
 * makes the SDK throw "Invalid Sui address" when it tries to load the
 * partner object on chain. Until Quay is a registered Cetus partner,
 * leave the `partner` kwarg unset everywhere — the SDK falls back to
 * Cetus's default partner object and swaps work.
 *
 * V0 decision: same as the on-chain admin address (one fewer key to manage).
 */
export const QUAY_TREASURY_ADDRESS = QUAY.adminAddress;

// ─── Clients bundle ─────────────────────────────────────────────────────

export interface DexClients {
  suiClient: SuiClient;
  network: DexNetwork;
  /** Cetus Aggregator SDK. Used by Feature 2 (swap) and Feature 3 (referral). */
  cetusAggregator: AggregatorClient;
}

// ─── Factory ────────────────────────────────────────────────────────────

// Cache keyed by `${network}:${signer ?? ""}` so re-renders with the same
// connected wallet reuse the same AggregatorClient, but switching wallets
// or disconnecting produces a fresh client with the right signer.
const cache = new WeakMap<SuiClient, Map<string, DexClients>>();

/**
 * `signer` is the connected wallet's address. The Cetus aggregator SDK uses
 * it INTERNALLY at swap-build time as the recipient for any leftover input
 * coin balance (e.g. positive slippage) and as the tx sender hint. If
 * omitted, the SDK defaults it to `""` (empty string) and the BCS Address
 * validator throws "Invalid Sui address" when the swap PTB is built. So
 * any call site that constructs a swap MUST pass `signer` here.
 *
 * For read-only `findRouters` (quote-only) calls, `signer` can be undefined.
 */
export function getDexClients(
  suiClient: SuiClient,
  network: DexNetwork = SUI_NETWORK,
  signer?: string,
): DexClients {
  let perKey = cache.get(suiClient);
  if (!perKey) {
    perKey = new Map();
    cache.set(suiClient, perKey);
  }
  const key = `${network}:${signer ?? ""}`;
  const cached = perKey.get(key);
  if (cached) return cached;

  const cetusEnv = network === "mainnet" ? CetusEnv.Mainnet : CetusEnv.Testnet;
  const cetusAggregator = new AggregatorClient({
    client: suiClient,
    env: cetusEnv,
    // Without this the SDK uses "" and swap PTBs blow up on BCS address validation.
    signer,
    // `partner` intentionally unset — see QUAY_TREASURY_ADDRESS docstring.
    // Cetus falls back to its default partner object so swaps work.
  });

  const bundle: DexClients = {
    suiClient,
    network,
    cetusAggregator,
  };
  perKey.set(key, bundle);
  return bundle;
}
