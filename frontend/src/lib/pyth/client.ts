/**
 * Pyth Hermes HTTP client. Off-chain price fetch. On-chain Pyth price-info
 * objects are read inside the swap PTB on Day 5+.
 */

export interface PythPrice {
  /** 0x-prefixed feed ID. */
  feedId: string;
  /** Decoded price as a JS number. Computed as `parseFloat(price) * 10^expo`. */
  price: number;
  /** Confidence interval as a JS number. */
  conf: number;
  /** Unix seconds when this price was published by Pyth. */
  publishTime: number;
  /** Pyth-side exponent (typically -8 for crypto, -5 for FX). */
  expo: number;
  /** Raw integer price string from Hermes (preserved for on-chain submission). */
  rawPrice: string;
  /** Raw integer conf string. */
  rawConf: string;
}

const HERMES_DEFAULT = "https://hermes.pyth.network";

export interface FetchOptions {
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Fetch the latest prices for a set of Pyth feed IDs from Hermes.
 *
 * Hermes endpoint shape:
 *   GET /v2/updates/price/latest?ids[]=0x...&ids[]=0x...
 * Response:
 *   { binary: { ... }, parsed: [ { id, price: { price, conf, expo, publish_time }, ... } ] }
 */
export async function fetchLatestPrices(
  feedIds: readonly string[],
  options: FetchOptions = {},
): Promise<Map<string, PythPrice>> {
  if (feedIds.length === 0) return new Map();

  const baseUrl = options.baseUrl ?? HERMES_DEFAULT;
  const params = feedIds.map((id) => `ids[]=${encodeURIComponent(id)}`).join("&");
  const url = `${baseUrl}/v2/updates/price/latest?${params}`;

  const controller = new AbortController();
  const signals: AbortSignal[] = [controller.signal];
  if (options.signal) signals.push(options.signal);
  const timeout = options.timeoutMs ?? 8000;
  const timer = setTimeout(() => controller.abort(), timeout);

  let res: Response;
  try {
    res = await fetch(url, { signal: signals[0] });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Hermes HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { parsed?: Array<HermesParsedEntry> };
  const out = new Map<string, PythPrice>();
  for (const entry of data.parsed ?? []) {
    const normalized = normalizeFeedId(entry.id);
    out.set(normalized, decodePrice(normalized, entry));
  }
  return out;
}

interface HermesParsedEntry {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}

/** Hermes returns feed IDs without a 0x prefix; our constants include it. Normalize. */
function normalizeFeedId(id: string): string {
  if (id.startsWith("0x") || id.startsWith("0X")) return id.toLowerCase();
  return ("0x" + id).toLowerCase();
}

function decodePrice(feedId: string, entry: HermesParsedEntry): PythPrice {
  const { price, conf, expo, publish_time } = entry.price;
  const scale = Math.pow(10, expo);
  return {
    feedId,
    price: parseFloat(price) * scale,
    conf: parseFloat(conf) * scale,
    publishTime: publish_time,
    expo,
    rawPrice: price,
    rawConf: conf,
  };
}

/** Returns seconds since this price was published. */
export function priceAgeSeconds(p: PythPrice, nowMs = Date.now()): number {
  return Math.max(0, Math.floor(nowMs / 1000) - p.publishTime);
}

/** Heuristic: a Pyth price is "stale" if it hasn't updated in N seconds.
 *  TEMP (Demo Day): widened 60s → 96h so the weekend-stale USD/SGD FX feed
 *  (forex closes Fri–Sun) doesn't disable the Pay button during the live
 *  Sunday-morning demo. Revert to 60 after Demo Day. */
export const STALE_THRESHOLD_SECONDS = 60 * 60 * 96;
export function isStale(p: PythPrice, nowMs = Date.now()): boolean {
  return priceAgeSeconds(p, nowMs) > STALE_THRESHOLD_SECONDS;
}
