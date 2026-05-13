/**
 * Day 2: publish suiqr::payments to Sui testnet, set initial issuer pubkey,
 * register a test merchant, and run a pay flow end-to-end.
 *
 * Run: bun run scripts/day2-deploy.ts
 *
 * Outputs:
 *   - .secrets/issuer-testnet.json   (gitignored; contains issuer privkey)
 *   - scripts/deploy-testnet.json    (committed; all on-chain IDs + txn digests)
 *
 * Assumptions:
 *   - sui client is configured for testnet (`sui client active-env` = testnet)
 *   - The active address has at least 0.5 SUI in gas
 *   - `sui move build` works in move/quay/
 *
 * Walrus integration redeploy (D4 cutover):
 *   The ClaimMessage shape and MerchantEntry shape both changed for the
 *   Walrus integration (uen_raw + evidence_hash). Old attestations cannot
 *   verify against the new contract. To force a clean redeploy:
 *     1. Move scripts/deploy-testnet.json to scripts/deploy-testnet.v1.json
 *        (or delete it). Resume mode skips if package_id is set.
 *     2. Run `bun run scripts/day2-deploy.ts`.
 *     3. Update frontend/src/lib/sui-config.ts with the new package_id /
 *        merchant_registry_id from the freshly written deploy-testnet.json.
 *     4. Re-onboard any test merchants through /merchant/onboard.
 */

