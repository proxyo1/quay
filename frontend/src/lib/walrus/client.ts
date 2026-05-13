/**
 * Walrus client wrapper (D6).
 *
 * Implementation note: this wrapper targets the Walrus publisher /
 * aggregator HTTP endpoints rather than the full `@mysten/walrus`
 * WalrusClient. Reasons:
 *   - Browser-side uploads (Phase 2 logos) can't require the payer to
 *     hold WAL — the publisher pattern lets the operator's publisher
 *     pay storage fees instead.
 *   - Server-side uploads (Phase 3 receipts, Phase 4 evidence) go
 *     through the same publisher for symmetry.
 *   - The SDK is available as an upgrade path: swap the internals
 *     without changing the surface contract below.
 *
 * Typed-error contract per D21:
 *   WalrusUploadError, WalrusRateLimitError, WalrusFetchError,
 *   WalrusNotFoundError, WalrusIntegrityError.
 *
 * Callers in /api/receipts, /api/attest, onboarding logo upload, and
 * the verifier dApp (Phase 5) discriminate via `instanceof`.
 */
import { blake2b } from "@noble/hashes/blake2.js";

// ─── Endpoint config ────────────────────────────────────────────────────

function publisherUrl(): string {
  return (
    process.env.WALRUS_PUBLISHER_URL ??
    "https://publisher.walrus-testnet.walrus.space"
  );
}

function aggregatorUrl(): string {
  return (
    process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR_URL ??
    "https://aggregator.walrus-testnet.walrus.space"
  );
}

// ─── Typed errors (D21) ─────────────────────────────────────────────────

export class WalrusUploadError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  constructor(message: string, opts: { retryable: boolean; status?: number } = { retryable: false }) {
    super(message);
    this.name = "WalrusUploadError";
    this.retryable = opts.retryable;
    this.status = opts.status;
  }
}

export class WalrusRateLimitError extends WalrusUploadError {
  constructor(message = "Walrus publisher rate limited") {
    super(message, { retryable: true, status: 429 });
    this.name = "WalrusRateLimitError";
  }
}

export class WalrusFetchError extends Error {
  readonly blobId: string;
  readonly status?: number;
  constructor(message: string, blobId: string, status?: number) {
    super(message);
    this.name = "WalrusFetchError";
    this.blobId = blobId;
    this.status = status;
  }
}

export class WalrusNotFoundError extends WalrusFetchError {
  constructor(blobId: string) {
    super(`Walrus blob not found: ${blobId}`, blobId, 404);
    this.name = "WalrusNotFoundError";
  }
}

