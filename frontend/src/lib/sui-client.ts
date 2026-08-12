/**
 * The single place Quay constructs a Sui client.
 *
 * Sui retired JSON-RPC on the public fullnodes (mainnet *and* testnet) — every
 * method now answers `-32601 … deprecated. Please migrate to gRPC or GraphQL`.
 * Quay previously built a client per module with
 * `new SuiClient({ url: getJsonRpcFullnodeUrl(SUI_NETWORK) })`, hardcoded, in
 * ~20 places; when the endpoint died there was no single knob to turn. This
 * module is that knob.
 *
 * Transport is gRPC-web, which works from both the server and the browser —
 * `fullnode.mainnet.sui.io` answers preflight with `access-control-allow-origin: *`.
 *
 * Historical event lookups live in `lib/quay/events.ts` and go to GraphQL
 * instead — not because gRPC lacks an event query (it has one:
 * `listEvents`/`LedgerService.ListEvents`) but because a fullnode only serves
 * its own retention window, which on mainnet is currently short enough to hide
 * most of Quay's payment history. See the header of `events.ts` for the
 * measurement; the failure mode is a silently shorter list, not an error.
 */

import { SuiGrpcClient } from "@mysten/sui/grpc";

import { SUI_NETWORK } from "@/lib/sui-config";

/**
 * Project-wide alias. Modules take `client: SuiClient` so call sites read the
 * same as they did under JSON-RPC — only the transport underneath changed.
 */
export type SuiClient = SuiGrpcClient;

/** Mysten's public fullnodes speak gRPC-web on the same host as the old RPC. */
const DEFAULT_GRPC_URL: Record<"mainnet" | "testnet", string> = {
  mainnet: "https://fullnode.mainnet.sui.io:443",
  testnet: "https://fullnode.testnet.sui.io:443",
};

/**
 * Endpoint override, so swapping providers is an env change and never a code
 * change again. `NEXT_PUBLIC_` because client components need it inlined into
 * the browser bundle at build time.
 */
export const SUI_GRPC_URL =
  process.env.NEXT_PUBLIC_SUI_GRPC_URL?.trim() || DEFAULT_GRPC_URL[SUI_NETWORK];

/**
 * One client per URL. The SDK client is stateless with respect to callers and
 * holds its own connection pool, so sharing it is both safe and preferable —
 * `getDexClients` keys its cache on the client identity, and a fresh client per
 * call would defeat that cache.
 */
const clients = new Map<string, SuiGrpcClient>();

export function getSuiClient(url: string = SUI_GRPC_URL): SuiGrpcClient {
  const existing = clients.get(url);
  if (existing) return existing;
  const client = new SuiGrpcClient({
    network: SUI_NETWORK,
    // `baseUrl`, not `url` — the grpc-web transport reads baseUrl and fails
    // with a bare "base.endsWith is not a function" if it is missing.
    baseUrl: url,
  });
  clients.set(url, client);
  return client;
}
