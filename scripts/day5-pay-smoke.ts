/**
 * Day 5 smoke test: build the same payments::pay<SUI> PTB the frontend
 * PayPanel produces, then submit it on testnet using the dev keystore
 * to prove the lib + on-chain contract work end-to-end before we trust
 * a wallet-connected browser flow.
 *
 * This pays merchant1 (from scripts/deploy-testnet.json) a small SUI
 * amount with a live Pyth-derived quote and an SGD price. Captures the
 * digest and verifies the PaymentReceipt event in the result.
 *
 * Run: bun run scripts/day5-pay-smoke.ts
 */

import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { bcs } from "@mysten/sui/bcs";
import { readFileSync } from "node:fs";

import deploy from "./deploy-testnet.json";

const HERMES = "https://hermes.pyth.network";
const USD_SGD = "0x396a969a9c1480fa15ed50bc59149e2c0075a72fe8f458ed941ddec48bdb4918";
const SUI_USD = "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744";
const SUI_COIN = "0x2::sui::SUI";
const CLOCK = "0x6";
const SGD_MINOR_UNITS = 5; // $0.05 SGD — small enough to fit current dev balance

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
  const data = (await res.json()) as { parsed: Array<{ price: { price: string; conf: string; expo: number; publish_time: number } }> };
  const e = data.parsed[0].price;
  return {
    price: parseFloat(e.price) * Math.pow(10, e.expo),
    rawPrice: e.price,
    expo: e.expo,
    publishTime: e.publish_time,
  };
}

async function main() {
  console.log("Day 5 smoke: payments::pay<SUI> from dev → merchant1\n");

  const dev = loadDevKeypair();
  const devAddr = dev.toSuiAddress();
  console.log(`payer (dev): ${devAddr}`);

  const merchantAddr = deploy.demo_merchant1.sui_address;
  const merchantUen = deploy.demo_merchant1.uen;
  console.log(`merchant1:   ${merchantAddr}`);
  console.log(`UEN:         ${merchantUen}`);

  const balance = await client.getBalance({ owner: devAddr });
  console.log(`dev gas:     ${(Number(balance.totalBalance) / 1e9).toFixed(4)} SUI`);

  console.log("\nfetching Pyth prices…");
  const [usdSgd, suiUsd] = await Promise.all([fetchPythPrice(USD_SGD), fetchPythPrice(SUI_USD)]);
  console.log(`  USD/SGD: ${usdSgd.price.toFixed(6)}`);
  console.log(`  SUI/USD: $${suiUsd.price.toFixed(6)}`);

  // SGD → USD → SUI conversion (Pyth USD/SGD inverted)
  const sgd = SGD_MINOR_UNITS / 100;
  const usdPerSgd = 1 / usdSgd.price;
  const usd = sgd * usdPerSgd;
  const sui = usd / suiUsd.price;
  const mist = BigInt(Math.ceil(sui * 1_000_000_000));
  console.log(`\nquote: $${sgd.toFixed(2)} SGD = $${usd.toFixed(4)} USD = ${sui.toFixed(6)} SUI = ${mist} MIST`);

  // Build the same payload encodeQuoteMetadata produces in the frontend
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
      mist: mist.toString(),
    }),
  );
  const magic = new TextEncoder().encode("SQR1");
  const meta = new Uint8Array(magic.length + metaBody.length);
  meta.set(magic, 0);
  meta.set(metaBody, magic.length);

  // Build the PTB. Identical to frontend buildPaySuiTx — kept inline so
  // this script is standalone and doesn't drag in @/lib paths.
  const tx = new Transaction();
  tx.setGasBudget(50_000_000n);
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(mist)]);
  tx.moveCall({
    target: `${deploy.package_id}::payments::pay`,
    typeArguments: [SUI_COIN],
    arguments: [
      tx.object(deploy.merchant_registry_id),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(merchantUen))),
      coin,
      tx.pure.option("vector<u8>", Array.from(new TextEncoder().encode("day5-smoke"))),
      tx.pure.u64(BigInt(SGD_MINOR_UNITS)),
      tx.pure.option("vector<u8>", Array.from(meta)),
      tx.object(CLOCK),
    ],
  });

  console.log("\nsubmitting payments::pay<SUI>…");
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: dev,
    options: { showEffects: true, showEvents: true },
  });
  await client.waitForTransaction({ digest: result.digest });

  if (result.effects?.status?.status !== "success") {
    console.error("FAILED:", JSON.stringify(result.effects?.status, null, 2));
    process.exit(1);
  }
  console.log(`✓ pay tx: ${result.digest}`);
  console.log(`  https://suiscan.xyz/testnet/tx/${result.digest}`);

  const receipts = (result.events ?? []).filter((e) =>
    e.type.endsWith("::payments::PaymentReceipt"),
  );
  console.log(`  PaymentReceipt events: ${receipts.length}`);
  if (receipts[0]) {
    const r = receipts[0].parsedJson as any;
    console.log(`    payer:           ${r.payer}`);
    console.log(`    merchant:        ${r.merchant}`);
    console.log(`    amount (MIST):   ${r.amount}`);
    console.log(`    sgd_minor_units: ${r.sgd_minor_units}`);
    console.log(`    has memo:        ${r.memo != null}`);
    console.log(`    has quote meta:  ${r.quote_metadata != null}`);
    console.log(`    receipt_id:      0x${(r.receipt_id as number[]).map((b: number) => b.toString(16).padStart(2, "0")).join("").slice(0, 16)}…`);
  }
}

main().catch((e) => {
  console.error("smoke FAILED:", e);
  process.exit(1);
});
