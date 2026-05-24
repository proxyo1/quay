/**
 * SPIKE: gasless USDsui transfer via 0x2::coin::send_funds (Sui protocol
 * v125 gasless stablecoin transfers, mainnet 2026-05-20).
 *
 * Sends FROM the treasury wallet (which holds USDsui but ZERO SUI) — so a
 * successful send is itself proof the transfer was gasless: there's no SUI
 * to pay gas with. Stands in for a merchant zkLogin wallet (which also pays
 * no gas), without needing a browser zkLogin signature.
 *
 *   cd scripts && bun run gasless-withdraw-spike.ts            # devInspect only (no money)
 *   cd scripts && bun run gasless-withdraw-spike.ts --execute  # real gasless send
 *
 * Recipient defaults to the merchant zkLogin wallet (returns the test funds
 * + lets us inspect what the recipient actually receives).
 */

import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { readFileSync } from "node:fs";

const EXECUTE = process.argv.includes("--execute");
const USDSUI =
  "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const RECIPIENT =
  process.argv.find((a) => a.startsWith("0x")) ??
  "0x282dcace073723b831f5284e3b7a017a7bebc2e9d35b3d2e5b4524fcb6c9b5c2"; // merchant zkLogin

const sui = new SuiClient({ url: getFullnodeUrl("mainnet") });

function treasuryKeypair(): Ed25519Keypair {
  const j = JSON.parse(readFileSync("../.secrets/treasury-mainnet.json", "utf8")) as {
    secret_key_hex: string;
  };
  return Ed25519Keypair.fromSecretKey(new Uint8Array(Buffer.from(j.secret_key_hex, "hex")));
}

async function main() {
  const kp = treasuryKeypair();
  const sender = kp.toSuiAddress();
  console.log(`sender (treasury): ${sender}`);
  console.log(`recipient:         ${RECIPIENT}`);

  const [usdsui, sui_bal] = await Promise.all([
    sui.getBalance({ owner: sender, coinType: USDSUI }),
    sui.getBalance({ owner: sender }),
  ]);
  console.log(`treasury USDsui:   ${(Number(usdsui.totalBalance) / 1e6).toFixed(6)} (${usdsui.coinObjectCount} objs)`);
  console.log(`treasury SUI:      ${(Number(sui_bal.totalBalance) / 1e9).toFixed(9)}  <- if 0, a successful send proves gasless`);

  const coins = await sui.getCoins({ owner: sender, coinType: USDSUI });
  if (coins.data.length === 0) {
    console.error("✗ treasury holds no USDsui coin objects");
    process.exit(1);
  }
  // Whole-coin send (send_funds takes a Coin by value; no split — split isn't
  // in the gasless allowlist). Use the first/only coin.
  const coinId = coins.data[0].coinObjectId;
  console.log(`sending whole coin: ${coinId} (${(Number(coins.data[0].balance) / 1e6).toFixed(6)} USDsui)`);

  const tx = new Transaction();
  tx.moveCall({
    target: "0x2::coin::send_funds",
    typeArguments: [USDSUI],
    arguments: [tx.object(coinId), tx.pure.address(RECIPIENT)],
  });
  tx.setSender(sender);

  // --- devInspect: validate the call resolves (no gas, no money) ---
  console.log("\n→ devInspect (validate construction)…");
  const di = await sui.devInspectTransactionBlock({ sender, transactionBlock: tx });
  console.log(`  status: ${di.effects?.status?.status}  ${di.effects?.status?.error ?? ""}`);
  if (di.effects?.status?.status !== "success") {
    console.error("  ✗ devInspect failed — construction wrong; not proceeding");
    console.error("  ", JSON.stringify(di.error ?? di.effects?.status));
    process.exit(1);
  }
  console.log("  ✓ send_funds resolves");

  if (!EXECUTE) {
    console.log("\n(dry-run only — re-run with --execute for the real gasless send)");
    return;
  }

  // --- real gasless execute: gas=0, gasBudget=0, no gas payment ---
  console.log("\n→ EXECUTE gasless (gas=0, gasBudget=0, no gas coin)…");
  tx.setGasPayment([]);
  tx.setGasBudget(0n);
  tx.setGasPrice(0n);
  const bytes = await tx.build({ client: sui });
  const { signature } = await kp.signTransaction(bytes);
  const res = await sui.executeTransactionBlock({
    transactionBlock: bytes,
    signature,
    options: { showEffects: true, showBalanceChanges: true },
  });
  console.log(`  digest: ${res.digest}`);
  console.log(`  status: ${res.effects?.status?.status}  ${res.effects?.status?.error ?? ""}`);
  console.log(`  gasUsed:`, JSON.stringify(res.effects?.gasUsed));
  console.log(`  balanceChanges:`, JSON.stringify(res.balanceChanges));
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
