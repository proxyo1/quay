"use client";

import {
  SuiClientProvider,
  WalletProvider,
  createNetworkConfig,
} from "@mysten/dapp-kit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type PropsWithChildren, useState } from "react";

import { SUI_NETWORK } from "@/lib/sui-config";

import "@mysten/dapp-kit/dist/index.css";

/**
 * dapp-kit's `SuiClientProvider` is still typed to `SuiJsonRpcClient` even at
 * 1.1.13, so it cannot be handed the gRPC client the rest of the app uses.
 * Quay's own chain reads no longer come from here — they go through
 * `getSuiClient()` (gRPC) — and this provider exists only for dapp-kit's
 * wallet plumbing (`ConnectButton`, `useCurrentAccount`) on the history page.
 *
 * The URLs below deliberately do NOT use `getJsonRpcFullnodeUrl`: Sui retired
 * JSON-RPC on its public fullnodes, so that host answers every method with
 * `-32601`. These are third-party endpoints that still serve it. Override with
 * NEXT_PUBLIC_SUI_JSONRPC_URL if one of them rate-limits.
 */
const WALLET_JSONRPC_URL =
  process.env.NEXT_PUBLIC_SUI_JSONRPC_URL?.trim() || "https://sui-rpc.publicnode.com";

const { networkConfig } = createNetworkConfig({
  testnet: {
    network: "testnet",
    url: WALLET_JSONRPC_URL,
  },
  mainnet: {
    network: "mainnet",
    url: WALLET_JSONRPC_URL,
  },
});

export function SuiProviders({ children }: PropsWithChildren) {
  const [qc] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={qc}>
      <SuiClientProvider networks={networkConfig} defaultNetwork={SUI_NETWORK}>
        <WalletProvider autoConnect>{children}</WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
