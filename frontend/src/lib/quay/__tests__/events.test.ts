import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Sui's GraphQL rejects any page over 50 outright — "Page size is too large:
 * 100 > 50" — so a caller wanting more must walk backwards. Five pages asked
 * for 100 or 200 in one shot and every one of them showed a permanent spinner.
 *
 * The SDK's `listEvents` does NOT absorb this: it passes `limit` through and
 * the server still throws (verified against mainnet — 51 is already too many).
 * So the paging loop is ours, and this is where it is pinned. The live chain
 * carries too few PaymentReceipt events to exercise more than one page.
 *
 * Stubbing at the SDK client rather than at `fetch` keeps these tests about
 * our paging rather than about the SDK's query text.
 */

const TYPE = "0xpkg::payments::PaymentReceipt";

interface Recorded {
  limit: number;
  order: string;
  before: string | null;
  after: string | null;
}

let recorded: Recorded[] = [];
let listEventsImpl: (opts: Record<string, unknown>) => Promise<unknown>;

mock.module("@mysten/sui/graphql", () => ({
  SuiGraphQLClient: class {
    listEvents(opts: Record<string, unknown>) {
      recorded.push({
        limit: opts.limit as number,
        order: opts.order as string,
        before: (opts.before as string | null) ?? null,
        after: (opts.after as string | null) ?? null,
      });
      return listEventsImpl(opts);
    }
  },
}));

const { queryEventsByType, queryEventsPageAscending } = await import("../events");

/** An SDK-shaped event; index 0 is the oldest. */
function evt(i: number) {
  return {
    eventType: TYPE,
    json: { i },
    transactionDigest: `digest-${i}`,
    sender: `0xsender${i}`,
    packageId: "0xpkg",
    module: "payments",
    bcs: new Uint8Array(),
    checkpoint: String(1000 + i),
    eventIndex: 0,
  };
}

/**
 * Serve `total` events from a fake ledger, honouring cursor + order the way
 * the SDK documents: a descending page arrives newest-first and `endCursor`
 * points at its last (oldest) item, to be passed back as `before`.
 */
function stubLedger(total: number) {
  listEventsImpl = async (opts) => {
    const limit = opts.limit as number;
    const descending = opts.order === "descending";

    if (descending) {
      const end = opts.before == null ? total : Number(opts.before);
      const start = Math.max(0, end - limit);
      const slice = [];
      for (let i = end - 1; i >= start; i--) slice.push(evt(i));
      return {
        events: slice,
        hasNextPage: start > 0,
        startCursor: slice.length ? String(end - 1) : null,
        endCursor: slice.length ? String(start) : null,
      };
    }

    const start = opts.after == null ? 0 : Number(opts.after);
    const end = Math.min(total, start + limit);
    const slice = [];
    for (let i = start; i < end; i++) slice.push(evt(i));
    return {
      events: slice,
      hasNextPage: end < total,
      startCursor: slice.length ? String(start) : null,
      endCursor: slice.length ? String(end) : null,
    };
  };
}

beforeEach(() => {
  recorded = [];
  stubLedger(120);
});
afterEach(() => {
  recorded = [];
});

describe("queryEventsByType paging", () => {
  test("a request over the cap is split, never sent as one oversized page", async () => {
    // The exact regression: history asked for 100 and got a validation error.
    const events = await queryEventsByType(TYPE, 100);

    expect(events).toHaveLength(100);
    expect(recorded.length).toBeGreaterThan(1);
    for (const req of recorded) expect(req.limit).toBeLessThanOrEqual(50);
  });

  test("pages stitch into one newest-first run with no gaps or repeats", async () => {
    const events = await queryEventsByType(TYPE, 100);

    // Newest overall must lead: appending pages in the wrong order would put
    // the oldest page first and quietly show stale history.
    expect(events[0]?.txDigest).toBe("digest-119");
    expect(events.at(-1)?.txDigest).toBe("digest-20");
    expect(new Set(events.map((e) => e.txDigest)).size).toBe(events.length);
    expect(events.map((e) => (e.parsedJson as { i: number }).i)).toEqual(
      Array.from({ length: 100 }, (_, k) => 119 - k),
    );
  });

  test("stops at the end of history rather than asking forever", async () => {
    stubLedger(12);

    const events = await queryEventsByType(TYPE, 200);
    expect(events).toHaveLength(12);
    expect(recorded).toHaveLength(1);
  });

  test("an empty page ends the walk", async () => {
    // A server reporting hasNextPage on an empty page would loop forever.
    listEventsImpl = async () => ({
      events: [],
      hasNextPage: true,
      startCursor: "always-more",
      endCursor: "always-more",
    });

    expect(await queryEventsByType(TYPE, 200)).toEqual([]);
    expect(recorded).toHaveLength(1);
  });

  test("a single page still satisfies a small request", async () => {
    const events = await queryEventsByType(TYPE, 10);

    expect(events).toHaveLength(10);
    expect(recorded).toEqual([
      { limit: 10, order: "descending", before: null, after: null },
    ]);
  });

  test("the emitting package is carried through, for upgrade detection", async () => {
    // scallop-monitor reads this to notice a protocol upgrade.
    const events = await queryEventsByType(TYPE, 1);
    expect(events[0]?.emittingPackage).toBe("0xpkg");
  });
});

describe("queryEventsPageAscending", () => {
  test("returns oldest-first and a cursor that advances", async () => {
    const first = await queryEventsPageAscending(TYPE, 50, null);

    expect(first.events).toHaveLength(50);
    expect(first.events[0]?.txDigest).toBe("digest-0");
    expect(first.hasNextPage).toBe(true);

    const second = await queryEventsPageAscending(TYPE, 50, first.endCursor);
    expect(second.events[0]?.txDigest).toBe("digest-50");
  });

  test("clamps an oversized page to the server cap", async () => {
    await queryEventsPageAscending(TYPE, 500, null);
    expect(recorded[0]?.limit).toBe(50);
    expect(recorded[0]?.order).toBe("ascending");
  });
});
