import { describe, expect, test } from "bun:test";

import {
  IllegalTransitionError,
  OPEN_STATUSES,
  TERMINAL_STATUSES,
  canTransition,
  isTerminal,
  nextStatus,
  type OfframpEvent,
  type OfframpStatus,
} from "../coinbase-offramp-store";

const ALL_STATUSES: OfframpStatus[] = [
  "created",
  "committed",
  "sent",
  "settled",
  "expired",
  "refunded",
  "failed",
];

const ALL_EVENTS: OfframpEvent[] = [
  "commit",
  "send",
  "settle",
  "expire",
  "refund",
  "fail",
];

/** Every transition the machine is supposed to permit. */
const LEGAL: Array<[OfframpStatus, OfframpEvent, OfframpStatus]> = [
  ["created", "commit", "committed"],
  ["created", "expire", "expired"],
  ["created", "fail", "failed"],
  ["committed", "send", "sent"],
  ["committed", "expire", "expired"],
  ["committed", "fail", "failed"],
  ["sent", "settle", "settled"],
  ["sent", "refund", "refunded"],
  ["sent", "fail", "failed"],
];

describe("nextStatus — legal transitions", () => {
  for (const [from, event, to] of LEGAL) {
    test(`${from} --${event}--> ${to}`, () => {
      expect(nextStatus(from, event)).toBe(to);
      expect(canTransition(from, event)).toBe(true);
    });
  }

  test("the happy path runs end to end", () => {
    let s: OfframpStatus = "created";
    s = nextStatus(s, "commit");
    s = nextStatus(s, "send");
    s = nextStatus(s, "settle");
    expect(s).toBe("settled");
  });
});

describe("nextStatus — illegal transitions", () => {
  const legalSet = new Set(LEGAL.map(([f, e]) => `${f}:${e}`));

  test("every pairing not in the legal table throws", () => {
    // Exhaustive: 7 statuses x 6 events, minus the 9 legal ones.
    let checked = 0;
    for (const from of ALL_STATUSES) {
      for (const event of ALL_EVENTS) {
        if (legalSet.has(`${from}:${event}`)) continue;
        checked += 1;
        expect(() => nextStatus(from, event)).toThrow(IllegalTransitionError);
        expect(canTransition(from, event)).toBe(false);
      }
    }
    expect(checked).toBe(ALL_STATUSES.length * ALL_EVENTS.length - LEGAL.length);
  });

  test("a row cannot settle without having sent", () => {
    // The premature-settle rule: settling from `committed` would mark a
    // cash-out complete when no USDC ever left the merchant's wallet.
    expect(() => nextStatus("committed", "settle")).toThrow(IllegalTransitionError);
    expect(() => nextStatus("created", "settle")).toThrow(IllegalTransitionError);
  });

  test("a row cannot refund without having sent", () => {
    // A refund means Coinbase returned funds we actually sent; earlier it
    // would invent a return of money that never moved.
    expect(() => nextStatus("created", "refund")).toThrow(IllegalTransitionError);
    expect(() => nextStatus("committed", "refund")).toThrow(IllegalTransitionError);
  });

  test("a row cannot send before the order is committed", () => {
    // Before `commit` there is no to_address to send to.
    expect(() => nextStatus("created", "send")).toThrow(IllegalTransitionError);
  });

  test("sent rows cannot expire — the money is already gone", () => {
    expect(() => nextStatus("sent", "expire")).toThrow(IllegalTransitionError);
  });

  test("the error names both sides for diagnostics", () => {
    try {
      nextStatus("committed", "settle");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalTransitionError);
      if (e instanceof IllegalTransitionError) {
        expect(e.from).toBe("committed");
        expect(e.event).toBe("settle");
        expect(e.message).toContain("committed");
        expect(e.message).toContain("settle");
      }
    }
  });
});

describe("terminal statuses", () => {
  test("no event escapes a terminal status", () => {
    // A late poll, a duplicated cron tick, or a replayed webhook must not
    // resurrect a finished row.
    for (const status of TERMINAL_STATUSES) {
      for (const event of ALL_EVENTS) {
        expect(() => nextStatus(status, event)).toThrow(IllegalTransitionError);
      }
    }
  });

  test("isTerminal agrees with the transition table", () => {
    for (const status of ALL_STATUSES) {
      const hasOutgoing = ALL_EVENTS.some((e) => canTransition(status, e));
      expect(isTerminal(status)).toBe(!hasOutgoing);
    }
  });

  test("settled is terminal — a second settle cannot double-pay", () => {
    expect(isTerminal("settled")).toBe(true);
    expect(() => nextStatus("settled", "settle")).toThrow(IllegalTransitionError);
  });
});

describe("status sets", () => {
  test("open statuses are exactly the non-terminal ones", () => {
    expect([...OPEN_STATUSES].sort()).toEqual(
      ALL_STATUSES.filter((s) => !isTerminal(s)).sort(),
    );
  });

  test("open and terminal partition the whole status space", () => {
    expect([...OPEN_STATUSES, ...TERMINAL_STATUSES].sort()).toEqual(
      [...ALL_STATUSES].sort(),
    );
  });

  test("the in-flight lock covers every open status", () => {
    // The partial unique index in the migration is defined over exactly these,
    // so a drift here silently lets a merchant open two concurrent cash-outs.
    expect(OPEN_STATUSES).toEqual(["created", "committed", "sent"]);
  });
});
