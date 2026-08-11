/**
 * Coinbase CDP Offramp feasibility probe — READ ONLY, no money moves.
 *
 * This is the Phase 0 blocking gate for the non-custodial merchant cash-out
 * rail. Five questions the docs cannot answer, in the order that lets us stop
 * as early and as cheaply as possible:
 *
 *   1. GET  /onramp/v1/sell/config              Is `SG` a supported country,
 *                                               and with which payout methods?
 *                                               GO/NO-GO. No SG ⇒ stop.
 *   2. GET  /onramp/v1/sell/options?country=SG  Is `SGD` a cashout currency?
 *   3. same response                            Is `sui` a network for USDC?
 *   4. POST /onramp/v1/token                    Does the session-token API
 *                                               accept a Sui address at all?
 *   5. POST /onramp/v1/sell/quote               Does it return an offramp_url?
 *
 * Checks 1–3 are pure reads. Check 4 mints a session token (single-use,
 * 5-minute expiry) and check 5 asks for a quote — neither commits an order,
 * neither moves funds, and no widget is opened. The one thing this script
 * CANNOT settle from the CLI is whether the widget then issues a real Sui
 * deposit address for a live SG account; that needs a human in the widget.
 *
 * There is no offramp sandbox. These calls hit production with production
 * keys. They are still free and side-effect-free.
 *
 * Credentials, in precedence order (same shape as issuer/sponsor/treasury):
 *   CDP_API_KEY_ID / CDP_API_KEY_SECRET env
 *   ../frontend/.env.local
 *   ../.secrets/cdp-mainnet.json
 *
 * Generate an Ed25519 key at portal.cdp.coinbase.com — its secret is a
 * single-line base64 string that drops into .env.local cleanly, whereas a
 * legacy ECDSA key is a multi-line PEM that needs \n escaping.
 *
 * Run: cd scripts && bun run coinbase-offramp-probe.ts
 * Writes: docs/coinbase-offramp-probe.md
 */

import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOST = "api.developer.coinbase.com";
const BASE = `https://${HOST}`;

/** A mainnet Sui address to probe address acceptance with. Never signs. */
const PROBE_SUI_ADDRESS =
  process.env.PROBE_SUI_ADDRESS ??
  "0x2084bbffd0e742beff5e07f587a84d372326b2ef40524762ae96d64d42bd0c57";

const PROBE_COUNTRY = "SG";
const PROBE_FIAT = "SGD";
const PROBE_ASSET = "USDC";
const PROBE_NETWORK = "sui";

// ── credentials ─────────────────────────────────────────────────────────────

/** Parse a dotenv file well enough for the two keys we need. */
function parseDotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function loadCredentials(): { apiKeyId: string; apiKeySecret: string; source: string } {
  if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
    return {
      apiKeyId: process.env.CDP_API_KEY_ID,
      apiKeySecret: process.env.CDP_API_KEY_SECRET,
      source: "env",
    };
  }
  const fromFrontend = parseDotenv(join(import.meta.dir, "..", "frontend", ".env.local"));
  if (fromFrontend.CDP_API_KEY_ID && fromFrontend.CDP_API_KEY_SECRET) {
    return {
      apiKeyId: fromFrontend.CDP_API_KEY_ID,
      apiKeySecret: fromFrontend.CDP_API_KEY_SECRET,
      source: "frontend/.env.local",
    };
  }
  try {
    const j = JSON.parse(
      readFileSync(join(import.meta.dir, "..", ".secrets", "cdp-mainnet.json"), "utf8"),
    ) as { api_key_id: string; api_key_secret: string };
    if (j.api_key_id && j.api_key_secret) {
      return {
        apiKeyId: j.api_key_id,
        apiKeySecret: j.api_key_secret,
        source: ".secrets/cdp-mainnet.json",
      };
    }
  } catch {
    /* fall through */
  }
  console.error(
    "✗ No CDP credentials. Set CDP_API_KEY_ID + CDP_API_KEY_SECRET in the env,\n" +
      "  in frontend/.env.local, or in .secrets/cdp-mainnet.json.\n" +
      "  Create a Secret API Key at https://portal.cdp.coinbase.com (choose Ed25519).",
  );
  process.exit(1);
}

