/**
 * Event queries.
 *
 * These go to Sui's GraphQL endpoint while the rest of the app reads state
 * over gRPC. That split is deliberate, and the reason is **retention**, not
 * capability:
 *
 *   gRPC *can* query events — `client.listEvents()` maps to
 *   `LedgerService.ListEvents` and works fine. What it can't do is remember
 *   very far back. A fullnode serves only its own retention window and there
 *   is no implicit archival fallback, so old events simply aren't there.
 *
 * Measured on mainnet 2026-08-12, asking both transports for every
 * `payments::PaymentReceipt` ever emitted:
 *
 *   - gRPC    → 1 event   (oldest retained checkpoint of any event: 301811060)
 *   - GraphQL → 4 events  (reaching back to checkpoint 299937158, 2026-07-18)
 *
 * Three of Quay's four mainnet payments are older than the gRPC fullnode's
 * pruning floor. Moving these queries to gRPC therefore does not fail — it
 * silently returns a shorter history. If you are here because the migration
 * guide maps `suix_queryEvents` to `LedgerService.ListEvents` and this looked
 * like unfinished work: it isn't, and switching it drops payment history with
 * no error to notice.
 *
 * Neither window is unbounded. GraphQL's is merely larger, so history that has
 * to survive indefinitely needs the Archival Service or our own index — never
 * a public endpoint. This is the same reason state is always read from the
 * chain rather than reconstructed by replaying events.
 *
 * Two access patterns, deliberately served differently:
 *
 *  - **by type** (`queryEventsByType`) → GraphQL, per the above.
 *  - **by transaction** (`eventsForTransaction`) → gRPC `getTransaction` with
 *    `include: { events: true }`. The event filter accepts exactly one of
 *    `sender`, `emitModule` or `eventType` — there is no digest filter — and
 *    asking the transaction for its own events is a cheaper question anyway.
 *
 * Transport plumbing (query text, cursor direction, response shape) is the
 * SDK's `listEvents`, which presents one interface over gRPC and GraphQL
 * alike. The one thing it does *not* absorb is the server's page cap: on
 * GraphQL a `limit` above 50 throws `Page size is too large`, so the paging
 * loop below stays.
 */

import { SuiGraphQLClient } from "@mysten/sui/graphql";

import { SUI_NETWORK } from "@/lib/sui-config";
import type { SuiClient } from "@/lib/sui-client";

/**
 * Normalised event.
 *
 * Deliberately has no timestamp. The SDK's event shape carries `checkpoint`
 * but not a wall-clock time, and nothing needs one: every screen that shows a
 * payment time reads `timestamp_ms` out of the receipt payload itself, which
 * is the on-chain value and the one that belongs on a receipt.
 */
export interface QuayEvent {
  type: string;
  parsedJson: unknown;
  txDigest: string | null;
  sender: string | null;
  /** Address of the package whose module emitted this event, when known. */
  emittingPackage: string | null;
}

const DEFAULT_GRAPHQL_URL: Record<"mainnet" | "testnet", string> = {
  mainnet: "https://graphql.mainnet.sui.io/graphql",
  testnet: "https://graphql.testnet.sui.io/graphql",
};

export const SUI_GRAPHQL_URL =
  process.env.NEXT_PUBLIC_SUI_GRAPHQL_URL?.trim() || DEFAULT_GRAPHQL_URL[SUI_NETWORK];

/**
 * Sui's GraphQL rejects any page over 50 with a validation error, so a caller
 * asking for more must page rather than ask louder. Five pages did ask louder
 * — history, merchant history, verify, the merchant profile and post-signin,
 * at 100 or 200 — and every one of them failed outright with
 * "Page size is too large: 100 > 50", which surfaced as a permanent spinner.
 * The SDK passes `limit` through untouched and the server still throws, so
 * this cap is ours to respect.
 */
const MAX_PAGE_SIZE = 50;

/** Shared client; stateless with respect to callers, so one is enough. */
let graphqlClient: SuiGraphQLClient | undefined;
function getGraphQLClient(): SuiGraphQLClient {
  graphqlClient ??= new SuiGraphQLClient({
    url: SUI_GRAPHQL_URL,
    network: SUI_NETWORK,
  });
  return graphqlClient;
}

/** The slice of the SDK's event shape this module depends on. */
interface SdkEvent {
  eventType: string;
  json: Record<string, unknown> | null;
  transactionDigest: string;
  sender: string;
  packageId: string;
}

function toQuayEvent(e: SdkEvent): QuayEvent {
  return {
    type: e.eventType,
    parsedJson: e.json ?? null,
    txDigest: e.transactionDigest ?? null,
    sender: e.sender ?? null,
    emittingPackage: e.packageId ?? null,
  };
}

/**
 * Most recent events of a Move type, newest first.
 *
 * Walks backwards in pages of at most `MAX_PAGE_SIZE`, so `limit` is a request
 * for how many events the caller wants rather than a page size they have to
 * know the server's cap for. `before` continues a descending walk, each page
 * older than the last.
 */
export async function queryEventsByType(
  eventType: string,
  limit = 50,
): Promise<QuayEvent[]> {
  const client = getGraphQLClient();
  const collected: QuayEvent[] = [];
  let before: string | null = null;

  while (collected.length < limit) {
    const page = await client.listEvents({
      filter: { eventType },
      limit: Math.min(MAX_PAGE_SIZE, limit - collected.length),
      order: "descending",
      before,
    });

    // An empty page with hasNextPage still set would otherwise spin here.
    if (page.events.length === 0) break;
    collected.push(...page.events.map(toQuayEvent));

    if (!page.hasNextPage || !page.endCursor) break;
    before = page.endCursor;
  }

  return collected;
}

export interface EventPage {
  events: QuayEvent[];
  endCursor: string | null;
  hasNextPage: boolean;
}

/**
 * One page of events of a type, **oldest first**, for cursor-driven indexing.
 * `after` is the opaque `endCursor` from the previous page; pass `null` to
 * start from the beginning of the type's retained history.
 */
export async function queryEventsPageAscending(
  eventType: string,
  first: number,
  after: string | null,
): Promise<EventPage> {
  const page = await getGraphQLClient().listEvents({
    filter: { eventType },
    limit: Math.min(first, MAX_PAGE_SIZE),
    order: "ascending",
    after,
  });
  return {
    events: page.events.map(toQuayEvent),
    endCursor: page.endCursor,
    hasNextPage: page.hasNextPage,
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
      emittingPackage: e.packageId ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * Coerce a Move `vector<u8>` field out of an event's JSON. The SDK also hands
 * back the event's raw `bcs`, which is the more reliable source, but callers
 * here read the JSON projection — where GraphQL renders `vector<u8>` as base64
 * and a hex string shows up occasionally too. Returns `null` when the field is
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
