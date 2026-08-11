import { afterEach, describe, expect, test } from "bun:test";

import { queryEventsByType } from "../events";

/**
 * Sui's GraphQL rejects any page over 50 outright — "Page size is too large:
 * 100 > 50" — so a caller wanting more must walk backwards. Five pages asked
 * for 100 or 200 in one shot and every one of them showed a permanent spinner.
 *
 * The live chain carries too few PaymentReceipt events to exercise more than
 * one page, so the stitching is pinned here instead.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Recorded {
  last: number;
  before: string | null;
}

/** Serve `total` events, newest last, in server-side pages. */
function stubChain(total: number, recorded: Recorded[]) {
  // Ascending by construction: index 0 is oldest, so timestamps increase.
  const all = Array.from({ length: total }, (_, i) => ({
    timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    sender: { address: `0xsender${i}` },
    transaction: { digest: `digest-${i}` },
    transactionModule: { package: { address: "0xpkg" }, name: "payments" },
    contents: { type: { repr: "0xpkg::payments::PaymentReceipt" }, json: { i } },
  }));

  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const { variables } = JSON.parse(init.body) as {
      variables: { last: number; before: string | null };
    };
    recorded.push({ last: variables.last, before: variables.before ?? null });

    // `before` is the index of the oldest node already returned.
    const end = variables.before === null ? all.length : Number(variables.before);
    const start = Math.max(0, end - variables.last);
    const nodes = all.slice(start, end);

    return {
      ok: true,
      json: async () => ({
        data: {
          events: {
            pageInfo: {
              hasPreviousPage: start > 0,
              startCursor: nodes.length > 0 ? String(start) : null,
            },
            nodes,
          },
        },
      }),
    };
  }) as unknown as typeof fetch;
}

describe("queryEventsByType paging", () => {
  test("a request over the cap is split, never sent as one oversized page", () => {
    // The exact regression: history asked for 100 and got a validation error.
    const seen: Recorded[] = [];
    stubChain(120, seen);

    return queryEventsByType("0xpkg::payments::PaymentReceipt", 100).then((events) => {
      expect(events).toHaveLength(100);
      expect(seen.length).toBeGreaterThan(1);
      for (const req of seen) expect(req.last).toBeLessThanOrEqual(50);
    });
  });

  test("pages stitch into one newest-first run with no gaps or repeats", async () => {
    const seen: Recorded[] = [];
    stubChain(120, seen);

    const events = await queryEventsByType("0xpkg::payments::PaymentReceipt", 100);
    const times = events.map((e) => Number(e.timestampMs));

    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(new Set(events.map((e) => e.txDigest)).size).toBe(events.length);
    // Newest overall must lead: prepending pages in the wrong order would put
    // the oldest page first and quietly show stale history.
    expect(events[0]?.txDigest).toBe("digest-119");
  });

  test("stops at the end of history rather than asking forever", async () => {
    const seen: Recorded[] = [];
    stubChain(12, seen);

    const events = await queryEventsByType("0xpkg::payments::PaymentReceipt", 200);
    expect(events).toHaveLength(12);
    expect(seen).toHaveLength(1);
  });

  test("an empty page ends the walk", async () => {
    // A server reporting hasPreviousPage on an empty page would loop forever.
    const seen: Recorded[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).variables);
      return {
        ok: true,
        json: async () => ({
          data: {
            events: {
              pageInfo: { hasPreviousPage: true, startCursor: "always-more" },
              nodes: [],
            },
          },
        }),
      };
    }) as unknown as typeof fetch;

    expect(await queryEventsByType("0xpkg::payments::PaymentReceipt", 200)).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  test("a single page still satisfies a small request", async () => {
    const seen: Recorded[] = [];
    stubChain(120, seen);

    const events = await queryEventsByType("0xpkg::payments::PaymentReceipt", 10);
    expect(events).toHaveLength(10);
    expect(seen).toEqual([{ last: 10, before: null }]);
  });
});
