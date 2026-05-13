import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { blake2b } from "@noble/hashes/blake2.js";

import {
  uploadBlob,
  fetchBlob,
  fetchBlobWithExpectedHash,
  getBlobUrl,
  WalrusUploadError,
  WalrusRateLimitError,
  WalrusFetchError,
  WalrusNotFoundError,
  WalrusIntegrityError,
} from "../client";

// Save & restore globalThis.fetch around each test.
const originalFetch = globalThis.fetch;

function mockFetchOnce(impl: (req: Request | string | URL, init?: RequestInit) => Response | Promise<Response>) {
  let called = false;
  globalThis.fetch = (async (req: Request | string | URL, init?: RequestInit) => {
    if (called) throw new Error("mockFetchOnce: fetch called twice");
    called = true;
    return impl(req, init);
  }) as typeof fetch;
}

beforeEach(() => {
  // each test installs its own mock
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── upload ────────────────────────────────────────────────────────────

describe("uploadBlob", () => {
  test("happy path — newlyCreated response", async () => {
    mockFetchOnce(async (_url) => {
      return new Response(
        JSON.stringify({
          newlyCreated: {
            blobObject: { blobId: "abc123def", size: 42, certifiedEpoch: 7 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await uploadBlob(new Uint8Array(42));
    expect(result.blobId).toBe("abc123def");
    expect(result.size).toBe(42);
    expect(result.certifiedEpoch).toBe(7);
  });

  test("happy path — alreadyCertified response", async () => {
    mockFetchOnce(async () => {
      return new Response(
        JSON.stringify({
          alreadyCertified: { blobId: "xyz789", endEpoch: 99 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await uploadBlob(new Uint8Array(10));
    expect(result.blobId).toBe("xyz789");
    expect(result.certifiedEpoch).toBe(99);
  });

  test("429 throws WalrusRateLimitError (retryable)", async () => {
    mockFetchOnce(async () => new Response("rate limited", { status: 429 }));

    try {
      await uploadBlob(new Uint8Array(1));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WalrusRateLimitError);
      expect(e).toBeInstanceOf(WalrusUploadError);
      expect((e as WalrusUploadError).retryable).toBe(true);
      expect((e as WalrusUploadError).status).toBe(429);
    }
  });

  test("500 throws WalrusUploadError retryable=true", async () => {
    mockFetchOnce(async () => new Response("oops", { status: 503 }));

    try {
      await uploadBlob(new Uint8Array(1));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WalrusUploadError);
      expect((e as WalrusUploadError).retryable).toBe(true);
    }
  });

  test("400 throws WalrusUploadError retryable=false", async () => {
    mockFetchOnce(async () => new Response("bad input", { status: 400 }));

    try {
      await uploadBlob(new Uint8Array(1));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WalrusUploadError);
      expect((e as WalrusUploadError).retryable).toBe(false);
    }
  });

  test("network failure throws retryable WalrusUploadError", async () => {
    mockFetchOnce(async () => {
      throw new TypeError("fetch failed");
    });

    try {
      await uploadBlob(new Uint8Array(1));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WalrusUploadError);
      expect((e as WalrusUploadError).retryable).toBe(true);
    }
  });

  test("unexpected response shape throws non-retryable", async () => {
    mockFetchOnce(async () => new Response(JSON.stringify({ weird: "shape" }), { status: 200 }));

    try {
      await uploadBlob(new Uint8Array(1));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WalrusUploadError);
      expect((e as WalrusUploadError).retryable).toBe(false);
    }
  });
});

// ─── fetch ─────────────────────────────────────────────────────────────

describe("fetchBlob", () => {
  test("happy path returns bytes", async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    mockFetchOnce(async () => new Response(body, { status: 200 }));

    const out = await fetchBlob("blob-abc");
    expect(out).toEqual(body);
  });

  test("404 throws WalrusNotFoundError", async () => {
    mockFetchOnce(async () => new Response("not found", { status: 404 }));

    try {
      await fetchBlob("missing-blob");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WalrusNotFoundError);
      expect(e).toBeInstanceOf(WalrusFetchError);
      expect((e as WalrusFetchError).blobId).toBe("missing-blob");
    }
  });

  test("500 throws WalrusFetchError", async () => {
    mockFetchOnce(async () => new Response("oops", { status: 503 }));

    try {
      await fetchBlob("blob-x");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WalrusFetchError);
      expect(e).not.toBeInstanceOf(WalrusNotFoundError);
    }
  });
});

// ─── fetch + integrity ────────────────────────────────────────────────

describe("fetchBlobWithExpectedHash", () => {
  test("happy path verifies hash", async () => {
    const body = new Uint8Array([10, 20, 30]);
    const expected = blake2b(body, { dkLen: 32 });
    mockFetchOnce(async () => new Response(body, { status: 200 }));

    const out = await fetchBlobWithExpectedHash("blob-ok", expected);
    expect(out).toEqual(body);
  });

  test("mismatch throws WalrusIntegrityError", async () => {
    const body = new Uint8Array([10, 20, 30]);
    const wrongExpected = new Uint8Array(32); // zeros
    mockFetchOnce(async () => new Response(body, { status: 200 }));

    try {
      await fetchBlobWithExpectedHash("blob-tampered", wrongExpected);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WalrusIntegrityError);
      expect(e).toBeInstanceOf(WalrusFetchError);
      expect((e as WalrusIntegrityError).blobId).toBe("blob-tampered");
    }
  });
});

// ─── getBlobUrl ─────────────────────────────────────────────────────────

describe("getBlobUrl", () => {
  test("returns aggregator URL with blob id", () => {
    const url = getBlobUrl("blob-123");
    expect(url).toContain("/v1/blobs/blob-123");
    expect(url).toMatch(/^https?:\/\//);
  });

  test("URL-encodes special characters", () => {
    const url = getBlobUrl("a/b c");
    expect(url).toContain("a%2Fb%20c");
  });
});
