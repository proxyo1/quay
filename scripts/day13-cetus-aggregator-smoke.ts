/**
 * Day 13 smoke test: prove Cetus Aggregator + the new buildPayAnyTokenPtb
 * path works end-to-end on testnet, without going through the browser.
 *
 * Specifically: ask the aggregator for a route from USDC → SUI sized to a
 * realistic SGD payment, then `devInspect` the assembled cancel-and-pay
 * PTB so we can see whether it would execute. No funds move — devInspect
 * is read-only. Successful run = "the route SDK works, the on-chain
 * aggregator package responds, and our PTB shape is accepted by the Move
 * verifier." Failure points at exactly which leg broke.
 *
 * Why this script matters: the frontend can render a "Cetus Aggregator
 * (≤1% slippage)" pre-sign receipt without ever proving a real route
 * exists. This script proves it.
 *
 * Run: bun run scripts/day13-cetus-aggregator-smoke.ts
 */

import { AggregatorClient, Env } from "@cetusprotocol/aggregator-sdk";
import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { readFileSync } from "node:fs";

import deploy from "./deploy-testnet.json";

const HERMES = "https://hermes.pyth.network";
const USD_SGD = "0x396a969a9c1480fa15ed50bc59149e2c0075a72fe8f458ed941ddec48bdb4918";
const SUI_USD = "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744";
const SUI_TYPE = "0x2::sui::SUI";
// Same USDC_TESTNET the frontend uses. Confirm parity by grep.
const USDC_TYPE =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const CLOCK = "0x6";
const SGD_MINOR_UNITS = 350; // $3.50 SGD — same demo amount as PayPanel default
const SLIPPAGE_BPS = 100;

const client = new SuiClient({ url: getFullnodeUrl("testnet") });

function loadDevKeypair(): Ed25519Keypair {
  const keys = JSON.parse(
    readFileSync(`${process.env.HOME}/.sui/sui_config/sui.keystore`, "utf8"),
  ) as string[];
  const decoded = Buffer.from(keys[0], "base64");
  if (decoded[0] !== 0x00) throw new Error(`not ed25519: scheme=${decoded[0]}`);
  return Ed25519Keypair.fromSecretKey(new Uint8Array(decoded.subarray(1)));
}

async function fetchPythPrice(feedId: string): Promise<{
  price: number;
  rawPrice: string;
  expo: number;
  publishTime: number;
}> {
  const res = await fetch(`${HERMES}/v2/updates/price/latest?ids[]=${feedId}`);
  if (!res.ok) throw new Error(`Hermes HTTP ${res.status}`);
  const data = (await res.json()) as {
    parsed: Array<{
      price: { price: string; conf: string; expo: number; publish_time: number };
    }>;
  };
  const e = data.parsed[0].price;
  return {
    price: parseFloat(e.price) * Math.pow(10, e.expo),
    rawPrice: e.price,
    expo: e.expo,
    publishTime: e.publish_time,
  };
}

