"use client";

import {
  ConnectButton,
  useCurrentAccount,
  useSignPersonalMessage,
} from "@mysten/dapp-kit";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  adminDecide,
  adminGetSubmission,
  fetchAdminKybPubkey,
  KybClientError,
} from "@/lib/kyb/client";
import {
  base64ToBytes,
  bytesToHex,
  decryptDocument,
  deriveAdminKeypairFromSignature,
  extractEd25519SigBytes,
  hexToBytes,
  unwrapDek,
} from "@/lib/kyb/crypto";
import type { KybAdminListItem } from "@/lib/kyb/types";
import { fetchBlob } from "@/lib/walrus/client";

import { DocViewer } from "./DocViewer";

const DERIVE_MESSAGE = "QUAY_KYB_DECRYPT_KEY_V1";

type DeriveState =
  | { kind: "needed" }
  | { kind: "signing" }
  | { kind: "deriving" }
  | { kind: "matched"; pubkeyHex: string; privKey: Uint8Array; pubKey: Uint8Array }
  | { kind: "mismatch"; derived: string; expected: string }
  | { kind: "error"; message: string };

type DecryptState =
  | { kind: "idle" }
  | { kind: "fetching" }
  | { kind: "decrypting" }
  | { kind: "ready"; plaintext: Uint8Array; mime: string }
  | { kind: "error"; message: string };

type DecideState =
  | { kind: "idle" }
  | { kind: "running"; decision: "approved" | "rejected" }
  | { kind: "done"; decision: "approved" | "rejected" }
  | { kind: "error"; message: string };

