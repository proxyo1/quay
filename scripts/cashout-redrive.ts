/**
 * Cash-out re-drive — recover stranded cash-out rows (D3).
 *
 * When a merchant's USDsui has landed in the treasury but the Wise SGD
 * payout didn't complete (row stuck in `received`/`paying`/`failed` with a
 * `sui_digest`), this re-attempts the payout. The Wise transfer is
 * idempotent on `customerTransactionId = sui_digest`, so re-driving a row
 * whose transfer already exists is safe.
 *
 * Standalone (scripts/ package): talks to Supabase PostgREST + Wise REST
 * directly so it doesn't need the frontend's server-only modules. Reads
 * env from scripts/.env.local (bun auto-loads):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, WISE_API_TOKEN, WISE_ENV(=sandbox)
 *
 * DRY-RUN by default. Pass --execute to actually move money.
 *   cd scripts && bun run cashout-redrive.ts            # report only
 *   cd scripts && bun run cashout-redrive.ts --execute  # re-drive payouts
 */

const EXECUTE = process.argv.includes("--execute");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WISE_TOKEN = process.env.WISE_API_TOKEN;
const WISE_BASE =
  process.env.WISE_API_BASE ??
  ((process.env.WISE_ENV ?? "sandbox").toLowerCase() === "live"
    ? "https://api.transferwise.com"
    : "https://api.sandbox.transferwise.tech");

interface CashoutRow {
  id: string;
  owner: string;
  net_sgd_minor: string;
  recipient: { type: string; details: Record<string, string> };
  sui_digest: string | null;
  wise_transfer_id: string | null;
  status: string;
  created_at: string;
}

async function sb(path: string, init?: RequestInit) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY!,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Supabase ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return body;
}

async function wise<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${WISE_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${WISE_TOKEN}`,
      "Content-Type": "application/json",
      "Accept-Minor-Version": "1",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Wise ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return parsed as T;
}

function holderName(r: CashoutRow): string {
  const d = r.recipient.details ?? {};
  return d.accountHolderName || d.name || d.legalName || "Quay Merchant";
}

async function payOut(r: CashoutRow): Promise<string> {
  const profiles = await wise<Array<{ id: number; type: string }>>("GET", "/v1/profiles");
  const profileId = (profiles.find((p) => p.type === "personal") ?? profiles[0]).id;
  const quote = await wise<{ id: string }>("POST", `/v3/profiles/${profileId}/quotes`, {
    sourceCurrency: "SGD",
    targetCurrency: "SGD",
    targetAmount: Number(BigInt(r.net_sgd_minor)) / 100,
    payOut: "BANK_TRANSFER",
  });
  const acct = await wise<{ id: number }>("POST", "/v1/accounts", {
    currency: "SGD",
    type: r.recipient.type,
    profile: profileId,
    accountHolderName: holderName(r),
    details: r.recipient.details,
  });
  const transfer = await wise<{ id: number }>("POST", "/v1/transfers", {
    targetAccount: acct.id,
    quoteUuid: quote.id,
    customerTransactionId: r.sui_digest, // idempotent: one payout per transfer
    details: { reference: "Quay cash-out" },
  });
  await wise(
    "POST",
    `/v3/profiles/${profileId}/transfers/${transfer.id}/payments`,
    { type: "BALANCE" },
  );
  return String(transfer.id);
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("✗ SUPABASE_URL / SUPABASE_SERVICE_KEY not set");
    process.exit(1);
  }
  if (EXECUTE && !WISE_TOKEN) {
    console.error("✗ WISE_API_TOKEN not set (required with --execute)");
    process.exit(1);
  }
  console.log(`Cash-out re-drive (${EXECUTE ? "EXECUTE" : "dry-run"}, wise=${WISE_BASE})\n`);

  const rows = (await sb(
    "cashout_requests?status=in.(received,paying,failed)&sui_digest=not.is.null&order=created_at.asc",
  )) as CashoutRow[];

  if (rows.length === 0) {
    console.log("✓ no stranded rows to re-drive");
    return;
  }
  console.log(`${rows.length} stranded row(s):`);
  for (const r of rows) {
    console.log(`  • ${r.id}  status=${r.status}  net=S$${(Number(BigInt(r.net_sgd_minor)) / 100).toFixed(2)}  digest=${r.sui_digest?.slice(0, 10)}…`);
    if (!EXECUTE) continue;
    try {
      const transferId = await payOut(r);
      await sb(`cashout_requests?id=eq.${r.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "paid_out", wise_transfer_id: transferId, paid_out_at: new Date().toISOString() }),
      });
      console.log(`    ✓ paid out (wise transfer ${transferId})`);
    } catch (e) {
      console.error(`    ✗ ${e instanceof Error ? e.message : e}`);
    }
  }
  if (!EXECUTE) console.log("\n(dry-run — re-run with --execute to pay out)");
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
