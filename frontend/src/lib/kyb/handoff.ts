/**
 * Browser-side sessionStorage helper for carrying KYB submission context
 * from the onboard page to the pending page (and on to /finalize).
 *
 * Per-tab: sessionStorage means closing the tab loses the handoff. That's
 * fine — the merchant can re-look-up their pending submission via wallet
 * once we add that path. For v1, the polling_token JWT is the only piece
 * of state that's load-bearing; the rest is convenience.
 */

const STORAGE_KEY = "quay.kyb_pending.v1";

export interface KybPendingHandoff {
  submissionId: string;
  pollingToken: string;
  walletAddress: string;
  uen: string;
  metadataBlobId: string | null;
  submittedAt: string;
}

export function savePendingHandoff(handoff: KybPendingHandoff): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(handoff));
  } catch {
    /* sessionStorage disabled — pending page will show a friendly fallback */
  }
}

export function loadPendingHandoff(): KybPendingHandoff | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KybPendingHandoff>;
    if (
      typeof parsed.submissionId !== "string" ||
      typeof parsed.pollingToken !== "string" ||
      typeof parsed.walletAddress !== "string" ||
      typeof parsed.uen !== "string"
    ) {
      return null;
    }
    return {
      submissionId: parsed.submissionId,
      pollingToken: parsed.pollingToken,
      walletAddress: parsed.walletAddress,
      uen: parsed.uen,
      metadataBlobId: parsed.metadataBlobId ?? null,
      submittedAt: parsed.submittedAt ?? "",
    };
  } catch {
    return null;
  }
}

export function clearPendingHandoff(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
