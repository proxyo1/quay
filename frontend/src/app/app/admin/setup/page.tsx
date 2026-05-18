"use client";

import {
  ConnectButton,
  useCurrentAccount,
  useSignPersonalMessage,
} from "@mysten/dapp-kit";
import { useState } from "react";

import {
  bytesToHex,
  deriveAdminKeypairFromSignature,
  extractEd25519SigBytes,
} from "@/lib/kyb/crypto";

// Bytes the wallet signs. Bumping this string invalidates every existing
// wrapped DEK; do not change without coordinating env rotation.
const DERIVE_MESSAGE = "QUAY_KYB_DECRYPT_KEY_V1";

type State =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "deriving" }
  | { kind: "ready"; pubkeyHex: string; walletAddress: string }
  | { kind: "error"; message: string };

export default function AdminSetupPage() {
  const account = useCurrentAccount();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const [state, setState] = useState<State>({ kind: "idle" });

  async function handleDerive() {
    if (!account) return;
    setState({ kind: "signing" });
    try {
      const messageBytes = new TextEncoder().encode(DERIVE_MESSAGE);
      const { signature } = await signPersonalMessage({ message: messageBytes });
      setState({ kind: "deriving" });
      const sigBytes = extractEd25519SigBytes(signature);
      const { x25519PubKey } = await deriveAdminKeypairFromSignature(sigBytes);
      setState({
        kind: "ready",
        pubkeyHex: bytesToHex(x25519PubKey),
        walletAddress: account.address,
      });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-6 py-12 text-[var(--foreground)]">
      <header className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-[0.18em] text-[var(--muted-soft)]">
          KYB admin · one-time setup
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Derive admin decryption key
        </h1>
        <p className="text-sm text-[var(--muted)] leading-relaxed">
          Sign a fixed message with your admin Sui wallet. The signature is
          run through HKDF to produce an X25519 keypair. The public key
          goes in <code className="font-mono text-[var(--accent)]">ADMIN_KYB_PUBKEY</code>;
          the private key is re-derived from the same signature each session,
          so nothing needs to be stored.
        </p>
        <p className="text-xs text-[var(--muted-soft)] leading-relaxed">
          Wallet must be mnemonic-backed ed25519 (Sui Wallet extension,
          Suiet, etc.). zkLogin won&apos;t work — its signatures are not
          deterministic.
        </p>
      </header>

      {!account ? (
        <section className="flex flex-col gap-3 rounded-2xl border border-white/15 bg-white/[0.03] p-6">
          <p className="text-sm text-[var(--muted)]">
            Connect your admin wallet to continue.
          </p>
          <ConnectButton />
        </section>
      ) : (
        <section className="flex flex-col gap-4 rounded-2xl border border-white/15 bg-white/[0.03] p-6">
          <div className="flex flex-col gap-1">
            <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-soft)]">
              Connected wallet
            </p>
            <p className="font-mono text-sm text-[var(--accent)]">
              {account.address}
            </p>
          </div>

          {state.kind === "idle" && (
            <button
              type="button"
              onClick={handleDerive}
              className="self-start rounded-full bg-[var(--accent)] px-6 py-2 text-sm font-medium text-white shadow-[0_0_16px_-2px_var(--accent-glow),inset_0_1px_0_rgba(255,255,255,0.32)]"
            >
              Derive admin KYB pubkey
            </button>
          )}

          {(state.kind === "signing" || state.kind === "deriving") && (
            <p className="text-sm text-[var(--muted)]">
              {state.kind === "signing"
                ? "Awaiting wallet signature…"
                : "Deriving X25519 keypair…"}
            </p>
          )}

          {state.kind === "ready" && (
            <DerivedKeyResult
              walletAddress={state.walletAddress}
              pubkeyHex={state.pubkeyHex}
            />
          )}

          {state.kind === "error" && (
            <div className="rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4">
              <p className="text-sm text-[var(--danger)]">{state.message}</p>
              <button
                type="button"
                onClick={() => setState({ kind: "idle" })}
                className="mt-2 text-xs text-[var(--muted)] underline"
              >
                Try again
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function DerivedKeyResult({
  walletAddress,
  pubkeyHex,
}: {
  walletAddress: string;
  pubkeyHex: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-[var(--success)]">
        Derived successfully. Paste both values into your Vercel env, then redeploy.
      </p>
      <EnvLine label="ADMIN_WALLETS" value={walletAddress} />
      <EnvLine label="ADMIN_KYB_PUBKEY" value={pubkeyHex} />
      <p className="text-[11px] text-[var(--muted-soft)] leading-relaxed">
        Also set <code className="font-mono">ADMIN_JWT_SECRET</code> to a fresh
        random 32+ byte secret (e.g.{" "}
        <code className="font-mono">openssl rand -base64 32</code>) for admin
        cookies and merchant polling tokens.
      </p>
    </div>
  );
}

function EnvLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore — clipboard blocked */
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-soft)]">
        {label}
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 break-all rounded-lg border border-white/10 bg-[var(--surface-input)] px-3 py-2 font-mono text-xs text-[var(--foreground)]">
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          className="rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-xs text-[var(--muted)] hover:border-white/30"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
    </div>
  );
}
