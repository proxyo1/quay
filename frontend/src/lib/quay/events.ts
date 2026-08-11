/**
 * Event queries.
 *
 * The gRPC surface Quay moved to has **no event query at all** — only a
 * streaming subscription service — so historical lookups come from Sui's
 * GraphQL endpoint instead. That leaves the app on two transports by
 * necessity, not by choice: gRPC for state, GraphQL for event history.
 *
 * Two access patterns, deliberately served differently:
 *
 *  - **by type** (`queryEventsByType`) → GraphQL. This is the "show me the
 *    last N PaymentReceipts" case behind the history and terminal screens.
 *  - **by transaction** (`eventsForTransaction`) → gRPC `getTransaction`
 *    with `include: { events: true }`. GraphQL's `EventFilter` exposes only
 *    `afterCheckpoint`, `atCheckpoint`, `beforeCheckpoint`, `sender`,
 *    `module` and `type` — there is no digest filter — and asking the
 *    transaction for its own events is a cheaper question anyway.
 *
 * Shape note: `parsedJson` is normalised to look like the old JSON-RPC field
 * so callers did not have to change, but the SDK warns that JSON
 * representations differ across transports. The one difference that bites in
 * practice is `vector<u8>`: JSON-RPC returned `number[]`, GraphQL returns
 * base64. `bytesFromEventField` below absorbs both.
 */

import { SUI_NETWORK } from "@/lib/sui-config";
import type { SuiClient } from "@/lib/sui-client";

/** Normalised event, shaped to match what `queryEvents` used to return. */
export interface QuayEvent {
  type: string;
  parsedJson: unknown;
  txDigest: string | null;
  sender: string | null;
  timestampMs: string | null;
  /** Address of the package whose module emitted this event, when known. */
  emittingPackage: string | null;
}

const DEFAULT_GRAPHQL_URL: Record<"mainnet" | "testnet", string> = {
  mainnet: "https://graphql.mainnet.sui.io/graphql",
  testnet: "https://graphql.testnet.sui.io/graphql",
};

export const SUI_GRAPHQL_URL =
  process.env.NEXT_PUBLIC_SUI_GRAPHQL_URL?.trim() || DEFAULT_GRAPHQL_URL[SUI_NETWORK];

export class SuiGraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuiGraphQLError";
  }
}

const EVENT_NODE_FIELDS = `
  timestamp
  sender { address }
  transaction { digest }
  transactionModule { package { address } name }
  contents { type { repr } json }
`;

/**
 * Sui's GraphQL rejects any page over 50 with a validation error, so a caller
 * asking for more must page rather than ask louder. Five pages did ask louder
 * — history, merchant history, verify, the merchant profile and post-signin,
 * at 100 or 200 — and every one of them failed outright with
 * "Page size is too large: 100 > 50", which surfaced as a permanent spinner.
 */
const MAX_PAGE_SIZE = 50;

const EVENTS_BY_TYPE = `
  query EventsByType($type: String!, $last: Int!, $before: String) {
    events(last: $last, before: $before, filter: { type: $type }) {
      pageInfo { hasPreviousPage startCursor }
      nodes { ${EVENT_NODE_FIELDS} }
    }
  }
`;

const EVENTS_PAGE = `
  query EventsPage($type: String!, $first: Int!, $after: String) {
    events(first: $first, after: $after, filter: { type: $type }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${EVENT_NODE_FIELDS} }
    }
  }
`;