async function main() {
  console.log("Day 13 smoke: Cetus Aggregator quote + PTB devInspect\n");

  const dev = loadDevKeypair();
  const devAddr = dev.toSuiAddress();
  console.log(`payer (dev): ${devAddr}`);
  console.log(`merchant1:   ${deploy.demo_merchant1.sui_address}`);
  console.log(`UEN:         ${deploy.demo_merchant1.uen}`);

  console.log("\nfetching Pyth prices…");
  const [usdSgd, suiUsd] = await Promise.all([
    fetchPythPrice(USD_SGD),
    fetchPythPrice(SUI_USD),
  ]);
  console.log(`  USD/SGD: ${usdSgd.price.toFixed(6)}`);
  console.log(`  SUI/USD: $${suiUsd.price.toFixed(6)}`);

  // Target output: the SUI MIST amount equivalent to $3.50 SGD via Pyth.
  const sgd = SGD_MINOR_UNITS / 100;
  const usdPerSgd = 1 / usdSgd.price;
  const usd = sgd * usdPerSgd;
  const suiOut = usd / suiUsd.price;
  const mistOut = BigInt(Math.ceil(suiOut * 1_000_000_000));
  console.log(
    `\ntarget output: $${sgd.toFixed(2)} SGD ≈ ${suiOut.toFixed(6)} SUI = ${mistOut} MIST`,
  );

  // ─── Aggregator quote (USDC → SUI) ─────────────────────────────────────
  console.log("\nquerying Cetus Aggregator (USDC → SUI)…");
  const cetus = new AggregatorClient({
    client,
    env: Env.Testnet,
    signer: devAddr,
    partner: deploy.admin_address,
  });

  const router = await cetus.findRouters({
    from: USDC_TYPE,
    target: SUI_TYPE,
    amount: mistOut.toString(),
    byAmountIn: false,
  });
  if (!router) {
    console.error("❌ aggregator returned no route");
    process.exit(1);
  }
  if (router.insufficientLiquidity) {
    console.error("❌ aggregator returned route with insufficient liquidity");
    process.exit(1);
  }
  if (router.error) {
    console.error(`❌ aggregator returned error: ${router.error.msg}`);
    process.exit(1);
  }

  console.log(`✓ route found`);
  console.log(`  amountIn:  ${router.amountIn.toString()} (smallest USDC units)`);
  console.log(`  amountOut: ${router.amountOut.toString()} (MIST)`);
  console.log(`  paths:     ${router.paths?.length ?? 0}`);
  if (router.paths?.length) {
    const venues = new Set<string>();
    for (const p of router.paths) {
      const provider = (p as unknown as { provider?: string }).provider;
      if (provider) venues.add(provider);
    }
    if (venues.size) console.log(`  venues:    ${Array.from(venues).join(", ")}`);
  }

  // ─── Assemble the swap-and-pay PTB ─────────────────────────────────────
  console.log("\nassembling PTB (split USDC → aggregator swap → payments::pay<SUI>)…");

  // Fetch a USDC coin object for the dev account. If dev has none, smoke
  // ends here — the script's job is to prove the route + PTB shape; without
  // a real USDC balance we can't even build the PTB.
  const coins = await client.getCoins({ owner: devAddr, coinType: USDC_TYPE });
  if (coins.data.length === 0) {
    console.error(
      "\n⚠ dev wallet has no testnet USDC coins. The route exists but the PTB needs a real coin object to split from.",
    );
    console.error(
      "  Get some testnet USDC for this address and re-run, or treat the route confirmation above as the smoke-test success.",
    );
    process.exit(0);
  }
  const largest = coins.data.reduce((a, b) =>
    BigInt(a.balance) >= BigInt(b.balance) ? a : b,
  );
  console.log(
    `  using USDC coin ${largest.coinObjectId.slice(0, 10)}… (balance ${largest.balance})`,
  );

  const tx = new Transaction();
  tx.setSender(devAddr);

  const [usdcIn] = tx.splitCoins(tx.object(largest.coinObjectId), [
    tx.pure.u64(BigInt(router.amountIn.toString())),
  ]);

  const suiOutArg = await cetus.routerSwap({
    router,
    inputCoin: usdcIn,
    slippage: SLIPPAGE_BPS / 10_000,
    txb: tx,
    partner: deploy.admin_address,
  });

  // Build the same v1 quote metadata the frontend produces.
  const metaBody = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      src: "pyth-hermes",
      sgd_minor: SGD_MINOR_UNITS,
      usd_sgd_id: USD_SGD,
      usd_sgd_price: usdSgd.rawPrice,
      usd_sgd_expo: usdSgd.expo,
      usd_sgd_publish_time: usdSgd.publishTime,
      sui_usd_id: SUI_USD,
      sui_usd_price: suiUsd.rawPrice,
      sui_usd_expo: suiUsd.expo,
      sui_usd_publish_time: suiUsd.publishTime,
      out_token: SUI_TYPE,
      out_amount: mistOut.toString(),
      dex: {
        venue: "cetus-aggregator",
        payer_token: USDC_TYPE,
        slippage_bps: SLIPPAGE_BPS,
      },
    }),
  );
  const magic = new TextEncoder().encode("SQR1");
  const meta = new Uint8Array(magic.length + metaBody.length);
  meta.set(magic, 0);
  meta.set(metaBody, magic.length);

  tx.moveCall({
    target: `${deploy.package_id}::payments::pay`,
    typeArguments: [SUI_TYPE],
    arguments: [
      tx.object(deploy.merchant_registry_id),
      tx.pure.vector(
        "u8",
        Array.from(new TextEncoder().encode(deploy.demo_merchant1.uen)),
      ),
      suiOutArg,
      tx.pure.option(
        "vector<u8>",
        Array.from(new TextEncoder().encode("day13-aggregator-smoke")),
      ),
      tx.pure.u64(BigInt(SGD_MINOR_UNITS)),
      tx.pure.option("vector<u8>", Array.from(meta)),
      tx.object(CLOCK),
    ],
  });

  // ─── devInspect — read-only simulation ─────────────────────────────────
  console.log("\nrunning devInspectTransactionBlock…");
  const inspect = await client.devInspectTransactionBlock({
    sender: devAddr,
    transactionBlock: tx,
  });
  const status = inspect.effects?.status?.status;
  if (status === "success") {
    console.log("\n✓ PTB simulates clean — aggregator + payments::pay<SUI> chain works");
    process.exit(0);
  } else {
    console.error(`\n❌ devInspect failed: ${inspect.effects?.status?.error ?? "unknown"}`);
    console.error("   This is the failure mode users would see at sign time.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\nsmoke failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
