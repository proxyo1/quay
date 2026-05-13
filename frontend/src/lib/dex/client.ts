/**
 * DEX client foundation — shared init for DeepBook + Cetus Aggregator SDKs.
 *
 * Why this module exists:
 *   - Feature 1 (rate-lock) needs DeepBook v3 native orderbook semantics —
 *     no other Sui venue offers them.
 *   - Feature 2 (pay-any-token, settle-any-token) routes via Cetus Aggregator
 *     which falls through DeepBook + Cetus CLMM + other DEXs automatically.
 *   - Feature 3 (revenue) passes Quay's treasury address as the aggregator's
 *     `referral` parameter.
 *
 * The wrapper ensures both SDKs share the same dapp-kit `SuiClient` instance
 * (one RPC pool, one retry policy, one network config). The eng review's
 * "useDeepbookSession" recommendation lives here as `getDexClients` for now;
 * promote to a React Context hook once a component actually depends on it.
 *
 * STATUS: scaffold only. The SDK imports are commented out below so the
 * frontend continues to compile before the SDKs are installed. To activate:
 *
 *   pnpm add @mysten/deepbook-v3 @cetusprotocol/aggregator-sdk
 *
 * (Verify exact package names + pinned versions on Day 13 — both SDKs are
 * still moving, and Cetus's aggregator ships under a couple of names.)
 *
 * Once installed, uncomment the import lines and the `// TODO` blocks below.
 */

import type { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";

// ─── Network ────────────────────────────────────────────────────────────

/** Sui network the DEX clients target. Mirrors `SUI_NETWORK` in sui-config. */
export type DexNetwork = "testnet" | "mainnet";

// ─── Treasury / referral ────────────────────────────────────────────────

import { QUAY } from "@/lib/sui-config";

/**
 * The address that receives the Cetus Aggregator `referral` fee share.
 * V0 decision: same as the on-chain admin address (one fewer key to manage).
 * V0.5 will split this when inventory-mode MM ships.
 */
export const QUAY_TREASURY_ADDRESS = QUAY.adminAddress;

// ─── Clients bundle ─────────────────────────────────────────────────────

/**
 * The bundle returned by `getDexClients`. Day 13: replace the `null` SDK
 * fields with their real instances. Consumers should NOT instantiate the
 * SDKs themselves — go through this bundle so the shared `SuiClient` is
 * the single RPC entry point.
 */
export interface DexClients {
  suiClient: SuiClient;
  network: DexNetwork;
  /**
   * DeepBook v3 SDK instance. Wraps `suiClient`. Used only by Feature 1
   * (limit orders). Null until the SDK is installed and wired below.
   */
  deepbookSdk: DeepBookSdkPlaceholder | null;
  /**
   * Cetus Aggregator SDK instance. Wraps `suiClient`. Used by Feature 2
   * (swap-and-pay) and Feature 3 (referral param). Null until installed.
   */
  cetusAggregator: CetusAggregatorPlaceholder | null;
}

// Until the SDKs are installed, expose typed placeholders so downstream
// code can reference `DexClients` without importing missing packages.
export type DeepBookSdkPlaceholder = { readonly __scaffold: "deepbook-v3" };
export type CetusAggregatorPlaceholder = { readonly __scaffold: "cetus-aggregator" };

// ─── Factory ────────────────────────────────────────────────────────────

/**
 * Build the DEX clients bundle. Cached by `(suiClient identity, network)`:
 * if the caller hands in the same `SuiClient` reference twice, the same
 * bundle is returned — keeps SDK init out of every render path.
 */
const cache = new WeakMap<SuiClient, Map<DexNetwork, DexClients>>();

export function getDexClients(suiClient: SuiClient, network: DexNetwork = "testnet"): DexClients {
  let perNetwork = cache.get(suiClient);
  if (!perNetwork) {
    perNetwork = new Map();
    cache.set(suiClient, perNetwork);
  }

  const cached = perNetwork.get(network);
  if (cached) return cached;

  // TODO(day-13): instantiate the real SDKs.
  //
  //   import { DeepBookClient } from "@mysten/deepbook-v3";
  //   import { AggregatorClient } from "@cetusprotocol/aggregator-sdk";
  //
  //   const deepbookSdk = new DeepBookClient({ client: suiClient, env: network });
  //   const cetusAggregator = new AggregatorClient({ client: suiClient, env: network });
  //
  // Cache + return.
  const bundle: DexClients = {
    suiClient,
    network,
    deepbookSdk: null,
    cetusAggregator: null,
  };

  perNetwork.set(network, bundle);
  return bundle;
}

// ─── Errors ─────────────────────────────────────────────────────────────

/**
 * Thrown by callers that depend on a real SDK while the scaffold is still
 * stubbed. Surfaces a clear "wire up the SDK first" message instead of a
 * generic `null` dereference deeper in the call chain.
 */
export class DexSdkNotWiredError extends Error {
  constructor(which: "deepbook" | "cetusAggregator") {
    super(
      `${which} SDK is not wired in this build. ` +
        `Install the package and replace the placeholder in frontend/src/lib/dex/client.ts.`,
    );
    this.name = "DexSdkNotWiredError";
  }
}

export function requireDeepBook(clients: DexClients): DeepBookSdkPlaceholder {
  if (!clients.deepbookSdk) throw new DexSdkNotWiredError("deepbook");
  return clients.deepbookSdk;
}

export function requireCetusAggregator(clients: DexClients): CetusAggregatorPlaceholder {
  if (!clients.cetusAggregator) throw new DexSdkNotWiredError("cetusAggregator");
  return clients.cetusAggregator;
}
