/**
 * Day 7 prep: generate the suiqr sponsor wallet, fund it from dev, and
 * write the keypair to .secrets/sponsor-testnet.json.
 *
 * The sponsor is the wallet whose SUI pays gas for sponsored transactions
 * issued by /api/sponsor. Idempotent — re-running loads the existing key
 * and tops up funding if the balance drops below a threshold.
 */

import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = "/Users/ryan/projects/suiqr";
const SECRETS_DIR = join(REPO_ROOT, ".secrets");
const SPONSOR_KEY_FILE = join(SECRETS_DIR, "sponsor-testnet.json");

// Sponsor wallet target balance. Each sponsored tx burns ~1-5M MIST in
// gas; with a 100M MIST floor we can cover ~20-100 sponsored txs before
// needing a top-up. AD32 says auto-faucet at 20% remaining.
const SPONSOR_TARGET_MIST = 200_000_000n; // 0.2 SUI
const SPONSOR_REFILL_FROM_DEV = 100_000_000n; // 0.1 SUI per top-up

const sui = new SuiClient({ url: getFullnodeUrl("testnet") });

function loadDevKeypair(): Ed25519Keypair {
  const keys = JSON.parse(
    readFileSync(`${process.env.HOME}/.sui/sui_config/sui.keystore`, "utf8"),
  ) as string[];
  const decoded = Buffer.from(keys[0], "base64");
  if (decoded[0] !== 0x00) throw new Error("not ed25519");
  return Ed25519Keypair.fromSecretKey(new Uint8Array(decoded.subarray(1)));
}

function loadOrGenerateSponsor(): { kp: Ed25519Keypair; isNew: boolean } {
  if (existsSync(SPONSOR_KEY_FILE)) {
    const j = JSON.parse(readFileSync(SPONSOR_KEY_FILE, "utf8")) as {
      secret_key_hex: string;
    };
    const bytes = Uint8Array.from(Buffer.from(j.secret_key_hex, "hex"));
    return { kp: Ed25519Keypair.fromSecretKey(bytes), isNew: false };
  }
  if (!existsSync(SECRETS_DIR)) mkdirSync(SECRETS_DIR, { recursive: true });
  const kp = Ed25519Keypair.generate();
  const bech = kp.getSecretKey();
  const { secretKey } = decodeSuiPrivateKey(bech);
  writeFileSync(
    SPONSOR_KEY_FILE,
    JSON.stringify(
      {
        network: "testnet",
        scheme: "ed25519",
        secret_key_hex: Buffer.from(secretKey).toString("hex"),
        pubkey_hex: Buffer.from(kp.getPublicKey().toRawBytes()).toString("hex"),
        sui_address: kp.toSuiAddress(),
        generated_at: new Date().toISOString(),
        note: "suiqr sponsored-tx gas wallet. Testnet only. Top up via day7-create-sponsor.ts.",
      },
      null,
      2,
    ),
  );
  return { kp, isNew: true };
}

async function main() {
  const dev = loadDevKeypair();
  const { kp: sponsor, isNew } = loadOrGenerateSponsor();
  const sponsorAddr = sponsor.toSuiAddress();
  console.log(`sponsor: ${sponsorAddr}${isNew ? " (newly generated)" : " (loaded)"}`);

  const { totalBalance } = await sui.getBalance({ owner: sponsorAddr });
  const bal = BigInt(totalBalance);
  console.log(`balance: ${(Number(bal) / 1e9).toFixed(4)} SUI`);

  if (bal >= SPONSOR_TARGET_MIST) {
    console.log("✓ at/above target balance — no top-up needed");
    return;
  }

  const need = SPONSOR_REFILL_FROM_DEV;
  console.log(`topping up: ${(Number(need) / 1e9).toFixed(4)} SUI from dev → sponsor`);

  const tx = new Transaction();
  tx.setGasBudget(10_000_000n);
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(need)]);
  tx.transferObjects([coin], tx.pure.address(sponsorAddr));
  const result = await sui.signAndExecuteTransaction({
    transaction: tx,
    signer: dev,
    options: { showEffects: true },
  });
  if (result.effects?.status?.status !== "success") {
    throw new Error(`top-up failed: ${JSON.stringify(result.effects?.status)}`);
  }
  await sui.waitForTransaction({ digest: result.digest });
  console.log(`top-up tx: ${result.digest}`);

  const after = await sui.getBalance({ owner: sponsorAddr });
  console.log(`new balance: ${(Number(after.totalBalance) / 1e9).toFixed(4)} SUI`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
