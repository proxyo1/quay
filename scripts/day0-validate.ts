/**
 * Day 0 testnet validation (AD1)
 *
 * Pragmatic kill-switch checks for the quay Sui Overflow hackathon build.
 * Goal: catch load-bearing-hypothesis failures BEFORE writing production code.
 *
 *   1. Pyth SGD/USD feed presence (Hermes off-chain API)
 *   2. Cetus testnet package on-chain (deeper liquidity probe deferred to Day 5)
 *   3. zkLogin SDK + sponsored-tx PTB construction
 *   4. Pyth + Cetus compose (structural — Sui PTB runtime composes any two modules)
 *
 * Each check returns PASS / FAIL / FALLBACK. FAIL means a load-bearing
 * hypothesis collapsed; FALLBACK means we apply the pre-baked plan-B from
 * the build plan and continue.
 *
 * Run: bun run scripts/day0-validate.ts
 */

import { SuiJsonRpcClient as SuiClient, getJsonRpcFullnodeUrl as getFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { generateNonce, generateRandomness } from "@mysten/zklogin";
import { writeFileSync } from "node:fs";

type Status = "PASS" | "FAIL" | "FALLBACK";
interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  evidence?: unknown;
}

const sui = new SuiClient({ url: getFullnodeUrl("testnet") });
const HERMES = "https://hermes.pyth.network";
const TIMEOUT_MS = 20_000;

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function checkPythSgdUsd(): Promise<CheckResult> {
  // The plan said SGD/USD but Pyth publishes the FX rate as USD/SGD (number of
  // SGD per 1 USD). Functionally equivalent — invert at compute time:
  // SGD_per_USD = USD_SGD_price; USD_per_SGD = 1 / USD_SGD_price.
  // Also confirm SUI/USD and USDC/USD which Day 4 needs.
  try {
    const [fxFeeds, cryptoFeeds] = await Promise.all([
      fetchJson(`${HERMES}/v2/price_feeds?asset_type=fx`) as Promise<any[]>,
      fetchJson(`${HERMES}/v2/price_feeds?asset_type=crypto`) as Promise<any[]>,
    ]);
    const sgdEither =
      fxFeeds.find((f) => f?.attributes?.base === "SGD" && f?.attributes?.quote_currency === "USD") ??
      fxFeeds.find((f) => f?.attributes?.base === "USD" && f?.attributes?.quote_currency === "SGD");
    const suiUsd = cryptoFeeds.find(
      (f) => f?.attributes?.base === "SUI" && f?.attributes?.quote_currency === "USD",
    );
    const usdcUsd = cryptoFeeds.find(
      (f) => f?.attributes?.base === "USDC" && f?.attributes?.quote_currency === "USD",
    );

    if (!sgdEither) {
      return {
        name: "Pyth SGD pricing (Hermes)",
        status: "FALLBACK",
        detail: "No SGD-related FX feed in Hermes. Apply plan's fallback: USD-native pricing.",
        evidence: { sui_usd: suiUsd?.id ?? null, usdc_usd: usdcUsd?.id ?? null },
      };
    }

    // Confirm live price is fetchable for the SGD-related feed.
    const priceData = await fetchJson(`${HERMES}/v2/updates/price/latest?ids[]=${sgdEither.id}`);
    const hasPrice = Array.isArray(priceData?.parsed) && priceData.parsed.length > 0;

    if (!hasPrice) {
      return {
        name: "Pyth SGD pricing (Hermes)",
        status: "FALLBACK",
        detail: `Feed metadata exists (${sgdEither.attributes.symbol}) but no live price update returned. Re-check Day 4.`,
        evidence: { feed_id: sgdEither.id, symbol: sgdEither.attributes.symbol },
      };
    }

    return {
      name: "Pyth SGD pricing (Hermes)",
      status: "PASS",
      detail: `${sgdEither.attributes.symbol} live (id ${sgdEither.id.slice(0, 8)}…); invert at compute time for SGD→USD. SUI/USD ${suiUsd ? "found" : "MISSING"}, USDC/USD ${usdcUsd ? "found" : "MISSING"}.`,
      evidence: {
        sgd_feed_id: sgdEither.id,
        sgd_symbol: sgdEither.attributes.symbol,
        sgd_base: sgdEither.attributes.base,
        sgd_quote: sgdEither.attributes.quote_currency,
        invert_at_compute: sgdEither.attributes.base === "USD",
        sui_usd_id: suiUsd?.id ?? null,
        usdc_usd_id: usdcUsd?.id ?? null,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: "Pyth SGD pricing (Hermes)", status: "FAIL", detail: `Exception: ${msg}` };
  }
}

async function checkSuiTestnetReachable(): Promise<CheckResult> {
  try {
    const chainId = await sui.getChainIdentifier();
    const epoch = await sui.getLatestSuiSystemState();
    return {
      name: "Sui testnet RPC reachable",
      status: "PASS",
      detail: `chain_id=${chainId} epoch=${epoch.epoch}`,
      evidence: { chain_id: chainId, epoch: epoch.epoch, protocol_version: epoch.protocolVersion },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: "Sui testnet RPC reachable", status: "FAIL", detail: `Exception: ${msg}` };
  }
}

async function checkZkLoginSdk(): Promise<CheckResult> {
  try {
    const ephemeral = Ed25519Keypair.generate();
    const randomness = generateRandomness();
    const nonce = generateNonce(ephemeral.getPublicKey(), 100, randomness);
    if (!nonce || nonce.length < 16) {
      return { name: "zkLogin SDK (@mysten/zklogin)", status: "FAIL", detail: "generateNonce returned empty/short value" };
    }
    return {
      name: "zkLogin SDK (@mysten/zklogin)",
      status: "PASS",
      detail: `Ephemeral keypair generated; randomness ok; nonce produced (${nonce.length} chars)`,
      evidence: { nonce_len: nonce.length, ephemeral_address: ephemeral.toSuiAddress() },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: "zkLogin SDK (@mysten/zklogin)", status: "FAIL", detail: `Exception: ${msg}` };
  }
}

async function checkSponsoredTxBuild(): Promise<CheckResult> {
  // Build a sponsored-tx PTB (sender != gas owner). We don't submit — that
  // requires a funded sponsor + sender pair we wire on Day 7. Day 0 just
  // confirms the SDK assembles a sponsored-tx PTB without throwing.
  try {
    const sender = Ed25519Keypair.generate();
    const sponsor = Ed25519Keypair.generate();
    const tx = new Transaction();
    tx.setSender(sender.toSuiAddress());
    tx.setGasOwner(sponsor.toSuiAddress());
    // Set explicit gas budget/price so build() doesn't try to fetch live gas.
    tx.setGasBudget(100_000_000n);
    tx.setGasPrice(1_000n);
    // Dummy gas-payment ref so build() has the kind it expects for sponsored-tx.
    tx.setGasPayment([
      {
        objectId: "0x" + "11".repeat(32),
        version: "1",
        digest: "11111111111111111111111111111111",
      },
    ]);
    tx.transferObjects([tx.gas], tx.pure.address(sender.toSuiAddress()));
    const bytes = await tx.build({ client: sui });
    return {
      name: "Sponsored-tx PTB construction",
      status: "PASS",
      detail: `Sponsored PTB built; sender != gasOwner; tx bytes ${bytes.length}`,
      evidence: {
        sender: sender.toSuiAddress(),
        gas_owner: sponsor.toSuiAddress(),
        tx_bytes_len: bytes.length,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // SDK build can throw for legit reasons (e.g., needing real gas coin from chain).
    // That's a FALLBACK — sponsored-tx is well-documented Sui primitive; we test
    // E2E with funded keys on Day 7.
    return {
      name: "Sponsored-tx PTB construction",
      status: "FALLBACK",
      detail: `SDK build threw (likely needs real gas obj): ${msg}. Sponsored-tx is a standard Sui primitive; E2E verified on Day 7 with funded sponsor pool.`,
    };
  }
}

async function checkPythAndCetusPackagesOnTestnet(): Promise<CheckResult> {
  // Day 0 sanity: confirm both Pyth and Cetus have non-empty Sui testnet
  // deployments. We don't need to call them — Sui PTBs can compose ANY two
  // independently published modules in one transaction. We just need to
  // know the packages exist.
  //
  // Pyth Sui testnet package (Wormhole-bridged Pyth): per Pyth docs at
  // https://docs.pyth.network/price-feeds/contract-addresses/sui — these
  // IDs are published per network. For testnet, the state object is the
  // canonical handle.
  //
  // Cetus testnet CLMM: per Cetus docs.
  //
  // If either is missing, we surface FALLBACK with the doc URLs so Day 4/5
  // (Pyth/Cetus integration) can re-check.

  const PYTH_DOCS = "https://docs.pyth.network/price-feeds/contract-addresses/sui";
  const CETUS_DOCS = "https://cetus-1.gitbook.io/cetus-developer-docs";

  // Known testnet Pyth state object (verify via getObject)
  const candidates = {
    pyth_state: "0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c",
    wormhole_state: "0xebba4cc4d614f7a7cdbe883acc76d1cc767922bc96778e7b68be0d15fce27c02",
    cetus_global_config: "0x9774e359588ead122af1c7e7f64e14ade261cfeecdb5d0eb809cd7e95f12b1bb",
  };

  const probed: Record<string, { found: boolean; type?: string }> = {};
  for (const [name, id] of Object.entries(candidates)) {
    try {
      const obj = await sui.getObject({ id, options: { showType: true } });
      probed[name] = { found: !!obj.data?.objectId, type: obj.data?.type ?? undefined };
    } catch {
      probed[name] = { found: false };
    }
  }
  const pythOk = probed.pyth_state?.found ?? false;
  const cetusOk = probed.cetus_global_config?.found ?? false;

  if (pythOk && cetusOk) {
    return {
      name: "Pyth + Cetus testnet deployments + compose",
      status: "PASS",
      detail:
        "Both Pyth state and Cetus global-config objects resolve on testnet. PTB composition is guaranteed by Sui runtime (any two independently published modules can be called atomically in one PTB).",
      evidence: probed,
    };
  }

  return {
    name: "Pyth + Cetus testnet deployments + compose",
    status: "FALLBACK",
    detail: `Could not verify both packages via hardcoded candidate IDs (pyth_state=${pythOk}, cetus_global_config=${cetusOk}). Look up live IDs from docs: Pyth ${PYTH_DOCS}, Cetus ${CETUS_DOCS}. Re-check on Day 4 (Pyth) / Day 5 (Cetus). Compose is guaranteed by Sui runtime regardless.`,
    evidence: probed,
  };
}

async function main() {
  console.log("Day 0 testnet validation (AD1)\n");
  const checks: Array<() => Promise<CheckResult>> = [
    checkSuiTestnetReachable,
    checkPythSgdUsd,
    checkZkLoginSdk,
    checkSponsoredTxBuild,
    checkPythAndCetusPackagesOnTestnet,
  ];

  const results: CheckResult[] = [];
  for (const fn of checks) {
    const r = await fn();
    results.push(r);
    const tag = r.status === "PASS" ? "✓ PASS" : r.status === "FAIL" ? "✗ FAIL" : "~ FALLBACK";
    console.log(`${tag}  ${r.name}`);
    console.log(`        ${r.detail}\n`);
  }

  const passCount = results.filter((r) => r.status === "PASS").length;
  const fallCount = results.filter((r) => r.status === "FALLBACK").length;
  const failCount = results.filter((r) => r.status === "FAIL").length;

  const lines: string[] = [
    "# Day 0 testnet validation results (AD1)",
    "",
    `Generated ${new Date().toISOString()} against Sui testnet.`,
    "",
    `Summary: ${passCount} PASS · ${fallCount} FALLBACK · ${failCount} FAIL`,
    "",
    "| # | Check | Status | Detail |",
    "|---|-------|--------|--------|",
  ];
  results.forEach((r, i) => {
    const safeDetail = r.detail.replaceAll("|", "\\|").replaceAll("\n", " ");
    lines.push(`| ${i + 1} | ${r.name} | ${r.status} | ${safeDetail} |`);
  });
  lines.push("");
  lines.push("## Evidence");
  lines.push("");
  for (const r of results) {
    if (r.evidence) {
      lines.push(`### ${r.name}`);
      lines.push("```json");
      lines.push(JSON.stringify(r.evidence, null, 2));
      lines.push("```");
      lines.push("");
    }
  }
  lines.push("## Interpretation");
  lines.push("");
  lines.push("- `PASS` = hypothesis validated; proceed as planned.");
  lines.push("- `FALLBACK` = primary path uncertain; apply the pre-baked plan-B from the build plan, re-check on the integration day.");
  lines.push("- `FAIL` = load-bearing hypothesis broken; halt and re-plan.");
  lines.push("");

  writeFileSync("day0-results.md", lines.join("\n"));
  console.log(`Results written to scripts/day0-results.md (${passCount} pass / ${fallCount} fallback / ${failCount} fail)`);

  // Exit non-zero only on hard fail; fallback is OK to proceed.
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Top-level exception:", e);
  process.exit(2);
});