export default function AdminKybDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id ?? "";
  const account = useCurrentAccount();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();

  const [item, setItem] = useState<KybAdminListItem | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [adminPubkeyHex, setAdminPubkeyHex] = useState<string | null>(null);

  const [derive, setDerive] = useState<DeriveState>({ kind: "needed" });
  const [decrypt, setDecrypt] = useState<DecryptState>({ kind: "idle" });
  const [decide, setDecide] = useState<DecideState>({ kind: "idle" });
  const [rejectionReason, setRejectionReason] = useState("");

  // Load admin pubkey + submission row.
  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        const pubkey = await fetchAdminKybPubkey();
        setAdminPubkeyHex(pubkey);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setLoadError(`Could not load admin pubkey: ${msg}`);
        return;
      }
      try {
        const row = await adminGetSubmission(id);
        setItem(row);
      } catch (e) {
        if (e instanceof KybClientError && (e.status === 401 || e.status === 403)) {
          setAuthNeeded(true);
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        setLoadError(msg);
      }
    })();
  }, [id]);

  const handleDerive = useCallback(async () => {
    if (!account || !adminPubkeyHex) return;
    setDerive({ kind: "signing" });
    try {
      const messageBytes = new TextEncoder().encode(DERIVE_MESSAGE);
      const { signature } = await signPersonalMessage({ message: messageBytes });
      setDerive({ kind: "deriving" });
      const sigBytes = extractEd25519SigBytes(signature);
      const { x25519PrivKey, x25519PubKey } = await deriveAdminKeypairFromSignature(sigBytes);
      const derivedHex = bytesToHex(x25519PubKey);
      if (derivedHex.toLowerCase() !== adminPubkeyHex.trim().toLowerCase()) {
        setDerive({ kind: "mismatch", derived: derivedHex, expected: adminPubkeyHex });
        return;
      }
      setDerive({
        kind: "matched",
        pubkeyHex: derivedHex,
        privKey: x25519PrivKey,
        pubKey: x25519PubKey,
      });
    } catch (e) {
      setDerive({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [account, adminPubkeyHex, signPersonalMessage]);

  const handleFetchAndDecrypt = useCallback(async () => {
    if (!item || derive.kind !== "matched") return;
    // Submissions made after onboarding dropped the document have no
    // ciphertext at all. Only legacy rows reach the decrypt path.
    const mime = item.original_mime_type;
    if (
      !item.ciphertext_blob_id ||
      !item.wrapped_dek_b64 ||
      !item.ciphertext_nonce_b64 ||
      !mime
    ) {
      setDecrypt({
        kind: "error",
        message:
          "This submission has no document. Ownership was proven by PayNow micro-deposit instead.",
      });
      return;
    }
    setDecrypt({ kind: "fetching" });
    try {
      const ciphertext = await fetchBlob(item.ciphertext_blob_id);
      setDecrypt({ kind: "decrypting" });
      const wrapped = base64ToBytes(item.wrapped_dek_b64);
      const nonce = base64ToBytes(item.ciphertext_nonce_b64);
      const dek = await unwrapDek(wrapped, derive.privKey, derive.pubKey);
      try {
        const plaintext = decryptDocument(ciphertext, nonce, dek);
        setDecrypt({ kind: "ready", plaintext, mime });
      } finally {
        dek.fill(0); // zero plaintext DEK after use
      }
    } catch (e) {
      setDecrypt({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [derive, item]);

  // Auto-trigger fetch+decrypt once the derive succeeds.
  useEffect(() => {
    if (derive.kind === "matched" && decrypt.kind === "idle" && item) {
      void handleFetchAndDecrypt();
    }
  }, [derive, decrypt.kind, item, handleFetchAndDecrypt]);

  async function handleDecide(decision: "approved" | "rejected") {
    if (!item) return;
    if (decision === "rejected" && !rejectionReason.trim()) return;
    setDecide({ kind: "running", decision });
    try {
      await adminDecide({
        id: item.id,
        decision,
        reason: decision === "rejected" ? rejectionReason.trim() : undefined,
      });
      setDecide({ kind: "done", decision });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDecide({ kind: "error", message: msg });
    }
  }

  function handleLock() {
    if (derive.kind === "matched") derive.privKey.fill(0);
    setDerive({ kind: "needed" });
    setDecrypt({ kind: "idle" });
  }

  // ── Render ──

  if (loadError) {
    return (
      <ErrorShell>
        <p className="text-sm text-[var(--danger)]">{loadError}</p>
        <Link href="/admin/kyb" className="text-xs text-[var(--accent)] underline">
          ← back to queue
        </Link>
      </ErrorShell>
    );
  }
  if (authNeeded) {
    return (
      <ErrorShell>
        <p className="text-sm text-[var(--muted)]">
          Your admin session expired. Sign in again.
        </p>
        <button
          type="button"
          onClick={() => router.push("/admin/kyb")}
          className="self-start rounded-full bg-[var(--accent)] px-4 py-2 text-sm text-white"
        >
          Go to /admin/kyb
        </button>
      </ErrorShell>
    );
  }
  if (!account) {
    return (
      <ErrorShell>
        <p className="text-sm text-[var(--muted)]">Connect your admin wallet.</p>
        <ConnectButton />
      </ErrorShell>
    );
  }
  if (!item) {
    return (
      <ErrorShell>
        <p className="text-sm text-[var(--muted-soft)]">Loading submission…</p>
      </ErrorShell>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-6 py-8 text-[var(--foreground)]">
      <header className="flex items-center justify-between gap-4">
        <Link
          href="/admin/kyb"
          className="text-sm text-[var(--accent)] hover:underline inline-flex items-center gap-1"
        >
          <span aria-hidden>←</span> queue
        </Link>
        <div className="flex items-center gap-3">
          {derive.kind === "matched" && (
            <button
              type="button"
              onClick={handleLock}
              className="rounded-full border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs text-[var(--muted)] hover:border-white/30"
            >
              Lock
            </button>
          )}
          <p className="font-mono text-xs text-[var(--muted)]">
            {account.address.slice(0, 8)}…{account.address.slice(-6)}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
        <ViewerColumn
          derive={derive}
          decrypt={decrypt}
          onDerive={handleDerive}
        />
        <SidePanel
          item={item}
          decide={decide}
          rejectionReason={rejectionReason}
          setRejectionReason={setRejectionReason}
          onApprove={() => handleDecide("approved")}
          onReject={() => handleDecide("rejected")}
          canDecide={decrypt.kind === "ready" && decide.kind !== "done"}
        />
      </div>
    </main>
  );
}

function ViewerColumn({
  derive,
  decrypt,
  onDerive,
}: {
  derive: DeriveState;
  decrypt: DecryptState;
  onDerive: () => void;
}) {
  return (
    <section className="flex min-h-[60vh] flex-col gap-3 rounded-2xl border border-white/15 bg-white/[0.03] p-4">
      {derive.kind === "needed" && (
        <div className="flex flex-1 flex-col items-start justify-center gap-3 p-6">
          <p className="text-sm text-[var(--muted)]">
            Sign the derive-key message with your admin wallet to unlock decryption
            for this session.
          </p>
          <button
            type="button"
            onClick={onDerive}
            className="rounded-full bg-[var(--accent)] px-6 py-2 text-sm font-medium text-white shadow-[0_0_16px_-2px_var(--accent-glow),inset_0_1px_0_rgba(255,255,255,0.32)]"
          >
            Sign &amp; unlock
          </button>
        </div>
      )}
      {derive.kind === "signing" && <ViewerStatus label="Awaiting wallet signature…" />}
      {derive.kind === "deriving" && <ViewerStatus label="Deriving decryption key…" />}
      {derive.kind === "mismatch" && (
        <div className="flex flex-1 flex-col gap-2 p-6">
          <p className="text-sm text-[var(--danger)]">
            Wrong wallet connected — derived key does not match the configured
            admin pubkey.
          </p>
          <p className="text-xs text-[var(--muted)]">
            Expected: <code className="font-mono">{shortHex(derive.expected)}</code>
            <br />
            Got: <code className="font-mono">{shortHex(derive.derived)}</code>
          </p>
          <p className="text-xs text-[var(--muted-soft)]">
            Reconnect with the wallet that was used at <code>/admin/setup</code>.
          </p>
        </div>
      )}
      {derive.kind === "error" && (
        <div className="p-6">
          <p className="text-sm text-[var(--danger)]">{derive.message}</p>
          <button
            type="button"
            onClick={onDerive}
            className="mt-3 text-xs text-[var(--accent)] underline"
          >
            Try again
          </button>
        </div>
      )}
      {derive.kind === "matched" && decrypt.kind === "fetching" && (
        <ViewerStatus label="Fetching encrypted document from Walrus (this can take 5-15s)…" />
      )}
      {derive.kind === "matched" && decrypt.kind === "decrypting" && (
        <ViewerStatus label="Decrypting…" />
      )}
      {decrypt.kind === "error" && (
        <div className="p-6">
          <p className="text-sm text-[var(--danger)]">{decrypt.message}</p>
        </div>
      )}
      {decrypt.kind === "ready" && (
        <DocViewer plaintext={decrypt.plaintext} mime={decrypt.mime} />
      )}
    </section>
  );
}

function ViewerStatus({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <p className="text-sm text-[var(--muted)]">{label}</p>
    </div>
  );
}

function SidePanel({
  item,
  decide,
  rejectionReason,
  setRejectionReason,
  onApprove,
  onReject,
  canDecide,
}: {
  item: KybAdminListItem;
  decide: DecideState;
  rejectionReason: string;
  setRejectionReason: (s: string) => void;
  onApprove: () => void;
  onReject: () => void;
  canDecide: boolean;
}) {
  const decided = item.status !== "pending";
  return (
    <aside className="flex flex-col gap-4 rounded-2xl border border-white/15 bg-white/[0.03] p-5">
      <div className="space-y-1">
        <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-soft)]">
          Submitted UEN
        </p>
        <p className="font-mono text-lg text-[var(--foreground)]">{item.uen}</p>
      </div>
      <div className="space-y-1">
        <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-soft)]">
          Business name
        </p>
        <p className="text-sm text-[var(--foreground)]">
          {item.business_name ?? <span className="text-[var(--muted-soft)]">—</span>}
        </p>
      </div>
      <div className="space-y-1">
        <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-soft)]">
          Submitting wallet
        </p>
        <p className="font-mono break-all text-xs text-[var(--muted)]">
          {item.wallet_address}
        </p>
      </div>
      <div className="space-y-1">
        <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted-soft)]">
          Status
        </p>
        <p className="text-sm capitalize text-[var(--foreground)]">{item.status}</p>
        {item.decided_by && (
          <p className="text-[10px] text-[var(--muted-soft)]">
            Decided by{" "}
            <span className="font-mono">
              {item.decided_by.slice(0, 8)}…{item.decided_by.slice(-6)}
            </span>{" "}
            on {item.decided_at}
          </p>
        )}
      </div>

      {decided && item.rejection_reason && (
        <div className="rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3">
          <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--warning)]">
            Rejection reason
          </p>
          <p className="mt-1 text-sm text-[var(--foreground)]">{item.rejection_reason}</p>
        </div>
      )}

      {!decided && (
        <>
          <hr className="border-white/10" />
          <div className="space-y-2">
            <label className="block text-[10px] uppercase tracking-[0.16em] text-[var(--muted-soft)]">
              Rejection reason (required for reject)
            </label>
            <textarea
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="e.g. document does not show UEN clearly"
              className="w-full rounded-lg border border-white/15 bg-[var(--surface-input)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-soft)]"
              rows={3}
              disabled={decide.kind === "running" || decide.kind === "done"}
            />
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={onApprove}
              disabled={!canDecide || decide.kind === "running"}
              className="rounded-full bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white shadow-[0_0_16px_-2px_var(--accent-glow),inset_0_1px_0_rgba(255,255,255,0.32)] disabled:opacity-40"
            >
              {decide.kind === "running" && decide.decision === "approved"
                ? "Approving…"
                : "Approve"}
            </button>
            <button
              type="button"
              onClick={onReject}
              disabled={!canDecide || decide.kind === "running" || !rejectionReason.trim()}
              className="rounded-full border border-[var(--danger)]/40 bg-transparent px-4 py-2.5 text-sm font-medium text-[var(--danger)] disabled:opacity-40"
            >
              {decide.kind === "running" && decide.decision === "rejected"
                ? "Rejecting…"
                : "Reject"}
            </button>
          </div>
          {decide.kind === "error" && (
            <p className="text-xs text-[var(--danger)]">{decide.message}</p>
          )}
          {decide.kind === "done" && (
            <p className="text-xs text-[var(--success)]">
              {decide.decision === "approved"
                ? "Approved. The merchant will see this on their next poll."
                : "Rejected. The merchant will see the reason and can re-submit."}
            </p>
          )}
        </>
      )}
    </aside>
  );
}

function ErrorShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-3 px-6 py-12">
      {children}
    </main>
  );
}

function shortHex(s: string): string {
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}