import { SuiJsonRpcClient as SuiClient, getJsonRpcFullnodeUrl as getFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { bcs } from "@mysten/sui/bcs";
import { blake2b } from "@noble/hashes/blake2.js";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────

const REPO_ROOT = "/Users/ryan/projects/suiqr";
const MOVE_PKG = `${REPO_ROOT}/move/quay`;
const SECRETS_DIR = `${REPO_ROOT}/.secrets`;
const ISSUER_KEY_FILE = `${SECRETS_DIR}/issuer-testnet.json`;
const DEPLOY_CONFIG_FILE = `${REPO_ROOT}/scripts/deploy-testnet.json`;
const SUI_KEYSTORE = `${process.env.HOME}/.sui/sui_config/sui.keystore`;

const CHAIN_ID_TESTNET = 0; // u8; persisted in registry at init
const GAS_BUDGET_PUBLISH = 200_000_000n; // 0.2 SUI ceiling
const GAS_BUDGET_CALL = 50_000_000n;     // 0.05 SUI ceiling
const MERCHANT_FUNDING_MIST = 50_000_000n; // 0.05 SUI from dev → merchant1
const PAY_AMOUNT_MIST = 1_500_000n;        // 0.0015 SUI; demo "ticket"

const client = new SuiClient({ url: getFullnodeUrl("testnet") });

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function logStep(n: number, label: string) {
  console.log(`\n─── Step ${n}: ${label} ───────────────────────────────────`);
}

function loadDevKeypair(): Ed25519Keypair {
  const keys = JSON.parse(readFileSync(SUI_KEYSTORE, "utf8")) as string[];
  if (keys.length === 0) throw new Error("sui.keystore is empty");
  // Each entry is base64(scheme_byte || priv_key_32_bytes)
  const decoded = Buffer.from(keys[0], "base64");
  if (decoded.length !== 33) throw new Error(`unexpected key length ${decoded.length}`);
  if (decoded[0] !== 0x00) throw new Error(`scheme byte ${decoded[0]} not ed25519`);
  return Ed25519Keypair.fromSecretKey(new Uint8Array(decoded.subarray(1)));
}

const ClaimMessage = bcs.struct("ClaimMessage", {
  domain_tag: bcs.vector(bcs.u8()),
  chain_id: bcs.u8(),
  uen: bcs.vector(bcs.u8()),
  claimer: bcs.bytes(32),
  nonce: bcs.vector(bcs.u8()),
  expires_at_ms: bcs.u64(),
  // Walrus integration (D8): the issuer signs over a 32-byte content hash
  // of the off-chain evidence (form snapshot, sticker photo, etc.). The
  // demo uses a stable placeholder so the deploy is reproducible.
  evidence_hash: bcs.vector(bcs.u8()),
});

// 32 bytes of 0xEE — matches the test-vector evidence_hash so deploy
// behavior mirrors the unit tests. Real merchants get a hash derived
// from their actual evidence content via /api/sponsor/register.
const DEMO_EVIDENCE_HASH = new Uint8Array(32).fill(0xee);

function signClaim(args: {
  issuerSecretKey: Uint8Array;
  chainId: number;
  uen: Uint8Array;
  claimer: Uint8Array; // 32 bytes
  nonce: Uint8Array;
  expiresAtMs: bigint;
}): { msgBytes: Uint8Array; msgHash: Uint8Array; sig: Uint8Array; pubkey: Uint8Array } {
  const issuerKp = Ed25519Keypair.fromSecretKey(args.issuerSecretKey);
  const msgBytes = ClaimMessage.serialize({
    domain_tag: Array.from(new TextEncoder().encode("QUAY_CLAIM_V1")),
    chain_id: args.chainId,
    uen: Array.from(args.uen),
    claimer: args.claimer,
    nonce: Array.from(args.nonce),
    expires_at_ms: args.expiresAtMs,
  }).toBytes();
  const msgHash = blake2b(msgBytes, { dkLen: 32 });
  // Ed25519Keypair.sign returns the raw 64-byte sig over the input
  // (not Sui-tx-flavored). That's what ed25519_verify expects.
  return {
    msgBytes,
    msgHash,
    sig: new Uint8Array(0), // filled below; sign is async
    pubkey: issuerKp.getPublicKey().toRawBytes(),
  };
}

function addressToBytes(addr: string): Uint8Array {
  const hex = addr.startsWith("0x") ? addr.slice(2) : addr;
  const padded = hex.padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function waitForGas(addr: string, minMist: bigint, label: string) {
  for (let i = 0; i < 30; i++) {
    const { totalBalance } = await client.getBalance({ owner: addr });
    if (BigInt(totalBalance) >= minMist) {
      console.log(`   ${label}: ${(Number(totalBalance) / 1e9).toFixed(4)} SUI`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} did not reach ${minMist} mist within 30s`);
}

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────

async function waitForPackageVisible(packageId: string, label: string) {
  // Sui has a small delay between publish-tx finality and the package being
  // queryable from the JSON-RPC node. Poll up to 30s.
  for (let i = 0; i < 30; i++) {
    try {
      const obj = await client.getObject({ id: packageId, options: { showType: true } });
      if (obj.data?.objectId) {
        console.log(`   ${label}: visible after ${i + 1}s`);
        return;
      }
    } catch {
      // ignore — RPC may return error before propagation
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Package ${packageId} not visible on RPC within 30s`);
}

async function settle(digest: string) {
  // Wait for the tx to be processed and visible to subsequent reads.
  await client.waitForTransaction({ digest });
}

async function isIssuerSet(packageId: string, registryId: string): Promise<boolean> {
  const obj = await client.getObject({
    id: registryId,
    options: { showContent: true },
  });
  const fields = (obj.data?.content as any)?.fields;
  const issuer = fields?.issuer_pubkey as number[] | undefined;
  return Array.isArray(issuer) && issuer.length > 0;
}

async function main() {
  if (!existsSync(SECRETS_DIR)) mkdirSync(SECRETS_DIR, { recursive: true });

  // Resume from existing deploy-testnet.json if it has package_id.
  let existingConfig: any = null;
  if (existsSync(DEPLOY_CONFIG_FILE)) {
    existingConfig = JSON.parse(readFileSync(DEPLOY_CONFIG_FILE, "utf8"));
    if (existingConfig.package_id) {
      console.log(`Resuming from ${DEPLOY_CONFIG_FILE} (package ${existingConfig.package_id.slice(0, 10)}...)`);
    } else {
      existingConfig = null;
    }
  }

  // ── Step 1: Load dev keypair (publisher + admin) ────────────────────
  logStep(1, "Load dev keypair from Sui keystore (publisher = admin)");
  const dev = loadDevKeypair();
  const devAddr = dev.toSuiAddress();
  console.log(`   dev addr: ${devAddr}`);
  await waitForGas(devAddr, 100_000_000n, "dev gas");

  // ── Step 2: Generate / load issuer keypair ──────────────────────────
  logStep(2, "Generate or load issuer ed25519 keypair");
  let issuerSecret: Uint8Array;
  let issuerPubkey: Uint8Array;
  if (existsSync(ISSUER_KEY_FILE)) {
    const j = JSON.parse(readFileSync(ISSUER_KEY_FILE, "utf8"));
    issuerSecret = Uint8Array.from(Buffer.from(j.secret_key_hex, "hex"));
    issuerPubkey = Uint8Array.from(Buffer.from(j.pubkey_hex, "hex"));
    console.log(`   loaded existing issuer key from ${ISSUER_KEY_FILE}`);
  } else {
    const issuerKp = Ed25519Keypair.generate();
    issuerSecret = issuerKp.getSecretKey()
      ? // SDK exports bech32; we need raw bytes. Round-trip via the
        // SDK's internal API: re-derive from the bech32 form.
        (await import("@mysten/sui/cryptography")).decodeSuiPrivateKey(issuerKp.getSecretKey()).secretKey
      : new Uint8Array(0);
    issuerPubkey = issuerKp.getPublicKey().toRawBytes();
    writeFileSync(
      ISSUER_KEY_FILE,
      JSON.stringify(
        {
          network: "testnet",
          scheme: "ed25519",
          secret_key_hex: Buffer.from(issuerSecret).toString("hex"),
          pubkey_hex: Buffer.from(issuerPubkey).toString("hex"),
          sui_address: issuerKp.toSuiAddress(),
          generated_at: new Date().toISOString(),
          note: "Local dev key for suiqr testnet attestations. NOT for mainnet.",
        },
        null,
        2,
      ),
    );
    console.log(`   generated and saved to ${ISSUER_KEY_FILE}`);
  }
  console.log(`   issuer pubkey: 0x${Buffer.from(issuerPubkey).toString("hex")}`);

  let PACKAGE_ID: string;
  let REGISTRY_ID: string;
  let ADMIN_CAP_ID: string;
  let publishDigest: string;

  if (existingConfig) {
    PACKAGE_ID = existingConfig.package_id;
    REGISTRY_ID = existingConfig.merchant_registry_id;
    ADMIN_CAP_ID = existingConfig.admin_cap_id;
    publishDigest = existingConfig.digests?.publish ?? "(prior run)";
    console.log("\n   skipping build + publish (resume mode)");
  } else {
    // ── Step 3: Build Move package and parse bytecode ─────────────────
    logStep(3, "Build Move package (--dump-bytecode-as-base64)");
    const buildOut = execSync(`cd ${MOVE_PKG} && sui move build --dump-bytecode-as-base64`, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    const lines = buildOut.trim().split("\n");
    const jsonLine = lines.find((l) => l.startsWith("{") && l.includes("modules")) ?? lines[lines.length - 1];
    const buildJson = JSON.parse(jsonLine) as { modules: string[]; dependencies: string[]; digest: number[] };
    console.log(`   modules: ${buildJson.modules.length}; deps: ${buildJson.dependencies.length}`);

    // ── Step 4: Publish ───────────────────────────────────────────────
    logStep(4, "Publish suiqr::payments to testnet");
    const publishTx = new Transaction();
    publishTx.setGasBudget(GAS_BUDGET_PUBLISH);
    const [upgradeCap] = publishTx.publish({
      modules: buildJson.modules,
      dependencies: buildJson.dependencies,
    });
    publishTx.transferObjects([upgradeCap], publishTx.pure.address(devAddr));

    const publishResult = await client.signAndExecuteTransaction({
      transaction: publishTx,
      signer: dev,
      options: { showEffects: true, showObjectChanges: true, showEvents: true },
    });

    if (publishResult.effects?.status?.status !== "success") {
      console.error("Publish failed:", JSON.stringify(publishResult.effects?.status, null, 2));
      process.exit(1);
    }

    const objectChanges = publishResult.objectChanges ?? [];
    const publishedPackage = objectChanges.find((c) => c.type === "published") as
      | { packageId: string; modules: string[] }
      | undefined;
    if (!publishedPackage) throw new Error("no 'published' object change in result");

    const created = objectChanges.filter((c) => c.type === "created") as Array<{
      objectType: string;
      objectId: string;
      owner: any;
    }>;
    const registry = created.find((c) => c.objectType.endsWith("::payments::MerchantRegistry"));
    const adminCap = created.find((c) => c.objectType.endsWith("::payments::AdminCap"));
    if (!registry) throw new Error("MerchantRegistry not created");
    if (!adminCap) throw new Error("AdminCap not created");

    PACKAGE_ID = publishedPackage.packageId;
    REGISTRY_ID = registry.objectId;
    ADMIN_CAP_ID = adminCap.objectId;
    publishDigest = publishResult.digest;

    console.log(`   package:        ${PACKAGE_ID}`);
    console.log(`   registry:       ${REGISTRY_ID}`);
    console.log(`   admin_cap:      ${ADMIN_CAP_ID}`);
    console.log(`   publish digest: ${publishDigest}`);

    // Persist immediately so the next run can resume even if subsequent
    // steps fail.
    writeFileSync(
      DEPLOY_CONFIG_FILE,
      JSON.stringify(
        {
          network: "testnet",
          chain_id: CHAIN_ID_TESTNET,
          package_id: PACKAGE_ID,
          merchant_registry_id: REGISTRY_ID,
          admin_cap_id: ADMIN_CAP_ID,
          admin_address: devAddr,
          issuer_pubkey_hex: Buffer.from(issuerPubkey).toString("hex"),
          digests: { publish: publishDigest },
          status: "publish_complete_pending_init",
          deployed_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }

  // Wait for the package to be readable from the RPC before any moveCall
  // that needs to introspect its ABI.
  logStep(4.5, "Wait for package to be readable from RPC");
  await waitForPackageVisible(PACKAGE_ID, "package");

  // ── Step 5: set_initial_issuer_pubkey ───────────────────────────────
  logStep(5, "Call set_initial_issuer_pubkey");
  let setIssuerDigest = existingConfig?.digests?.set_initial_issuer_pubkey ?? "(prior run)";
  if (await isIssuerSet(PACKAGE_ID, REGISTRY_ID)) {
    console.log("   already set on-chain — skipping");
  } else {
    const setIssuerTx = new Transaction();
    setIssuerTx.setGasBudget(GAS_BUDGET_CALL);
    setIssuerTx.moveCall({
      target: `${PACKAGE_ID}::payments::set_initial_issuer_pubkey`,
      arguments: [
        setIssuerTx.object(REGISTRY_ID),
        setIssuerTx.pure.vector("u8", Array.from(issuerPubkey)),
        setIssuerTx.pure.u8(CHAIN_ID_TESTNET),
      ],
    });
    const setIssuerResult = await client.signAndExecuteTransaction({
      transaction: setIssuerTx,
      signer: dev,
      options: { showEffects: true },
    });
    if (setIssuerResult.effects?.status?.status !== "success") {
      console.error("set_initial_issuer_pubkey failed:", JSON.stringify(setIssuerResult.effects?.status, null, 2));
      process.exit(1);
    }
    setIssuerDigest = setIssuerResult.digest;
    console.log(`   set_issuer digest: ${setIssuerDigest}`);
    await settle(setIssuerDigest);
  }

  // ── Step 6: Generate merchant1 keypair, fund from dev ───────────────
  logStep(6, "Generate merchant1 keypair, fund from dev (0.05 SUI)");
  const merchant1 = Ed25519Keypair.generate();
  const merchant1Addr = merchant1.toSuiAddress();
  console.log(`   merchant1 addr: ${merchant1Addr}`);

  const fundTx = new Transaction();
  fundTx.setGasBudget(GAS_BUDGET_CALL);
  const [coin] = fundTx.splitCoins(fundTx.gas, [fundTx.pure.u64(MERCHANT_FUNDING_MIST)]);
  fundTx.transferObjects([coin], fundTx.pure.address(merchant1Addr));
  const fundResult = await client.signAndExecuteTransaction({
    transaction: fundTx,
    signer: dev,
    options: { showEffects: true },
  });
  if (fundResult.effects?.status?.status !== "success") {
    console.error("Funding merchant1 failed:", JSON.stringify(fundResult.effects?.status, null, 2));
    process.exit(1);
  }
  console.log(`   fund digest: ${fundResult.digest}`);
  await settle(fundResult.digest);
  await waitForGas(merchant1Addr, MERCHANT_FUNDING_MIST - 5_000_000n, "merchant1 gas");

  // ── Step 7: Sign attestation for merchant1 ──────────────────────────
  logStep(7, "Sign attestation for merchant1 (off-chain, with issuer key)");
  const issuerKp = Ed25519Keypair.fromSecretKey(issuerSecret);
  const merchantUen = new TextEncoder().encode("202412345Z"); // sample SG UEN
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  // 1 hour from now
  const expiresAtMs = BigInt(Date.now() + 60 * 60 * 1000);
  const claimerBytes = addressToBytes(merchant1Addr);

  const msgBytes = ClaimMessage.serialize({
    domain_tag: Array.from(new TextEncoder().encode("QUAY_CLAIM_V1")),
    chain_id: CHAIN_ID_TESTNET,
    uen: Array.from(merchantUen),
    claimer: claimerBytes,
    nonce: Array.from(nonce),
    expires_at_ms: expiresAtMs,
    evidence_hash: Array.from(DEMO_EVIDENCE_HASH),
  }).toBytes();
  const msgHash = blake2b(msgBytes, { dkLen: 32 });
  const sig = await issuerKp.sign(msgHash);
  console.log(`   uen:         ${new TextDecoder().decode(merchantUen)}`);
  console.log(`   expires:     ${new Date(Number(expiresAtMs)).toISOString()}`);
  console.log(`   msg hash:    0x${Buffer.from(msgHash).toString("hex")}`);
  console.log(`   sig:         0x${Buffer.from(sig).toString("hex").slice(0, 32)}...`);

  // ── Step 8: register_merchant (as merchant1) ────────────────────────
  logStep(8, "Submit register_merchant signed by merchant1");
  const registerTx = new Transaction();
  registerTx.setGasBudget(GAS_BUDGET_CALL);
  registerTx.moveCall({
    target: `${PACKAGE_ID}::payments::register_merchant`,
    arguments: [
      registerTx.object(REGISTRY_ID),
      registerTx.pure.vector("u8", Array.from(merchantUen)),
      registerTx.pure.vector("u8", Array.from(nonce)),
      registerTx.pure.vector("u8", Array.from(sig)),
      registerTx.pure.u64(expiresAtMs),
      // D5: metadata_uri is now a bare Walrus blob ID. The demo leaves it
      // None — real merchants supply one via the onboarding logo picker.
      registerTx.pure.option("string", null),
      // D8: evidence_hash (32 bytes) — the issuer's commitment to the
      // off-chain evidence content. Must match what's in the signed message.
      registerTx.pure.vector("u8", Array.from(DEMO_EVIDENCE_HASH)),
      registerTx.object("0x6"), // Clock — well-known shared object
    ],
  });
  const registerResult = await client.signAndExecuteTransaction({
    transaction: registerTx,
    signer: merchant1,
    options: { showEffects: true, showEvents: true },
  });
  if (registerResult.effects?.status?.status !== "success") {
    console.error("register_merchant failed:", JSON.stringify(registerResult.effects?.status, null, 2));
    process.exit(1);
  }
  console.log(`   register digest: ${registerResult.digest}`);
  const merchantEvents = (registerResult.events ?? []).filter((e) =>
    e.type.endsWith("::payments::MerchantRegistered"),
  );
  console.log(`   MerchantRegistered events: ${merchantEvents.length}`);
  await settle(registerResult.digest);

  // ── Step 9: pay (dev → merchant1) ───────────────────────────────────
  logStep(9, "Submit pay (dev pays merchant1)");
  const payTx = new Transaction();
  payTx.setGasBudget(GAS_BUDGET_CALL);
  const [payCoin] = payTx.splitCoins(payTx.gas, [payTx.pure.u64(PAY_AMOUNT_MIST)]);
  payTx.moveCall({
    target: `${PACKAGE_ID}::payments::pay`,
    typeArguments: ["0x2::sui::SUI"],
    arguments: [
      payTx.object(REGISTRY_ID),
      payTx.pure.vector("u8", Array.from(merchantUen)),
      payCoin,
      payTx.pure.option("vector<u8>", Array.from(new TextEncoder().encode("chicken rice $1.50"))),
      payTx.pure.u64(150n), // SGD minor units: $1.50
      payTx.pure.option("vector<u8>", null), // quote_metadata empty for testnet demo
      payTx.object("0x6"), // Clock
    ],
  });
  const payResult = await client.signAndExecuteTransaction({
    transaction: payTx,
    signer: dev,
    options: { showEffects: true, showEvents: true },
  });
  if (payResult.effects?.status?.status !== "success") {
    console.error("pay failed:", JSON.stringify(payResult.effects?.status, null, 2));
    process.exit(1);
  }
  console.log(`   pay digest: ${payResult.digest}`);
  const receiptEvents = (payResult.events ?? []).filter((e) => e.type.endsWith("::payments::PaymentReceipt"));
  console.log(`   PaymentReceipt events: ${receiptEvents.length}`);
  if (receiptEvents[0]) {
    const r = receiptEvents[0].parsedJson as any;
    console.log(`     payer:    ${r.payer}`);
    console.log(`     merchant: ${r.merchant}`);
    console.log(`     amount:   ${r.amount} mist`);
    console.log(`     sgd_minor: ${r.sgd_minor_units}`);
  }

  // ── Step 10: Write deploy config ────────────────────────────────────
  logStep(10, "Write scripts/deploy-testnet.json");
  const deployConfig = {
    network: "testnet",
    chain_id: CHAIN_ID_TESTNET,
    package_id: PACKAGE_ID,
    merchant_registry_id: REGISTRY_ID,
    admin_cap_id: ADMIN_CAP_ID,
    admin_address: devAddr,
    issuer_pubkey_hex: Buffer.from(issuerPubkey).toString("hex"),
    digests: {
      publish: publishDigest,
      set_initial_issuer_pubkey: setIssuerDigest,
      fund_merchant1: fundResult.digest,
      register_merchant1: registerResult.digest,
      pay_demo: payResult.digest,
    },
    demo_merchant1: {
      sui_address: merchant1Addr,
      uen: new TextDecoder().decode(merchantUen),
    },
    status: "complete",
    deployed_at: new Date().toISOString(),
  };
  writeFileSync(DEPLOY_CONFIG_FILE, JSON.stringify(deployConfig, null, 2));
  console.log(`   wrote ${DEPLOY_CONFIG_FILE}`);

  console.log("\n✓ Day 2 complete.");
  console.log(`\nView on Sui explorer:`);
  console.log(`  package:    https://suiscan.xyz/testnet/object/${PACKAGE_ID}`);
  console.log(`  registry:   https://suiscan.xyz/testnet/object/${REGISTRY_ID}`);
  console.log(`  pay tx:     https://suiscan.xyz/testnet/tx/${payResult.digest}`);
}

main().catch((e) => {
  console.error("\n✗ Day 2 failed:", e);
  process.exit(1);
});