export class WalrusIntegrityError extends WalrusFetchError {
  readonly expectedHash: string;
  readonly actualHash: string;
  constructor(blobId: string, expectedHash: string, actualHash: string) {
    super(
      `Walrus integrity mismatch for ${blobId} (expected ${expectedHash.slice(0, 12)}…, got ${actualHash.slice(0, 12)}…)`,
      blobId,
    );
    this.name = "WalrusIntegrityError";
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

// ─── Types ──────────────────────────────────────────────────────────────

export interface UploadResult {
  blobId: string;
  size: number;
  certifiedEpoch?: number;
}

export interface UploadOptions {
  /** Number of Walrus epochs to fund storage for. Default: 50 (~1 year on testnet) per D2. */
  epochs?: number;
}

// ─── uploadBlob ─────────────────────────────────────────────────────────

const DEFAULT_EPOCHS = 50;

export async function uploadBlob(
  bytes: Uint8Array,
  opts: UploadOptions = {},
): Promise<UploadResult> {
  const epochs = opts.epochs ?? DEFAULT_EPOCHS;
  const url = `${publisherUrl()}/v1/blobs?epochs=${epochs}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes as BodyInit,
    });
  } catch (e) {
    throw new WalrusUploadError(
      `Walrus publisher unreachable: ${e instanceof Error ? e.message : String(e)}`,
      { retryable: true },
    );
  }

  if (res.status === 429) throw new WalrusRateLimitError();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new WalrusUploadError(
      `Walrus publisher ${res.status}: ${body.slice(0, 200)}`,
      { retryable: res.status >= 500, status: res.status },
    );
  }

  // Response shape: { newlyCreated: { blobObject: { blobId, size, ... }, ... } }
  //              or { alreadyCertified: { blobId, endEpoch, ... } }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new WalrusUploadError("Walrus publisher returned non-JSON body", { retryable: false });
  }

  const result = parsePublisherResponse(json, bytes.length);
  if (!result) {
    throw new WalrusUploadError(
      `Walrus publisher returned unexpected shape: ${JSON.stringify(json).slice(0, 200)}`,
      { retryable: false },
    );
  }
  return result;
}

function parsePublisherResponse(json: unknown, fallbackSize: number): UploadResult | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;

  if (obj.newlyCreated && typeof obj.newlyCreated === "object") {
    const nc = obj.newlyCreated as Record<string, unknown>;
    const blobObject = nc.blobObject as Record<string, unknown> | undefined;
    const blobId = typeof blobObject?.blobId === "string" ? blobObject.blobId : null;
    const size = typeof blobObject?.size === "number" ? blobObject.size : fallbackSize;
    const certifiedEpoch =
      typeof blobObject?.certifiedEpoch === "number" ? blobObject.certifiedEpoch : undefined;
    return blobId ? { blobId, size, certifiedEpoch } : null;
  }

  if (obj.alreadyCertified && typeof obj.alreadyCertified === "object") {
    const ac = obj.alreadyCertified as Record<string, unknown>;
    const blobId = typeof ac.blobId === "string" ? ac.blobId : null;
    const endEpoch = typeof ac.endEpoch === "number" ? ac.endEpoch : undefined;
    return blobId ? { blobId, size: fallbackSize, certifiedEpoch: endEpoch } : null;
  }

  return null;
}

// ─── fetchBlob ─ with integrity check ───────────────────────────────────

export async function fetchBlob(blobId: string): Promise<Uint8Array> {
  const url = `${aggregatorUrl()}/v1/blobs/${encodeURIComponent(blobId)}`;

  let res: Response;
  try {
    res = await fetch(url, { method: "GET" });
  } catch (e) {
    throw new WalrusFetchError(
      `Walrus aggregator unreachable: ${e instanceof Error ? e.message : String(e)}`,
      blobId,
    );
  }

  if (res.status === 404) throw new WalrusNotFoundError(blobId);
  if (!res.ok) {
    throw new WalrusFetchError(`Walrus aggregator ${res.status}`, blobId, res.status);
  }

  const buf = new Uint8Array(await res.arrayBuffer());

  // Integrity check: the blob ID is a Walrus-specific encoding (BLAKE2b
  // over RS-encoded slivers + metadata), NOT a plain hash of the content.
  // We can't recompute it locally without re-running the encoding pipeline.
  // What we CAN check is the blake2b256 of the bytes against an expected
  // hash if the caller supplies one — see `fetchBlobWithExpectedHash`.
  //
  // For receipts and evidence, the caller knows the expected
  // blake2b256(content) (the on-chain `evidence_hash` or a hash embedded
  // in `quote_metadata`) and should use `fetchBlobWithExpectedHash`.
  return buf;
}

/**
 * Fetch + verify content hash. Use when the caller has an out-of-band
 * commitment to the expected blake2b256 of the content (e.g., on-chain
 * `evidence_hash`, or a hash embedded in `quote_metadata`).
 *
 * Throws WalrusIntegrityError on mismatch. Throws WalrusNotFoundError /
 * WalrusFetchError as `fetchBlob` does.
 */
export async function fetchBlobWithExpectedHash(
  blobId: string,
  expectedBlake2b256: Uint8Array,
): Promise<Uint8Array> {
  const bytes = await fetchBlob(blobId);
  const actual = blake2b(bytes, { dkLen: 32 });
  if (!constantTimeEqual(actual, expectedBlake2b256)) {
    throw new WalrusIntegrityError(blobId, toHex(expectedBlake2b256), toHex(actual));
  }
  return bytes;
}

// ─── getBlobUrl ─────────────────────────────────────────────────────────

export function getBlobUrl(blobId: string): string {
  return `${aggregatorUrl()}/v1/blobs/${encodeURIComponent(blobId)}`;
}

// ─── internal helpers ──────────────────────────────────────────────────

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
