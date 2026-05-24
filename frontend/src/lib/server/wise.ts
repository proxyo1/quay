import "server-only";

/**
 * Wise (TransferWise) payout client — SANDBOX by default.
 *
 * This drives the SGD payout leg of the manual cash-out demo: quote ->
 * recipient -> transfer -> fund, paying SGD out of a pre-funded Wise SGD
 * balance to the merchant's supplied bank/PayNow. It does NOT convert
 * crypto (Wise can't); the USDsui->treasury leg happens on-chain first.
 *
 * Env:
 *   WISE_API_TOKEN   — required. A sandbox token by default.
 *   WISE_ENV         — "sandbox" (default) | "live". `live` is a deliberate
 *                      opt-in; the demo never needs it.
 *   WISE_API_BASE    — optional explicit base override.
 *
 * Server-only. The token moves real (or sandbox) money — never expose it
 * to a client component.
 *
 * Factored from scripts/wise-payout-probe.ts so the probe + this client
 * share one implementation (DRY).
 */

export class WiseError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "WiseError";
  }
}

function env() {
  const token = process.env.WISE_API_TOKEN;
  if (!token) throw new WiseError("WISE_API_TOKEN not set", 500, null);
  const mode = (process.env.WISE_ENV ?? "sandbox").toLowerCase();
  const base =
    process.env.WISE_API_BASE ??
    (mode === "live"
      ? "https://api.transferwise.com"
      : "https://api.sandbox.transferwise.tech");
  return { token, mode, base };
}

/** True when this client is pointed at a live (real-money) Wise account. */
export function isLiveWise(): boolean {
  return (process.env.WISE_ENV ?? "sandbox").toLowerCase() === "live";
}

async function wiseRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const { token, base } = env();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept-Minor-Version": "1",
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw text */
  }
  if (!res.ok) {
    throw new WiseError(`Wise ${method} ${path} -> ${res.status}`, res.status, parsed);
  }
  return parsed as T;
}

interface WiseProfile {
  id: number;
  type: string;
}

/** The token's personal profile id (the demo funds payouts from it). */
export async function getPersonalProfileId(): Promise<number> {
  const profiles = await wiseRequest<WiseProfile[]>("GET", "/v1/profiles");
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new WiseError("no Wise profiles on this token", 500, profiles);
  }
  const personal = profiles.find((p) => p.type === "personal") ?? profiles[0];
  return personal.id;
}

export interface WiseQuote {
  id: string;
  rate: number;
  sourceCurrency: string;
  targetCurrency: string;
}

/**
 * Create a same-currency SGD payout quote (no FX — the float is already SGD).
 * `targetMinor` is SGD cents; Wise wants a major-unit decimal.
 */
export async function createSgdQuote(
  profileId: number,
  targetMinor: bigint,
): Promise<WiseQuote> {
  const targetAmount = Number(targetMinor) / 100;
  return wiseRequest<WiseQuote>("POST", `/v3/profiles/${profileId}/quotes`, {
    sourceCurrency: "SGD",
    targetCurrency: "SGD",
    targetAmount,
    payOut: "BANK_TRANSFER",
  });
}

export interface WiseAccountRequirement {
  type: string;
  title: string;
  fields: Array<{
    group: Array<{
      key: string;
      name: string;
      type: string;
      required: boolean;
      example?: string;
      validationRegexp?: string;
      /** Present for `type: "select"` fields (e.g. legalType Person/Business). */
      valuesAllowed?: Array<{ key: string; name: string }> | null;
    }>;
  }>;
}

/** The recipient-field schema for a quote — drives the UI form. */
export async function getAccountRequirements(
  quoteId: string,
): Promise<WiseAccountRequirement[]> {
  return wiseRequest<WiseAccountRequirement[]>(
    "GET",
    `/v1/quotes/${quoteId}/account-requirements`,
  );
}

export interface CreateRecipientInput {
  profileId: number;
  /** Account-requirement `type`, e.g. "singapore" or "paynow". */
  type: string;
  accountHolderName: string;
  /** Field key -> value, matching the account-requirements schema. */
  details: Record<string, string>;
}

/** Create the payout recipient. Returns the recipient (target account) id. */
export async function createRecipient(input: CreateRecipientInput): Promise<number> {
  const acct = await wiseRequest<{ id: number }>("POST", "/v1/accounts", {
    currency: "SGD",
    type: input.type,
    profile: input.profileId,
    accountHolderName: input.accountHolderName,
    details: input.details,
  });
  return acct.id;
}

export interface CreateTransferInput {
  profileId: number;
  quoteId: string;
  targetAccountId: number;
  /** Idempotency key — we pass the Sui tx digest so a retry never double-pays. */
  customerTransactionId: string;
  reference?: string;
}

/** Create the transfer (not yet funded). */
export async function createTransfer(input: CreateTransferInput): Promise<{ id: number }> {
  return wiseRequest<{ id: number }>("POST", "/v1/transfers", {
    targetAccount: input.targetAccountId,
    quoteUuid: input.quoteId,
    customerTransactionId: input.customerTransactionId,
    details: { reference: (input.reference ?? "Quay cash-out").slice(0, 35) },
  });
}

/** Fund the transfer from the Wise SGD balance (the pre-funded float). */
export async function fundTransfer(
  profileId: number,
  transferId: number,
): Promise<{ status: string }> {
  return wiseRequest<{ status: string }>(
    "POST",
    `/v3/profiles/${profileId}/transfers/${transferId}/payments`,
    { type: "BALANCE" },
  );
}
