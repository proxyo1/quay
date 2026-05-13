/**
 * DEX client foundation — shared init for DeepBook + Cetus Aggregator SDKs.
 *
 * Both SDKs wrap the same dapp-kit `SuiClient` so the Quay frontend has one
 * RPC pool, one retry policy, and one network config.
 *
 * Feature usage:
 *   - Feature 1 (rate-lock) → DeepBook v3 (native orderbook semantics)
 *   - Feature 2 (pay-any, settle-any) → Cetus Aggregator (best-of routing
 *     across DeepBook + Cetus CLMM + other Sui DEXs)
 *   - Feature 3 (revenue) → Cetus Aggregator `partner` parameter set to
 *     `QUAY_TREASURY_ADDRESS` on every routed swap
 */

import { AggregatorClient, Env as CetusEnv } from "@cetusprotocol/aggregator-sdk";
import { DeepBookClient } from "@mysten/deepbook-v3";
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
  /**
   * DeepBook v3 SDK. Used by Feature 1 (limit orders). Lazy — only instantiated
   * when a caller asks for it because it pulls testnet pool config from chain.
   */
  getDeepBook: () => DeepBookClient;
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

  let deepbookInstance: DeepBookClient | null = null;
  const getDeepBook = (): DeepBookClient => {
    if (deepbookInstance) return deepbookInstance;
    deepbookInstance = new DeepBookClient({
      client: suiClient,
      network,
      address: QUAY_TREASURY_ADDRESS,
    });
    return deepbookInstance;
  };

  const bundle: DexClients = {
    suiClient,
    network,
    cetusAggregator,
    getDeepBook,
  };
  perNetwork.set(network, bundle);
  return bundle;
}
