/**
 * Wise (TransferWise) API connectivity smoke test.
 *
 * Proves a Wise API token authenticates and the payout-relevant read
 * endpoints respond — WITHOUT moving any money. Hits, in order:
 *   GET /v1/profiles                          the canonical auth check
 *   GET /v4/profiles/{id}/balances            per profile (best-effort,
 *                                             falls back to /v3)
 *
 * A personal-account token created at wise.com -> Settings -> API tokens
 * is a LIVE token, so these are live reads of your own account only.
 *
 * The token never touches source or argv. Put it in scripts/.env.local
 * (gitignored, Bun auto-loads it from the cwd):
 *   WISE_API_TOKEN=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *   # WISE_ENV=sandbox            optional, default "live"
 *   # WISE_API_BASE=https://...   optional explicit base override
 *
 * Run from the scripts dir so .env.local is picked up:
 *   cd scripts && bun run wise-smoke.ts
 */

const TOKEN = process.env.WISE_API_TOKEN;
const ENV = (process.env.WISE_ENV ?? "live").toLowerCase();
const BASE =
  process.env.WISE_API_BASE ??
  (ENV === "sandbox"
    ? "https://api.sandbox.transferwise.tech"
    : "https://api.transferwise.com");

function mask(t: string): string {
  return t.length <= 8 ? "****" : `${t.slice(0, 4)}…${t.slice(-4)}`;
}

async function wiseGet(
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* leave body as raw text */
  }
  return { status: res.status, body };
}

interface WiseProfile {
  id: number;
  type: string;
  fullName?: string;
  details?: { name?: string; firstName?: string; lastName?: string };
}

async function main() {
  if (!TOKEN) {
    console.error("✗ WISE_API_TOKEN is not set.");
    console.error("  Create scripts/.env.local containing:");
    console.error("    WISE_API_TOKEN=<your wise api token>");
    process.exit(1);
  }

  console.log("Wise smoke test");
  console.log(`  env:   ${ENV}`);
  console.log(`  base:  ${BASE}`);
  console.log(`  token: ${mask(TOKEN)}`);
  console.log("");

  // 1. Profiles — the definitive "am I authenticated" check.
  console.log("→ GET /v1/profiles");
  const profiles = await wiseGet("/v1/profiles");
  console.log(`  status ${profiles.status}`);

  if (profiles.status === 401 || profiles.status === 403) {
    console.error("✗ Auth rejected by Wise.");
    console.error(
      "  • Sandbox token? Re-run with WISE_ENV=sandbox (different base URL).",
    );
    console.error("  • Live token? Check it wasn't revoked or expired.");
    console.error(`  • Body: ${JSON.stringify(profiles.body)}`);
    process.exit(1);
  }
  if (profiles.status !== 200 || !Array.isArray(profiles.body)) {
    console.error(
      `✗ Unexpected response: ${JSON.stringify(profiles.body).slice(0, 500)}`,
    );
    process.exit(1);
  }

  const list = profiles.body as WiseProfile[];
  console.log(`✓ Authenticated. ${list.length} profile(s):`);
  for (const p of list) {
    const name =
      p.fullName ??
      p.details?.name ??
      [p.details?.firstName, p.details?.lastName].filter(Boolean).join(" ") ??
      "(no name)";
    console.log(`    • id=${p.id}  type=${p.type}  ${name}`);
  }
  console.log("");

  // 2. Balances per profile — shows the payout funding source.
  //    Best-effort: v4 first, fall back to v3, never fail the test on it.
  for (const p of list) {
    let bal = await wiseGet(`/v4/profiles/${p.id}/balances?types=STANDARD`);
    if (bal.status === 404) {
      bal = await wiseGet(`/v3/profiles/${p.id}/balances?types=STANDARD`);
    }
    console.log(`→ balances for profile ${p.id} — status ${bal.status}`);
    if (bal.status === 200 && Array.isArray(bal.body)) {
      const balances = bal.body as Array<{
        currency: string;
        amount?: { value: number };
      }>;
      if (balances.length === 0) console.log("    (no balances held)");
      for (const b of balances) {
        console.log(`    • ${b.currency}: ${b.amount?.value ?? "?"}`);
      }
    } else {
      console.log(`    (skipped — ${JSON.stringify(bal.body).slice(0, 200)})`);
    }
  }
  console.log("");
  console.log("✓ Wise API reachable and authenticated. No money was moved.");
}

main().catch((e) => {
  console.error("✗ Request failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
