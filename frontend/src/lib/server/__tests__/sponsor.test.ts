import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Regression suite for the sponsored-gas daily counter.
 *
 * None existed before, and the counter was being rewritten from a per-process
 * Map to a Supabase-backed one across six call sites — including the merchant
 * registration path in kyb-attestation.ts. The behaviours that matter are the
 * ones a rate limiter gets wrong under load or outage: allowing past the cap,
 * failing to reset the window, and what happens when the store is unreachable.
 *
 * `getSupabaseClient` is mocked so these stay pure unit tests; the repo does
 * not test against a live Supabase (see kyb-store.test.ts, which documents the
 * same convention).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

let rpcCalls: RpcCall[] = [];
let rpcImpl: (args: Record<string, unknown>) => { data: unknown; error: unknown };
let clientIsNull = false;

mock.module("@/lib/server/supabase", () => ({
  getSupabaseClient: () =>
    clientIsNull
      ? null
      : {
          rpc: async (fn: string, args: Record<string, unknown>) => {
            rpcCalls.push({ fn, args });
            return rpcImpl(args);
          },
        },
  isSupabaseConfigured: () => !clientIsNull,
}));

const { checkAndIncrementSponsorUsage } = await import("../sponsor");

/** In-memory stand-in for the Postgres function, same semantics. */
function makeFakeStore() {
  const rows = new Map<string, { count: number; resetAt: number }>();
  return {
    rows,
    impl(args: Record<string, unknown>) {
      const key = args.p_usage_key as string;
      const cap = args.p_daily_cap as number;
      const windowMs = Number(args.p_window_ms);
      const now = Date.now();
      let row = rows.get(key);
      if (!row || row.resetAt <= now) {
        row = { count: 0, resetAt: now + windowMs };
        rows.set(key, row);
      }
      if (row.count >= cap) {
        return {
          data: [
            { allowed: false, current_count: row.count, reset_at: new Date(row.resetAt).toISOString() },
          ],
          error: null,
        };
      }
      row.count += 1;
      return {
        data: [
          { allowed: true, current_count: row.count, reset_at: new Date(row.resetAt).toISOString() },
        ],
        error: null,
      };
    },
  };
}

let store: ReturnType<typeof makeFakeStore>;

beforeEach(() => {
  rpcCalls = [];
  clientIsNull = false;
  store = makeFakeStore();
  rpcImpl = store.impl;
});

afterEach(() => {
  rpcCalls = [];
});

describe("checkAndIncrementSponsorUsage", () => {
  test("first call for an address is allowed", async () => {
    const r = await checkAndIncrementSponsorUsage("0xabc", 5);
    expect(r.ok).toBe(true);
  });

  test("calls the atomic RPC rather than reading then writing", async () => {
    await checkAndIncrementSponsorUsage("0xabc", 5);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("consume_sponsor_usage");
    expect(rpcCalls[0].args).toMatchObject({
      p_usage_key: "0xabc",
      p_daily_cap: 5,
      p_window_ms: DAY_MS,
    });
  });

  test("allows exactly up to the cap, then rejects", async () => {
    const cap = 3;
    for (let i = 0; i < cap; i++) {
      expect((await checkAndIncrementSponsorUsage("0xabc", cap)).ok).toBe(true);
    }
    const denied = await checkAndIncrementSponsorUsage("0xabc", cap);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.remaining).toBe(0);
      expect(denied.resetAt).toBeGreaterThan(Date.now());
    }
  });

  test("a rejected call does not consume further allowance", async () => {
    for (let i = 0; i < 2; i++) await checkAndIncrementSponsorUsage("0xabc", 2);
    await checkAndIncrementSponsorUsage("0xabc", 2);
    await checkAndIncrementSponsorUsage("0xabc", 2);
    expect(store.rows.get("0xabc")?.count).toBe(2);
  });

  test("counters are independent per address", async () => {
    await checkAndIncrementSponsorUsage("0xaaa", 1);
    expect((await checkAndIncrementSponsorUsage("0xaaa", 1)).ok).toBe(false);
    // A different merchant is unaffected by the first one's exhaustion.
    expect((await checkAndIncrementSponsorUsage("0xbbb", 1)).ok).toBe(true);
  });

  test("route labels get their own budget on the same address", async () => {
    // The app keys per-route counters as `${owner}:${label}`; withdraw hitting
    // its cap must not block toggle-yield.
    await checkAndIncrementSponsorUsage("0xabc:withdraw", 1);
    expect((await checkAndIncrementSponsorUsage("0xabc:withdraw", 1)).ok).toBe(false);
    expect((await checkAndIncrementSponsorUsage("0xabc:toggle-yield", 1)).ok).toBe(true);
  });

  test("window expiry resets the count", async () => {
    await checkAndIncrementSponsorUsage("0xabc", 1);
    expect((await checkAndIncrementSponsorUsage("0xabc", 1)).ok).toBe(false);
    // Expire the window the way the passage of a day would.
    const row = store.rows.get("0xabc")!;
    row.resetAt = Date.now() - 1;
    expect((await checkAndIncrementSponsorUsage("0xabc", 1)).ok).toBe(true);
  });

  test("concurrent increments cannot exceed the cap", async () => {
    // The whole reason the increment lives in a Postgres function: ten
    // simultaneous requests against a cap of 5 must yield exactly 5 allows.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => checkAndIncrementSponsorUsage("0xabc", 5)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(store.rows.get("0xabc")?.count).toBe(5);
  });

  test("reports a real reset timestamp on rejection", async () => {
    await checkAndIncrementSponsorUsage("0xabc", 1);
    const denied = await checkAndIncrementSponsorUsage("0xabc", 1);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(Number.isNaN(denied.resetAt)).toBe(false);
      expect(denied.resetAt).toBeLessThanOrEqual(Date.now() + DAY_MS + 1000);
    }
  });
});

describe("failure modes", () => {
  test("fails OPEN when Supabase is not configured", async () => {
    // Failing closed would brick withdrawals and merchant registration for an
    // outage unrelated to rate limiting; the sponsor balance floor is the hard
    // rail instead.
    clientIsNull = true;
    expect((await checkAndIncrementSponsorUsage("0xabc", 5)).ok).toBe(true);
  });

  test("fails OPEN when the RPC errors", async () => {
    rpcImpl = () => ({ data: null, error: { message: "connection refused" } });
    expect((await checkAndIncrementSponsorUsage("0xabc", 5)).ok).toBe(true);
  });

  test("fails OPEN when the RPC returns no row", async () => {
    rpcImpl = () => ({ data: [], error: null });
    expect((await checkAndIncrementSponsorUsage("0xabc", 5)).ok).toBe(true);
  });

  test("fails OPEN when the RPC throws outright", async () => {
    rpcImpl = () => {
      throw new Error("boom");
    };
    expect((await checkAndIncrementSponsorUsage("0xabc", 5)).ok).toBe(true);
  });

  test("accepts a bare object as well as a one-row array", async () => {
    // supabase-js shapes `returns table` results as an array, but tolerate the
    // scalar form rather than failing open on a well-formed answer.
    rpcImpl = () => ({
      data: { allowed: false, current_count: 9, reset_at: new Date(Date.now() + 1000).toISOString() },
      error: null,
    });
    const r = await checkAndIncrementSponsorUsage("0xabc", 5);
    expect(r.ok).toBe(false);
  });
});
