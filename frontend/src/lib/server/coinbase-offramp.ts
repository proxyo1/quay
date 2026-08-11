import "server-only";

import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Coinbase CDP Offramp client.
 *
 * Drives the non-custodial cash-out rail: the merchant sells USDC from their
 * own Sui address into their own KYC'd Coinbase account, and Coinbase pays
 * them SGD. Quay mints session tokens and builds the send transaction; it
 * never holds the funds.
 *
 * Everything here was validated against production by
 * `scripts/coinbase-offramp-probe.ts` — there is no offramp sandbox, so the
 * probe's read-only calls are the closest thing to a test environment. Its
 * findings are baked into this file:
 *
 *  - **SG is supported, with `payment_methods = [CRYPTO_ACCOUNT, FIAT_WALLET]`
 *    and no bank rail.** So the merchant is paid into their Coinbase balance,
 *    and moving it to a bank is a manual step they take in Coinbase. Copy must
 *    never imply Quay settles to a bank.
 *  - **`offramp_url` comes back as an empty string.** Not for one request
 *    shape but for every one tried — camelCase and snake_case field names,
 *    with and without a session token, allowlisted and localhost redirects.
 *    So the hosted URL is constructed here rather than read from the quote.
 *  - **`/v3/sell/input` is the live widget path.** v1 `/sell/input` redirects
 *    to sign-in and there is no v3 `/sell/preview`.
 *
 * Server-only: the CDP secret authenticates money movement.
 *
 * Env, in the repo's usual precedence (env → `.secrets` file):
 *   CDP_API_KEY_ID / CDP_API_KEY_SECRET   — read natively by @coinbase/cdp-sdk
 *   .secrets/cdp-mainnet.json             — local-dev fallback
 *
 * Generate an **Ed25519** key in the CDP portal: its secret is single-line
 * base64 and drops into `.env.local` cleanly, whereas a legacy ECDSA key is a
 * multi-line PEM that needs `\n` escaping or it parses wrong.
 */

const HOST = "api.developer.coinbase.com";
const BASE = `https://${HOST}`;

const WIDGET_HOST = "https://pay.coinbase.com";
/** v3 is the live sell widget; v1 `/sell/input` 302s to sign-in. */
const WIDGET_PATH = "/v3/sell/input";

/** Quote endpoints are capped at 10 req/s per app id. */
const QUOTE_RATE_LIMIT_PER_SEC = 10;

export class CoinbaseOfframpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "CoinbaseOfframpError";
    this.status = status;
    this.body = body;
  }
}

// ─── Credentials ────────────────────────────────────────────────────────

interface CdpCredentials {
  apiKeyId: string;
  apiKeySecret: string;
}

let cachedCreds: CdpCredentials | null | undefined;

function loadCredentials(): CdpCredentials | null {
  if (cachedCreds !== undefined) return cachedCreds;

  const id = process.env.CDP_API_KEY_ID;
  const secret = process.env.CDP_API_KEY_SECRET;
  if (id && secret) {
    cachedCreds = { apiKeyId: id, apiKeySecret: secret };
    return cachedCreds;
  }

  try {
    const path = join(process.cwd(), "..", ".secrets", "cdp-mainnet.json");
    const j = JSON.parse(readFileSync(path, "utf8")) as {
      api_key_id?: string;
      api_key_secret?: string;
    };
    if (j.api_key_id && j.api_key_secret) {
      cachedCreds = { apiKeyId: j.api_key_id, apiKeySecret: j.api_key_secret };
      return cachedCreds;
    }
  } catch {
    /* fall through */
  }

  cachedCreds = null;
  return null;
}

/** True when CDP credentials are present — the routes 503 without them. */
export function isCoinbaseConfigured(): boolean {
  return loadCredentials() !== null;
}

// ─── Transport ──────────────────────────────────────────────────────────

let lastQuoteTimes: number[] = [];

/** Space out quote calls to respect the documented 10 req/s app-wide cap. */
async function throttleQuotes(): Promise<void> {
  const now = Date.now();
  lastQuoteTimes = lastQuoteTimes.filter((t) => now - t < 1000);
  if (lastQuoteTimes.length >= QUOTE_RATE_LIMIT_PER_SEC) {
    const waitMs = 1000 - (now - lastQuoteTimes[0]) + 10;
    await new Promise((r) => setTimeout(r, Math.max(waitMs, 10)));
  }
  lastQuoteTimes.push(Date.now());
}

