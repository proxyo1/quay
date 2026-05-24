/**
 * Wise payout-capability probe — READ ONLY, no money moved.
 *
 * Answers: "what can I pay SGD to — bank account, PayNow, ...?" by asking
 * Wise directly instead of guessing. Steps:
 *   1. GET  /v1/profiles                              (find personal profile)
 *   2. POST /v3/profiles/{id}/quotes  USD->SGD        (free, expires, no commit)
 *   3. GET  /v1/quotes/{quoteId}/account-requirements (the recipient types)
 *
 * Prints every payout "type" Wise offers for SGD and its required fields,
 * and flags PayNow support explicitly.
 *
 * Token comes from scripts/.env.local (gitignored). No funding required.
 * Run: cd scripts && bun run wise-payout-probe.ts
 */

const TOKEN = process.env.WISE_API_TOKEN;
const ENV = (process.env.WISE_ENV ?? "live").toLowerCase();
const BASE =
  process.env.WISE_API_BASE ??
  (ENV === "sandbox"
    ? "https://api.sandbox.transferwise.tech"
    : "https://api.transferwise.com");

async function wise(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Accept-Minor-Version": "1",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw */
  }
  return { status: res.status, body: parsed };
}

async function main() {
  if (!TOKEN) {
    console.error("✗ WISE_API_TOKEN not set in scripts/.env.local");
    process.exit(1);
  }
  console.log(`Wise payout probe (env=${ENV}, base=${BASE})\n`);

  // 1. Profile
  const profiles = await wise("GET", "/v1/profiles");
  if (profiles.status !== 200 || !Array.isArray(profiles.body)) {
    console.error(`✗ /v1/profiles -> ${profiles.status}: ${JSON.stringify(profiles.body)}`);
    process.exit(1);
  }
  const profile =
    profiles.body.find((p: any) => p.type === "personal") ?? profiles.body[0];
  console.log(`profile: id=${profile.id} type=${profile.type}\n`);

  // 2. Quote USD -> SGD (free, non-committal)
  console.log("→ POST /v3/profiles/{id}/quotes  (USD → SGD, target 10 SGD)");
  const quote = await wise("POST", `/v3/profiles/${profile.id}/quotes`, {
    sourceCurrency: "USD",
    targetCurrency: "SGD",
    targetAmount: 10,
  });
  console.log(`  status ${quote.status}`);
  if (quote.status !== 200 && quote.status !== 201) {
    console.error(`✗ quote failed: ${JSON.stringify(quote.body).slice(0, 600)}`);
    process.exit(1);
  }
  const q = quote.body;
  console.log(`  quoteId: ${q.id}`);
  console.log(`  rate:    ${q.rate}`);
  if (Array.isArray(q.paymentOptions)) {
    const payouts = [...new Set(q.paymentOptions.map((o: any) => o.payOut))];
    console.log(`  payOut options seen on quote: ${payouts.join(", ")}`);
  }
  console.log("");

  // 3. Account requirements = the recipient types you can pay SGD to
  console.log(`→ GET /v1/quotes/${q.id}/account-requirements`);
  const reqs = await wise("GET", `/v1/quotes/${q.id}/account-requirements`);
  console.log(`  status ${reqs.status}`);
  if (reqs.status !== 200 || !Array.isArray(reqs.body)) {
    console.error(`✗ account-requirements: ${JSON.stringify(reqs.body).slice(0, 600)}`);
    process.exit(1);
  }

  console.log(`\n  SGD payout types Wise offers (${reqs.body.length}):`);
  let paynow: any = null;
  for (const r of reqs.body) {
    const flag = /paynow/i.test(`${r.type} ${r.title}`) ? "  ← PayNow" : "";
    console.log(`    • type="${r.type}"  title="${r.title}"${flag}`);
    if (/paynow/i.test(`${r.type} ${r.title}`)) paynow = r;
  }

  console.log("\n" + "─".repeat(60));
  if (paynow) {
    console.log(`✓ PayNow IS supported. type="${paynow.type}". Required fields:`);
    for (const f of paynow.fields ?? []) {
      for (const g of f.group ?? []) {
        console.log(`    - ${g.key} (${g.type})  "${g.name}"  required=${g.required}`);
      }
    }
  } else {
    console.log("✗ No PayNow type in this quote's requirements.");
    console.log("  SGD payout here is via the bank-account type(s) listed above.");
    console.log("  (PayNow may be a separate payOut/region setting — worth a docs check.)");
  }
}

main().catch((e) => {
  console.error("✗ Request failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