interface GraphQLEventNode {
  timestamp: string | null;
  sender: { address: string } | null;
  transaction: { digest: string } | null;
  transactionModule: { package: { address: string } | null; name: string } | null;
  contents: { type: { repr: string }; json: unknown } | null;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(SUI_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new SuiGraphQLError(`events query failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new SuiGraphQLError(body.errors.map((e) => e.message).join("; "));
  }
  if (!body.data) throw new SuiGraphQLError("empty GraphQL response");
  return body.data;
}

function toQuayEvent(n: GraphQLEventNode): QuayEvent {
  return {
    type: n.contents?.type?.repr ?? "",
    parsedJson: n.contents?.json ?? null,
    txDigest: n.transaction?.digest ?? null,
    sender: n.sender?.address ?? null,
    // GraphQL returns an ISO timestamp; callers expect epoch millis.
    timestampMs: n.timestamp ? String(Date.parse(n.timestamp)) : null,
    emittingPackage: n.transactionModule?.package?.address ?? null,
  };
}

/**
 * Most recent events of a Move type, newest first.
 *
 * GraphQL paginates from the end with `last`, which is what "newest N" means
 * here; the result is reversed so callers keep the descending order the old
 * `order: "descending"` gave them.
 *
 * Walks backwards in pages of at most `MAX_PAGE_SIZE`, so `limit` is a request
 * for how many events the caller wants rather than a page size they have to
 * know the server's cap for. Each page arrives oldest-first and every
 * subsequent page is older still, hence the prepend and the single reverse at
 * the end.
 */
interface EventsByTypeResponse {
  events?: {
    pageInfo?: { hasPreviousPage: boolean; startCursor: string | null };
    nodes?: GraphQLEventNode[];
  };
}

export async function queryEventsByType(
  eventType: string,
  limit = 50,
): Promise<QuayEvent[]> {
  const collected: GraphQLEventNode[] = [];
  let before: string | null = null;

  while (collected.length < limit) {
    const data: EventsByTypeResponse = await graphql<EventsByTypeResponse>(
      EVENTS_BY_TYPE,
      {
        type: eventType,
        last: Math.min(MAX_PAGE_SIZE, limit - collected.length),
        before,
      },
    );

    const nodes = data.events?.nodes ?? [];
    // An empty page with hasPreviousPage still set would otherwise spin here.
    if (nodes.length === 0) break;
    collected.unshift(...nodes);

    const pageInfo = data.events?.pageInfo;
    if (!pageInfo?.hasPreviousPage || !pageInfo.startCursor) break;
    before = pageInfo.startCursor;
  }

  return collected.map(toQuayEvent).reverse();
}

export interface EventPage {
  events: QuayEvent[];
  endCursor: string | null;
  hasNextPage: boolean;
}

/**
 * One page of events of a type, **oldest first**, for cursor-driven indexing.
 * `after` is the opaque `endCursor` from the previous page; pass `null` to
 * start from the beginning of the type's history.
 */
export async function queryEventsPageAscending(
  eventType: string,
  first: number,
  after: string | null,
): Promise<EventPage> {
  const data = await graphql<{
    events?: {
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      nodes?: GraphQLEventNode[];
    };
  }>(EVENTS_PAGE, {
    type: eventType,
    first: Math.min(first, MAX_PAGE_SIZE),
    after,
  });
  return {
    events: (data.events?.nodes ?? []).map(toQuayEvent),
    endCursor: data.events?.pageInfo?.endCursor ?? null,
    hasNextPage: data.events?.pageInfo?.hasNextPage ?? false,
  };
}

/**
 * Package that emitted the most recent event of a type.
 *
 * Used to notice Scallop protocol upgrades. Note this is genuinely the
 * *emitting* package, which is not always the protocol package: a wrapper
 * contract calling Scallop emits the same event type under its own address,
 * which is exactly the facade case that once broke redeem routing. Callers
 * must validate the result exposes the modules they intend to call.
 */
export async function latestEmittingPackage(eventType: string): Promise<string | null> {
  const events = await queryEventsByType(eventType, 1);
  return events[0]?.emittingPackage ?? null;
}

/**
 * Every event emitted by one transaction, via gRPC. Returns `[]` rather than
 * throwing when the digest is unknown — fullnodes prune transaction history,
 * so "not found" is an expected answer for anything old, not an error.
 */
export async function eventsForTransaction(
  client: SuiClient,
  txDigest: string,
): Promise<QuayEvent[]> {
  try {
    const res = await client.getTransaction({
      digest: txDigest,
      include: { events: true },
    });
    const tx = res.Transaction;
    if (!tx?.events) return [];
    return tx.events.map((e) => ({
      type: e.eventType,
      parsedJson: e.json ?? null,
      txDigest,
      sender: e.sender ?? null,
      timestampMs: null,
      emittingPackage: e.packageId ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * Coerce a Move `vector<u8>` field out of an event's JSON, whichever
 * transport produced it: JSON-RPC gave `number[]`, GraphQL gives base64, and
 * a hex string shows up occasionally too. Returns `null` when the field is
 * absent or unrecognisable rather than guessing.
 */
export function bytesFromEventField(value: unknown): Uint8Array | null {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === "string") {
    // Hex, only when unambiguous (0x-prefixed or an even run of hex digits
    // that is not valid base64 padding-wise).
    if (/^0x[0-9a-fA-F]+$/.test(value)) {
      const hex = value.slice(2);
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return out;
    }
    try {
      const bin = atob(value);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }
  return null;
}
