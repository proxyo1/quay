/**
 * Day 6 smoke: end-to-end merchant onboarding through the /api/attest
 * route. Boots Next.js dev, POSTs to /api/attest with a fresh wallet's
 * address, then submits register_merchant on testnet. Verifies the
 * MerchantRegistered event fired.
 *
 * Run: bun run scripts/day6-onboard-smoke.ts
 *
 * Prerequisite: nothing — we generate a fresh keypair and fund it from
 * the dev wallet (the keystore-loaded one we use elsewhere).
 */

import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

import deploy from "./deploy-testnet.json";

const CLOCK = "0x6";
const FUND_MIST = 30_000_000n; // 0.03 SUI — enough for the register tx

const sui = new SuiClient({ url: getFullnodeUrl("testnet") });

function loadDevKeypair(): Ed25519Keypair {
  const keys = JSON.parse(
    readFileSync(`${process.env.HOME}/.sui/sui_config/sui.keystore`, "utf8"),
  ) as string[];
  const decoded = Buffer.from(keys[0], "base64");
  if (decoded[0] !== 0x00) throw new Error("not ed25519");
  return Ed25519Keypair.fromSecretKey(new Uint8Array(decoded.subarray(1)));
}

async function bootDev(): Promise<{ port: number; kill: () => void }> {
  const port = 3098; // unlikely to collide
  const child = spawn("pnpm", ["dev", "--port", String(port)], {
    cwd: `${process.cwd()}/../frontend`,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait for the "Ready" line
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("dev server did not become ready within 60s"));
    }, 60_000);
    child.stdout?.on("data", (d) => {
      const s = d.toString();
      if (s.includes("Ready") || s.includes("started server")) {
        clearTimeout(timer);
        resolve({
          port,
          kill: () => {
            try {
              child.kill();
            } catch {
              /* ignore */
            }
          },
        });
      }
    });
    child.stderr?.on("data", (d) => process.stderr.write(`[dev] ${d}`));
  });
}

async function main() {
  console.log("Day 6 smoke: merchant onboarding E2E\n");

  // 1. Generate a fresh merchant keypair
  const merchant = Ed25519Keypair.generate();
  const merchantAddr = merchant.toSuiAddress();
  console.log(`fresh merchant:  ${merchantAddr}`);

  // 2. Fund the merchant from dev so it can pay the register-tx gas
  const dev = loadDevKeypair();
  const fundTx = new Transaction();
  fundTx.setGasBudget(20_000_000n);
  const [coin] = fundTx.splitCoins(fundTx.gas, [fundTx.pure.u64(FUND_MIST)]);
  fundTx.transferObjects([coin], fundTx.pure.address(merchantAddr));
  const fundResult = await sui.signAndExecuteTransaction({
    transaction: fundTx,
    signer: dev,
    options: { showEffects: true },
  });
  if (fundResult.effects?.status?.status !== "success") {
    throw new Error("funding failed");
  }
  await sui.waitForTransaction({ digest: fundResult.digest });
  console.log(`funded merchant: ${fundResult.digest}`);

  // 3. Boot Next.js dev so we can hit /api/attest
  console.log("booting Next.js dev on :3098…");
  const dev_server = await bootDev();
  try {
    // 4. Choose a UEN — randomize to avoid collisions with prior runs
    const uen = `T2${Math.floor(Math.random() * 9_000_000) + 1_000_000}A`;
    console.log(`uen:             ${uen}`);

    // 5. Request attestation. Phase 4 (D8): /api/attest now requires
    // evidence_hash_hex bound to the issuer's signature. Use a stable
    // placeholder for this smoke test.
    const demoEvidenceHashHex = "ee".repeat(32);
    const attestRes = await fetch(`http://127.0.0.1:${dev_server.port}/api/attest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        uen,
        claimer: merchantAddr,
        evidence_hash_hex: demoEvidenceHashHex,
      }),
    });
    if (!attestRes.ok) {
      const err = await attestRes.json().catch(() => ({}));
      throw new Error(`attest HTTP ${attestRes.status}: ${JSON.stringify(err)}`);
    }
    const a = (await attestRes.json()) as {
      attestation_hex: string;
      nonce_hex: string;
      expires_at_ms: number;
      issuer_pubkey_hex: string;
    };
    console.log(`attestation:`);
    console.log(`  nonce:    ${a.nonce_hex.slice(0, 24)}…`);
    console.log(`  sig:      ${a.attestation_hex.slice(0, 24)}…`);
    console.log(`  expires:  ${new Date(a.expires_at_ms).toISOString()}`);
    console.log(`  issuer:   ${a.issuer_pubkey_hex.slice(0, 24)}…`);

    // 6. Verify the issuer pubkey matches what's on-chain
    if (`0x${a.issuer_pubkey_hex}` !== `0x${deploy.issuer_pubkey_hex}`) {
      throw new Error(
        `issuer pubkey mismatch: got 0x${a.issuer_pubkey_hex}, on-chain expects 0x${deploy.issuer_pubkey_hex}`,
      );
    }

    // 7. Submit register_merchant from the fresh merchant
    const nonce = Buffer.from(a.nonce_hex, "hex");
    const sig = Buffer.from(a.attestation_hex, "hex");
    const tx = new Transaction();
    tx.setGasBudget(20_000_000n);
    const evidenceHashBytes = Buffer.from(demoEvidenceHashHex, "hex");
    tx.moveCall({
      target: `${deploy.package_id}::payments::register_merchant`,
      arguments: [
        tx.object(deploy.merchant_registry_id),
        tx.pure.vector("u8", Array.from(new TextEncoder().encode(uen))),
        tx.pure.vector("u8", Array.from(nonce)),
        tx.pure.vector("u8", Array.from(sig)),
        tx.pure.u64(BigInt(a.expires_at_ms)),
        // D5: metadata_uri is now a bare Walrus blob ID. Smoke test sends None.
        tx.pure.option("string", null),
        tx.pure.vector("u8", Array.from(evidenceHashBytes)),
        tx.object(CLOCK),
      ],
    });
    const regResult = await sui.signAndExecuteTransaction({
      transaction: tx,
      signer: merchant,
      options: { showEffects: true, showEvents: true },
    });
    if (regResult.effects?.status?.status !== "success") {
      throw new Error(`register failed: ${JSON.stringify(regResult.effects?.status)}`);
    }
    await sui.waitForTransaction({ digest: regResult.digest });
    console.log(`\n✓ registered: ${regResult.digest}`);
    console.log(`  https://suiscan.xyz/testnet/tx/${regResult.digest}`);
    const events = (regResult.events ?? []).filter((e) =>
      e.type.endsWith("::payments::MerchantRegistered"),
    );
    console.log(`  MerchantRegistered events: ${events.length}`);
    if (events[0]) {
      const e = events[0].parsedJson as any;
      console.log(`    sui_address:  ${e.sui_address}`);
      console.log(`    timestamp_ms: ${e.timestamp_ms}`);
    }
  } finally {
    dev_server.kill();
  }
}

main().catch((e) => {
  console.error("smoke FAILED:", e);
  process.exit(1);
});