const CREDS = loadCredentials();

// ── transport ───────────────────────────────────────────────────────────────

interface CdpResponse {
  status: number;
  body: any;
  raw: string;
}

/**
 * The JWT's `uri` claim is `METHOD host/path` and must NOT include the query
 * string — signing the query is the classic source of an opaque 401 here.
 */
async function cdp(
  method: "GET" | "POST",
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<CdpResponse> {
  const token = await generateJwt({
    apiKeyId: CREDS.apiKeyId,
    apiKeySecret: CREDS.apiKeySecret,
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
  let body: any = raw;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    /* keep raw */
  }
  return { status: res.status, body, raw };
}

// ── result accumulation ─────────────────────────────────────────────────────

type Verdict = "PASS" | "FAIL" | "SKIP" | "INCONCLUSIVE";

interface CheckResult {
  n: number;
  name: string;
  verdict: Verdict;
  detail: string;
  evidence?: unknown;
}

const results: CheckResult[] = [];
const icon = (v: Verdict) =>
  v === "PASS" ? "✓" : v === "FAIL" ? "✗" : v === "SKIP" ? "–" : "?";

function record(r: CheckResult) {
  results.push(r);
  console.log(`${icon(r.verdict)} [${r.n}] ${r.name}: ${r.detail}`);
}

/** Trim a response down to something that fits in a markdown doc. */
function excerpt(value: unknown, max = 4000): string {
  const s = JSON.stringify(value, null, 2) ?? String(value);
  return s.length > max ? `${s.slice(0, max)}\n… (truncated)` : s;
}

// ── the five checks ─────────────────────────────────────────────────────────

async function check1SellConfig(): Promise<{ ok: boolean; sg?: any; body?: any }> {
  const res = await cdp("GET", "/onramp/v1/sell/config");
  if (res.status !== 200) {
    record({
      n: 1,
      name: "GET /sell/config",
      verdict: "FAIL",
      detail: `HTTP ${res.status} — ${res.raw.slice(0, 300)}`,
      evidence: res.body,
    });
    return { ok: false, body: res.body };
  }
  const countries: any[] = res.body?.countries ?? [];
  const sg = countries.find((c) => (c?.id ?? c?.code) === PROBE_COUNTRY);
  if (!sg) {
    record({
      n: 1,
      name: "GET /sell/config",
      verdict: "FAIL",
      detail:
        `SG is NOT a supported offramp country. ` +
        `${countries.length} countries returned: ` +
        countries
          .map((c) => c?.id ?? c?.code)
          .filter(Boolean)
          .join(", "),
      evidence: countries.map((c) => c?.id ?? c?.code),
    });
    return { ok: false, body: res.body };
  }
  const methods: string[] = (sg.payment_methods ?? sg.paymentMethods ?? []).map(
    (m: any) => m?.id ?? m?.type ?? String(m),
  );
  // FIAT_WALLET means "paid into the merchant's own Coinbase balance", which is
  // the flow the plan assumes. A bank-rail method would be strictly better.
  const bankish = methods.filter((m) => /BANK|ACH|SEPA|FAST|PAYNOW|CARD/i.test(m));
  record({
    n: 1,
    name: "GET /sell/config",
    verdict: methods.length > 0 ? "PASS" : "FAIL",
    detail:
      `SG supported. payment_methods = [${methods.join(", ") || "none"}]` +
      (bankish.length ? ` (bank-capable: ${bankish.join(", ")})` : " (no bank rail)"),
    evidence: sg,
  });
  return { ok: methods.length > 0, sg, body: res.body };
}

async function check23SellOptions(): Promise<{
  sgdOk: boolean;
  suiOk: boolean;
  body?: any;
  usdcContract?: string;
}> {
  const res = await cdp("GET", "/onramp/v1/sell/options", {
    query: { country: PROBE_COUNTRY },
  });
  if (res.status !== 200) {
    const detail = `HTTP ${res.status} — ${res.raw.slice(0, 300)}`;
    record({ n: 2, name: "SGD in cashout_currencies", verdict: "FAIL", detail });
    record({ n: 3, name: "sui in USDC networks", verdict: "SKIP", detail: "options call failed" });
    return { sgdOk: false, suiOk: false, body: res.body };
  }

  const cashout: any[] = res.body?.cashout_currencies ?? res.body?.cashoutCurrencies ?? [];
  const codes = cashout.map((c) => c?.id ?? c?.code).filter(Boolean);
  const sgdOk = codes.includes(PROBE_FIAT);
  record({
    n: 2,
    name: "SGD in cashout_currencies",
    verdict: sgdOk ? "PASS" : "FAIL",
    detail: sgdOk
      ? `SGD payable. ${codes.length} currencies offered.`
      : `SGD absent. offered: ${codes.join(", ") || "none"}`,
    evidence: codes,
  });

  const sell: any[] = res.body?.sell_currencies ?? res.body?.sellCurrencies ?? [];
  const usdc = sell.find(
    (c) => String(c?.symbol ?? c?.code ?? c?.id).toUpperCase() === PROBE_ASSET,
  );
  if (!usdc) {
    record({
      n: 3,
      name: "sui in USDC networks",
      verdict: "FAIL",
      detail: `USDC is not a sellable asset for SG. assets: ${sell
        .map((c) => c?.symbol ?? c?.code ?? c?.id)
        .filter(Boolean)
        .join(", ")}`,
      evidence: sell.map((c) => c?.symbol ?? c?.code ?? c?.id),
    });
    return { sgdOk, suiOk: false, body: res.body };
  }
  const networks: any[] = usdc.networks ?? [];
  const netNames = networks.map((n) => n?.name ?? n?.id ?? String(n));
  const suiNet = networks.find(
    (n) => String(n?.name ?? n?.id).toLowerCase() === PROBE_NETWORK,
  );
  record({
    n: 3,
    name: "sui in USDC networks",
    verdict: suiNet ? "PASS" : "FAIL",
    detail: suiNet
      ? `USDC sellable from Sui. contract_address=${suiNet.contract_address ?? "(none)"}`
      : `Sui absent for USDC. networks: ${netNames.join(", ")}`,
    evidence: { networks: netNames, sui: suiNet ?? null },
  });
  return {
    sgdOk,
    suiOk: Boolean(suiNet),
    body: res.body,
    usdcContract: suiNet?.contract_address,
  };
}

async function check4SessionToken(): Promise<{ ok: boolean; token?: string; body?: any }> {
  const res = await cdp("POST", "/onramp/v1/token", {
    body: {
      addresses: [{ address: PROBE_SUI_ADDRESS, blockchains: [PROBE_NETWORK] }],
      assets: [PROBE_ASSET],
    },
  });
  const token: string | undefined = res.body?.token ?? res.body?.data?.token;
  if (res.status !== 200 || !token) {
    record({
      n: 4,
      name: "POST /token accepts a Sui address",
      verdict: "FAIL",
      detail: `HTTP ${res.status} — ${res.raw.slice(0, 400)}`,
      evidence: res.body,
    });
    return { ok: false, body: res.body };
  }
  record({
    n: 4,
    name: "POST /token accepts a Sui address",
    verdict: "PASS",
    detail: `session token minted (${token.length} chars, single-use, ~5 min)`,
    evidence: { tokenLength: token.length, channelId: res.body?.channel_id ?? null },
  });
  return { ok: true, token, body: res.body };
}

const WIDGET_HOST = "https://pay.coinbase.com";
/** v3 is the live sell widget. v1 `/sell/input` 302s to signin; there is no v3 `/sell/preview`. */
const WIDGET_PATH = "/v3/sell/input";

/**
 * Build the hosted offramp URL. `disableEdit` is what locks the amount — the
 * widget's input screen is editable by default, so without it a merchant can
 * commit to more USDC than they actually hold.
 */
function buildOfframpUrl(input: {
  sessionToken: string;
  quoteId: string;
  presetCryptoAmount: string;
  partnerUserId: string;
  redirectUrl: string;
}): string {
  const u = new URL(`${WIDGET_HOST}${WIDGET_PATH}`);
  u.searchParams.set("sessionToken", input.sessionToken);
  u.searchParams.set("quoteId", input.quoteId);
  u.searchParams.set("defaultAsset", PROBE_ASSET);
  u.searchParams.set("defaultNetwork", PROBE_NETWORK);
  u.searchParams.set("defaultCashoutCurrency", PROBE_FIAT);
  u.searchParams.set("presetCryptoAmount", input.presetCryptoAmount);
  u.searchParams.set("disableEdit", "true");
  u.searchParams.set("partnerUserId", input.partnerUserId);
  u.searchParams.set("redirectUrl", input.redirectUrl);
  return u.toString();
}

async function check5SellQuote(
  sessionToken: string | undefined,
): Promise<{ ok: boolean; body?: any; quoteId?: string }> {
  if (!sessionToken) {
    record({
      n: 5,
      name: "POST /sell/quote prices the order",
      verdict: "SKIP",
      detail: "no session token from check 4",
    });
    return { ok: false };
  }
  const res = await cdp("POST", "/onramp/v1/sell/quote", {
    body: {
      sell_currency: PROBE_ASSET,
      sell_network: PROBE_NETWORK,
      sell_amount: "10.00",
      cashout_currency: PROBE_FIAT,
      payment_method: "FIAT_WALLET",
      country: PROBE_COUNTRY,
      // The address the deposit must originate from. Coinbase validates this.
      sourceAddress: PROBE_SUI_ADDRESS,
      // A redirectUrl not on the CDP domain allowlist is silently DROPPED
      // while the order still completes — so this probe value proves nothing
      // about the allowlist, only that the field is accepted.
      redirectUrl: "https://app.quay.cash/app/merchant/wallet",
      partnerUserRef: "quay-probe-0001",
      sessionToken,
    },
  });
  if (res.status !== 200) {
    record({
      n: 5,
      name: "POST /sell/quote prices the order",
      verdict: "FAIL",
      detail: `HTTP ${res.status} — ${res.raw.slice(0, 500)}`,
      evidence: res.body,
    });
    return { ok: false, body: res.body };
  }

  const quoteId: string | undefined = res.body?.quote_id;
  const returnedUrl: string = res.body?.offramp_url ?? "";
  record({
    n: 5,
    name: "POST /sell/quote prices the order",
    verdict: quoteId ? "PASS" : "INCONCLUSIVE",
    detail: quoteId
      ? `quote_id=${quoteId} coinbase_fee=${JSON.stringify(
          res.body?.coinbase_fee ?? null,
        )} cashout_total=${JSON.stringify(res.body?.cashout_total ?? null)}`
      : "HTTP 200 but no quote_id — inspect the body",
    evidence: res.body,
  });

  // `offramp_url` comes back as an EMPTY STRING on this project, and does so
  // for every request shape tried (camelCase vs snake_case for
  // sourceAddress/redirectUrl/partnerUserRef, with and without a sessionToken,
  // allowlisted vs localhost redirect, with and without partnerUserRef). So the
  // hosted URL has to be constructed client-side rather than read out of the
  // quote. Probe #6 confirms the constructed URL is live.
  record({
    n: 5.1 as number,
    name: "offramp_url populated by the API?",
    verdict: returnedUrl ? "PASS" : "INCONCLUSIVE",
    detail: returnedUrl
      ? "API returned a URL — prefer it over constructing one"
      : "API returns an EMPTY STRING in all request shapes ⇒ construct the widget URL ourselves",
    evidence: { offramp_url: returnedUrl },
  });

  return { ok: Boolean(quoteId), body: res.body, quoteId };
}

/**
 * Check 6 — the constructed widget URL. Only reached because check 5 shows the
 * API will not build it for us. A GET here renders the hosted page; it commits
 * nothing and no deposit address is issued until a human completes the flow.
 */
async function check6WidgetUrl(
  sessionToken: string | undefined,
  quoteId: string | undefined,
): Promise<boolean> {
  if (!sessionToken || !quoteId) {
    record({
      n: 6,
      name: "constructed pay.coinbase.com URL is live",
      verdict: "SKIP",
      detail: "needs both a session token and a quote id",
    });
    return false;
  }
  const url = buildOfframpUrl({
    sessionToken,
    quoteId,
    presetCryptoAmount: "10",
    partnerUserId: "quay-probe-0001",
    redirectUrl: "https://app.quay.cash/app/merchant/wallet",
  });
  const res = await fetch(url, { redirect: "manual" });
  const ok = res.status === 200;
  record({
    n: 6,
    name: "constructed pay.coinbase.com URL is live",
    verdict: ok ? "PASS" : "FAIL",
    detail: `GET ${WIDGET_PATH} → HTTP ${res.status}`,
    evidence: { path: WIDGET_PATH, status: res.status },
  });
  return ok;
}

// ── report ──────────────────────────────────────────────────────────────────

function writeReport(stoppedAt: number | null, extras: Record<string, unknown>) {
  const rows = results
    .map((r) => `| ${r.n} | ${r.name} | ${icon(r.verdict)} ${r.verdict} | ${r.detail.replace(/\|/g, "\\|")} |`)
    .join("\n");

  const hardFail = results.some((r) => r.verdict === "FAIL");
  const verdict = hardFail
    ? "**NO-GO** — at least one gate failed. Do not write app code."
    : results.every((r) => r.verdict === "PASS")
      ? "**GO** — all five gates pass. Widget-issued deposit address still needs one manual confirmation."
      : "**INCONCLUSIVE** — no hard failure, but not every gate is green.";

  const md = `# Coinbase CDP Offramp — Phase 0 probe

Generated by \`scripts/coinbase-offramp-probe.ts\`. Read-only; no funds moved, no order committed.

- Host: \`${HOST}\`
- Credential source: \`${CREDS.source}\`
- Probe address: \`${PROBE_SUI_ADDRESS}\`
- Corridor probed: ${PROBE_ASSET} on ${PROBE_NETWORK} → ${PROBE_FIAT} in ${PROBE_COUNTRY}

## Verdict

${verdict}

${stoppedAt ? `Stopped after check ${stoppedAt}: a failed gate makes the later checks meaningless.\n` : ""}
| # | Check | Verdict | Detail |
|---|---|---|---|
${rows}

## Still open after this probe

- **Does the widget issue a real Sui deposit address for a live SG account?**
  Not answerable from the CLI — the deposit address does not exist until a merchant
  commits an order inside \`pay.coinbase.com\`.
- **Does offramp need separate production approval?** The quickstart lists only
  account + secret key + domain allowlist, but that is not the same as confirmation.
- **\`from_address\` semantics** — does Coinbase validate the transaction *sender*
  or the *gas payer*? Quay's sponsored PTB has \`sender = merchant\`,
  \`gasOwner = sponsor\`, so the two differ.

## Blocker found while probing (unrelated to Coinbase)

Sui has **retired JSON-RPC on the public fullnodes**, on mainnet *and* testnet.
Every method returns:

> \`-32601 Method not found. JSON-RPC on public fullnodes has been deprecated.
> Please migrate to gRPC or GraphQL endpoints.\`

Verified by raw \`curl\` and through \`@mysten/sui\` 2.16.2 for
\`getCoinMetadata\`, \`getCoins\`, \`getBalance\`, \`getObject\`, \`getOwnedObjects\`,
\`getDynamicFields\`, \`devInspectTransactionBlock\`, \`getLatestSuiSystemState\`
and \`queryEvents\` — all nine fail.

Quay builds every client as
\`new SuiClient({ network: SUI_NETWORK, url: getFullnodeUrl(SUI_NETWORK) })\`
(\`getJsonRpcFullnodeUrl("mainnet")\` → \`https://fullnode.mainnet.sui.io:443\`)
with no env override, so **all on-chain reads and writes are currently down**,
not just the offramp. The SDK ships \`@mysten/sui/grpc\` and
\`@mysten/sui/graphql\` as the migration targets.

Consequence for this rail: the plan's dry-run verification steps (swap
\`devInspect\`, yield-path dry-run, the live capped run) cannot execute until the
transport is migrated, and the offramp's own session route depends on the same
reads (registry lookup, coin collection, Scallop balance sheet).

## Raw evidence

${results
  .map(
    (r) =>
      `### Check ${r.n} — ${r.name}\n\n\`\`\`json\n${excerpt(r.evidence ?? null)}\n\`\`\`\n`,
  )
  .join("\n")}

${
  Object.keys(extras).length
    ? `### Additional\n\n\`\`\`json\n${excerpt(extras)}\n\`\`\`\n`
    : ""
}`;

  const out = join(import.meta.dir, "..", "docs", "coinbase-offramp-probe.md");
  writeFileSync(out, md);
  console.log(`\nReport written to docs/coinbase-offramp-probe.md`);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `Coinbase CDP Offramp probe — ${PROBE_ASSET}/${PROBE_NETWORK} → ${PROBE_FIAT}/${PROBE_COUNTRY}`,
  );
  console.log(`credentials from: ${CREDS.source}\n`);

  const extras: Record<string, unknown> = {};

  const c1 = await check1SellConfig();
  if (!c1.ok) {
    console.log("\nStopping: SG payout is the go/no-go and it did not pass.");
    writeReport(1, extras);
    process.exit(1);
  }

  const c23 = await check23SellOptions();
  if (c23.usdcContract) extras.usdcContractAddressFromCdp = c23.usdcContract;
  if (!c23.sgdOk) {
    console.log("\nStopping: no SGD payout for SG — the corridor does not exist.");
    writeReport(2, extras);
    process.exit(1);
  }
  if (!c23.suiOk) {
    console.log(
      "\nStopping: USDC-on-Sui is not sellable. Per decision 4 this is a STOP,\n" +
        "not a prompt to absorb a CCTP bridge leg. Re-plan.",
    );
    writeReport(3, extras);
    process.exit(1);
  }

  const c4 = await check4SessionToken();
  if (!c4.ok) {
    console.log("\nStopping: the session-token API will not take a Sui address.");
    writeReport(4, extras);
    process.exit(1);
  }

  const c5 = await check5SellQuote(c4.token);
  if (!c5.ok) {
    console.log("\nStopping: /sell/quote will not price this corridor.");
    writeReport(5, extras);
    process.exit(1);
  }

  const c6 = await check6WidgetUrl(c4.token, c5.quoteId);
  extras.widgetUrlPattern = `${WIDGET_HOST}${WIDGET_PATH}`;
  extras.quoteSample = c5.body;
  writeReport(null, extras);

  if (!c6) {
    console.log("\nPhase 0 did not fully pass. No app code.");
    process.exit(1);
  }
  console.log(
    "\nGO. The corridor exists and every API leg works.\n" +
      "Remaining manual step: open the constructed URL with a real SG Coinbase\n" +
      "account and confirm the widget issues a Sui deposit address.",
  );
}

main().catch((err) => {
  console.error("\n✗ probe crashed:", err);
  process.exit(1);
});
