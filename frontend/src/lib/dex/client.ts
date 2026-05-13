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

import { QUAY } from "@/lib/sui-config";

// ─── Network ────────────────────────────────────────────────────────────

export type DexNetwork = "testnet" | "mainnet";

// ─── Treasury / referral ────────────────────────────────────────────────

/**
 * The address that receives the Cetus Aggregator `partner` fee share.
 * V0 decision: same as the on-chain admin address (one fewer key to manage).
 * V0.5 will split this when inventory-mode MM ships.
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

const cache = new WeakMap<SuiClient, Map<DexNetwork, DexClients>>();

export function getDexClients(suiClient: SuiClient, network: DexNetwork = "testnet"): DexClients {
  let perNetwork = cache.get(suiClient);
  if (!perNetwork) {
    perNetwork = new Map();
    cache.set(suiClient, perNetwork);
  }
  const cached = perNetwork.get(network);
  if (cached) return cached;

  const cetusEnv = network === "mainnet" ? CetusEnv.Mainnet : CetusEnv.Testnet;
  const cetusAggregator = new AggregatorClient({
    client: suiClient,
    env: cetusEnv,
    // `signer` is set per-tx by the wallet; leaving it on the constructor
    // unset is fine for read-only `findRouters` calls.
    partner: QUAY_TREASURY_ADDRESS,
  });

  const bundle: DexClients = {
    suiClient,
    network,
    cetusAggregator,
  };
  perNetwork.set(network, bundle);
  return bundle;
}