/**
 * Authenticated CDP request.
 *
 * The JWT's `uri` claim is `METHOD host/path` and must NOT include the query
 * string; signing the query is the classic source of an opaque 401 here. The
 * SDK's `generateJwt` handles the claim format, EdDSA-vs-ES256 selection, and
 * the 2-minute max expiry — hand-rolling those is what produces 401s with no
 * usable error body.
 */
async function cdpRequest<T>(
  method: "GET" | "POST",
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; retries?: number } = {},
): Promise<T> {
  const creds = loadCredentials();
  if (!creds) {
    throw new CoinbaseOfframpError("CDP credentials not configured", 500, null);
  }

  const maxAttempts = (opts.retries ?? 2) + 1;
  let lastError: CoinbaseOfframpError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const token = await generateJwt({
      apiKeyId: creds.apiKeyId,
      apiKeySecret: creds.apiKeySecret,
      requestMethod: method,
      requestHost: HOST,
      requestPath: path,
      expiresIn: 120,
    });

    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
    const res = await fetch(`${BASE}${path}${qs}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    const raw = await res.text();
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* keep raw */
    }

    if (res.ok) return parsed as T;

    lastError = new CoinbaseOfframpError(
      `Coinbase ${method} ${path} -> ${res.status}`,
      res.status,
      parsed,
    );

    // Retry only what can plausibly succeed on a second try. A 4xx other than
    // 429 is a request we built wrong; repeating it just burns rate limit.
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === maxAttempts - 1) throw lastError;

    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
  }

  throw lastError ?? new CoinbaseOfframpError("unreachable", 500, null);
}

// ─── API surface ────────────────────────────────────────────────────────

export interface SellConfigCountry {
  id: string;
  payment_methods?: Array<{ id?: string }>;
}

export async function getSellConfig(): Promise<{ countries: SellConfigCountry[] }> {
  return cdpRequest("GET", "/onramp/v1/sell/config");
}

export interface SellOptions {
  cashout_currencies?: Array<{ id?: string }>;
  sell_currencies?: Array<{
    symbol?: string;
    networks?: Array<{ name?: string; contract_address?: string }>;
  }>;
}

export async function getSellOptions(country: string): Promise<SellOptions> {
  return cdpRequest("GET", "/onramp/v1/sell/options", { query: { country } });
}

/**
 * The fiat currency Coinbase pays the merchant in. `COINBASE_CASHOUT_CURRENCY`,
 * defaulting to SGD.
 *
 * Configurable because **SGD's minimum can exceed what an app is allowed to
 * transact.** A CDP app pending full-access review is capped at US$5 per test
 * transaction while Coinbase's SGD floor is S$7 (~US$5.47), so the valid range
 * for a SG merchant is empty and the rail cannot be exercised at all. Every
 * other currency SG offers has a floor near US$2 — USD is min $2 / max $1M —
 * so a single env var is the difference between testable and not.
 *
 * SG is the corridor either way; this changes only the payout leg, and the
 * merchant is paid into the matching balance in their own Coinbase account.
 */
export function cashoutCurrency(): string {
  const raw = process.env.COINBASE_CASHOUT_CURRENCY?.trim().toUpperCase();
  return raw && /^[A-Z]{3}$/.test(raw) ? raw : "SGD";
}

/**
 * Per-address daily cap on cash-out *attempts*, from
 * `COINBASE_OFFRAMP_DAILY_CAP`. **Zero disables it, and zero is the default.**
 *
 * It was a hardcoded 5 and it counted attempts rather than cash-outs, so a
 * merchant retrying after a blocked popup exhausted a day's allowance without
 * ever creating an order. The cap it enforced was Quay's own invention — not a
 * Coinbase limit — and it was the tightest constraint in the system by a wide
 * margin: Coinbase allows a pending-review app 25 test transactions.
 *
 * What still bounds the rail: the per-transaction payout cap
 * (`COINBASE_OFFRAMP_MAX_SGD_MINOR`), the one-open-cash-out-per-owner index,
 * the `coinbase_offramp_enabled` flag, and Coinbase's own limits. Set this to a
 * positive integer to put the daily ceiling back.
 */
export function offrampDailyCap(): number {
  const raw = process.env.COINBASE_OFFRAMP_DAILY_CAP?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Fiat-per-USD ceilings used to turn Coinbase's fiat minimum into a USDsui one.
 *
 * Each is set **above** the plausible market rate on purpose: a higher rate
 * yields a lower USDsui minimum, so the pre-check errs toward letting a
 * marginal amount reach the quote — which is the real gate and returns an exact
 * reason. Getting one wrong costs a clearer error message, never a lost send.
 *
 * A currency missing here skips the pre-check entirely rather than guessing.
 */
const CONSERVATIVE_RATE_PER_USD: Record<string, bigint> = {
  SGD: 140n, // ~1.28 live
  USD: 105n,
  EUR: 100n, // ~0.92 live
  GBP: 85n, //  ~0.79 live
  AUD: 165n, // ~1.55 live
  CAD: 145n, // ~1.38 live
  BRL: 600n, // ~5.50 live
};

/**
 * Smallest USDsui worth quoting for, or null when the currency is unknown.
 *
 * Advisory: the Coinbase quote remains the authority, and a null here just
 * means the merchant learns the minimum from Coinbase instead of from us.
 */
export function minUsdsuiForCashout(
  minFiatMinor: bigint,
  currency: string,
): bigint | null {
  const rate = CONSERVATIVE_RATE_PER_USD[currency.toUpperCase()];
  if (!rate) return null;
  // minFiatMinor is hundredths; USDsui is 6dp. Multiply before dividing.
  return (minFiatMinor * 1_000_000n) / rate;
}

export interface CashoutLimits {
  /** Minimum payout, in fiat minor units (SGD cents). */
  minMinor: bigint;
  /** Maximum payout, in fiat minor units. */
  maxMinor: bigint;
}

/**
 * Published payout limits for a payment method. SGD/FIAT_WALLET read
 * min S$3.00 / max S$1,281,100 when this was written and min S$7.00 /
 * max S$1,279,900 a few months later — hence the live fetch. The max drifts
 * with FX, and the min is Coinbase policy that moves without notice.
 *
 * Worth fetching rather than hardcoding: a sale under the minimum is rejected
 * by `/sell/quote` with a generic `ERROR_CODE_INVALID_REQUEST`, which is far
 * too late and far too vague to show a merchant. These are Coinbase's own
 * numbers, so quoting them back is exact.
 *
 * Cached for an hour — they are effectively static, and this sits on the
 * cash-out path.
 */
const limitsCache = new Map<string, { at: number; value: CashoutLimits | null }>();
const LIMITS_TTL_MS = 60 * 60 * 1000;

export async function getCashoutLimits(input: {
  country?: string;
  currency?: string;
  paymentMethod?: string;
}): Promise<CashoutLimits | null> {
  const country = input.country ?? "SG";
  const currency = input.currency ?? cashoutCurrency();
  const method = input.paymentMethod ?? "FIAT_WALLET";
  const key = `${country}:${currency}:${method}`;

  const hit = limitsCache.get(key);
  if (hit && Date.now() - hit.at < LIMITS_TTL_MS) return hit.value;

  let value: CashoutLimits | null = null;
  try {
    const opts = await getSellOptions(country);
    const cur = (opts.cashout_currencies ?? []).find((c) => c.id === currency) as
      | { limits?: Array<{ id?: string; min?: string; max?: string }> }
      | undefined;
    const lim = cur?.limits?.find((l) => l.id === method);
    if (lim?.min) {
      value = {
        minMinor: decimalToMinor(lim.min, 2),
        maxMinor: lim.max ? decimalToMinor(lim.max, 2) : 0n,
      };
    }
  } catch {
    // Limits are advisory here — a failure must not block a cash-out that
    // would otherwise succeed. The quote call remains the real gate.
    value = null;
  }

  limitsCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Mint a session token for a merchant's Sui address.
 *
 * Single-use and ~5 minutes long, so mint it immediately before opening the
 * widget. A merchant returning after any real absence needs a fresh one.
 */
export async function createSessionToken(input: {
  address: string;
  assets?: string[];
}): Promise<string> {
  const res = await cdpRequest<{ token?: string }>("POST", "/onramp/v1/token", {
    body: {
      addresses: [{ address: input.address, blockchains: ["sui"] }],
      assets: input.assets ?? ["USDC"],
    },
  });
  if (!res.token) {
    throw new CoinbaseOfframpError("session token missing from response", 502, res);
  }
  return res.token;
}

export interface SellQuote {
  quoteId: string;
  /** Fiat the merchant nets, minor units (hundredths of `cashoutCurrency()`). */
  cashoutTotalSgdMinor: bigint;
  /** Coinbase's fee, same minor units. */
  coinbaseFeeSgdMinor: bigint;
  /** USDC being sold, 6dp minor units. */
  sellAmountUsdcMinor: bigint;
  /** The URL Coinbase returned, if it ever starts populating it. */
  returnedOfframpUrl: string | null;
}

interface RawMoney {
  value?: string;
  currency?: string;
}

/** `"12.67"` → `1267n`. Coinbase returns money as decimal strings. */
export function decimalToMinor(value: string | undefined, decimals: number): bigint {
  if (!value) return 0n;
  const [whole, frac = ""] = value.trim().split(".");
  const padded = frac.slice(0, decimals).padEnd(decimals, "0");
  const sign = whole.startsWith("-") ? -1n : 1n;
  const wholeAbs = whole.replace("-", "") || "0";
  return sign * (BigInt(wholeAbs) * 10n ** BigInt(decimals) + BigInt(padded || "0"));
}

export async function createSellQuote(input: {
  sellAmountUsdc: string;
  sourceAddress: string;
  partnerUserRef: string;
  redirectUrl: string;
  sessionToken: string;
  country?: string;
  cashoutCurrency?: string;
  paymentMethod?: string;
}): Promise<SellQuote> {
  await throttleQuotes();
  const res = await cdpRequest<{
    quote_id?: string;
    cashout_total?: RawMoney;
    coinbase_fee?: RawMoney;
    sell_amount?: RawMoney;
    offramp_url?: string;
  }>("POST", "/onramp/v1/sell/quote", {
    body: {
      sell_currency: "USDC",
      sell_network: "sui",
      sell_amount: input.sellAmountUsdc,
      cashout_currency: input.cashoutCurrency ?? cashoutCurrency(),
      // SG offers only CRYPTO_ACCOUNT and FIAT_WALLET; FIAT_WALLET is the
      // "pay me in my Coinbase balance" option.
      payment_method: input.paymentMethod ?? "FIAT_WALLET",
      country: input.country ?? "SG",
      sourceAddress: input.sourceAddress,
      redirectUrl: input.redirectUrl,
      partnerUserRef: input.partnerUserRef,
      sessionToken: input.sessionToken,
    },
  });

  if (!res.quote_id) {
    throw new CoinbaseOfframpError("quote_id missing from response", 502, res);
  }

  return {
    quoteId: res.quote_id,
    cashoutTotalSgdMinor: decimalToMinor(res.cashout_total?.value, 2),
    coinbaseFeeSgdMinor: decimalToMinor(res.coinbase_fee?.value, 2),
    sellAmountUsdcMinor: decimalToMinor(res.sell_amount?.value, 6),
    returnedOfframpUrl: res.offramp_url ? res.offramp_url : null,
  };
}

/**
 * Build the hosted widget URL.
 *
 * `disableEdit` is the load-bearing parameter. Coinbase's input screen is
 * editable by default, so without it a merchant could commit to selling more
 * USDC than they actually freed up — an order Quay then cannot fill, which
 * expires and wastes the redeem.
 *
 * Prefer `returnedOfframpUrl` when Coinbase supplies one; today it never does.
 */
export function buildOfframpUrl(input: {
  sessionToken: string;
  quoteId: string;
  /** USDC amount to lock in, as a decimal string. */
  presetCryptoAmount: string;
  partnerUserId: string;
  redirectUrl: string;
  /** Payout currency; must match the quote or the widget prices differently. */
  cashoutCurrency?: string;
  returnedOfframpUrl?: string | null;
}): string {
  if (input.returnedOfframpUrl) return input.returnedOfframpUrl;

  const u = new URL(`${WIDGET_HOST}${WIDGET_PATH}`);
  u.searchParams.set("sessionToken", input.sessionToken);
  u.searchParams.set("quoteId", input.quoteId);
  u.searchParams.set("defaultAsset", "USDC");
  u.searchParams.set("defaultNetwork", "sui");
  u.searchParams.set("defaultCashoutCurrency", input.cashoutCurrency ?? cashoutCurrency());
  u.searchParams.set("presetCryptoAmount", input.presetCryptoAmount);
  u.searchParams.set("disableEdit", "true");
  u.searchParams.set("partnerUserId", input.partnerUserId);
  // A redirectUrl not on the CDP domain allowlist is silently dropped while
  // the order still completes — so a missing redirect is a config problem to
  // check in the portal, never an error surfaced here.
  u.searchParams.set("redirectUrl", input.redirectUrl);
  return u.toString();
}

// ─── Transaction status ─────────────────────────────────────────────────

export type OfframpTransactionStatus =
  | "created"
  | "pending"
  | "success"
  | "failed"
  | "unknown";

/**
 * Map Coinbase's `TRANSACTION_STATUS_*` enum onto our state machine.
 *
 * Pure and exhaustively tested, because everything downstream — whether we
 * send funds, settle a row, or mark it unmatched — keys off this.
 *
 * `TRANSACTION_STATUS_STARTED` is **not in Coinbase's published enum** but is
 * what the live API actually returns for an order awaiting its deposit —
 * observed on a real mainnet order that sat in it while the USDC was already
 * delivered. It was previously falling through to `unknown`, which the
 * reconcilers ignore, so such a row could never leave `sent`.
 */
export function mapTransactionStatus(raw: string | undefined): OfframpTransactionStatus {
  switch (raw) {
    case "TRANSACTION_STATUS_CREATED":
    case "TRANSACTION_STATUS_STARTED":
      return "created";
    case "TRANSACTION_STATUS_IN_PROGRESS":
    case "TRANSACTION_STATUS_PENDING":
      return "pending";
    case "TRANSACTION_STATUS_SUCCESS":
    case "TRANSACTION_STATUS_COMPLETED":
      return "success";
    case "TRANSACTION_STATUS_FAILED":
      return "failed";
    default:
      return "unknown";
  }
}

export interface OfframpTransaction {
  status: OfframpTransactionStatus;
  /** Deposit address Coinbase issued; absent until the merchant commits. */
  toAddress: string | null;
  /** USDC the merchant must send, 6dp minor units. */
  sellAmountUsdcMinor: bigint;
  asset: string | null;
  network: string | null;
  transactionId: string | null;
  /** Deadline as reported by the API, not a computed +30m. */
  deadlineMs: number | null;
  /** When Coinbase created the record — the only field tying it to an order. */
  createdAtMs: number | null;
}

/** Coinbase is done with these; neither can accept a deposit. */
function isTerminalTransaction(status: OfframpTransactionStatus): boolean {
  return status === "failed" || status === "success";
}

/**
 * Clock-skew allowance when deciding a record was created for *this* order.
 *
 * Coinbase's clock and ours are independent, and the observed gap ran the safe
 * way (their record 4s after our row). This absorbs a small lag in the other
 * direction without widening the window enough to readmit a previous attempt.
 */
const CREATED_SKEW_MS = 30_000;

/**
 * Pick the transaction carrying the deposit address for one specific order.
 *
 * `getUserTransactions` returns the merchant's **whole history**, and the
 * previous implementation took `find(t => t.toAddress)` — the first entry with
 * an address, with nothing tying it to the order being prepared. A dead order
 * from earlier in the day still has an address, so a fresh cash-out bound
 * itself to a Coinbase transaction that had already FAILED and declared itself
 * ready to fund, 1.4 seconds after it was created. Sending against that would
 * have put USDC at a deposit address with no live order behind it — the same
 * loss as the incident it followed, by a different route.
 *
 * Two conditions make an entry usable, and neither is sufficient alone:
 *
 *  - **Still live.** A failed or completed order cannot accept a deposit.
 *  - **Created after our row.** An order that predates the merchant clicking
 *    cannot be the one they just started. This is the binding, because the
 *    transaction list carries no `quote_id` to match on directly.
 *
 * Once the row has committed we know its `transaction_id` and match on that
 * exactly, which is strictly better — but that is only available after the
 * first successful prepare, and this window is the one that was guessing.
 */
export function selectDepositTransaction(
  transactions: OfframpTransaction[],
  opts: { rowCreatedAtMs: number; boundTransactionId: string | null },
): OfframpTransaction | null {
  if (opts.boundTransactionId) {
    const bound = transactions.find((t) => t.transactionId === opts.boundTransactionId);
    // Report a bound-but-dead order as unusable rather than falling back to
    // another record — silently re-binding an order mid-flight is how a
    // merchant ends up funding something they never agreed to.
    if (!bound || isTerminalTransaction(bound.status)) return null;
    return bound.toAddress ? bound : null;
  }

  const floor = opts.rowCreatedAtMs - CREATED_SKEW_MS;
  const candidates = transactions.filter(
    (t) =>
      t.toAddress &&
      !isTerminalTransaction(t.status) &&
      t.createdAtMs !== null &&
      t.createdAtMs >= floor,
  );
  if (candidates.length === 0) return null;
  // Newest wins: a re-quote within one flow leaves the older record behind.
  return candidates.reduce((a, b) => ((b.createdAtMs ?? 0) > (a.createdAtMs ?? 0) ? b : a));
}

/**
 * True while a transaction record exists but the merchant has not committed
 * the order inside the widget.
 *
 * **Coinbase issues `to_address` at quote time, not at commit time.** This was
 * assumed the other way round and it cost a real cash-out: a merchant whose
 * popup was blocked never saw the widget, yet a transaction record appeared
 * four seconds after the quote, carrying a deposit address. The app read that
 * as "committed", offered "one tap to finish", and sent USDC to a deposit
 * address belonging to an order Coinbase had no commitment for. The funds
 * credited the merchant's Coinbase balance as an ordinary deposit, the order
 * sat in `TRANSACTION_STATUS_STARTED` with an empty `tx_hash`, and no SGD was
 * ever paid.
 *
 * The signal used here is the quote-time fingerprint observed live: still in
 * the created/STARTED family AND carrying no deadline. Deliberately narrow —
 * a committed order has never been observed, so anything stricter risks
 * refusing to send on an order that is genuinely ready, which strands the
 * merchant just as badly in the other direction. Tighten this once a
 * successful order shows which field actually flips.
 */
export function isAwaitingCommit(tx: {
  status: OfframpTransactionStatus;
  deadlineMs: number | null;
}): boolean {
  return tx.status === "created" && tx.deadlineMs === null;
}

/**
 * Parse a deadline from whatever field the API supplies. Returns null rather
 * than inventing one — the UI must show Coinbase's clock, and guessing it
 * would let a countdown disagree with the order that is actually expiring.
 */
export function parseDeadlineMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Heuristic: seconds vs millis.
    return raw > 1e11 ? raw : raw * 1000;
  }
  if (typeof raw === "string" && raw.length > 0) {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** Open (or most recent) transaction for a merchant's `partner_user_ref`. */
export async function getUserTransactions(
  partnerUserRef: string,
): Promise<OfframpTransaction[]> {
  const res = await cdpRequest<{
    transactions?: Array<Record<string, unknown>>;
  }>("GET", `/onramp/v1/sell/user/${encodeURIComponent(partnerUserRef)}/transactions`);

  return (res.transactions ?? []).map((t) => ({
    status: mapTransactionStatus(t.status as string | undefined),
    toAddress: (t.to_address as string) ?? null,
    sellAmountUsdcMinor: decimalToMinor(
      (t.sell_amount as RawMoney | undefined)?.value,
      6,
    ),
    asset: (t.asset as string) ?? null,
    network: (t.network as string) ?? null,
    transactionId: (t.transaction_id as string) ?? (t.id as string) ?? null,
    deadlineMs: parseDeadlineMs(t.expires_at ?? t.deadline ?? t.expires_at_ms),
    createdAtMs: parseDeadlineMs(t.created_at),
  }));
}
