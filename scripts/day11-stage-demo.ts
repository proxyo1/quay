/**
 * Day 11: stage demo merchants on testnet and emit SGQR fixture strings
 * that point at them. Idempotent — re-running skips UENs that are
 * already registered.
 *
 * Outputs:
 *   .secrets/demo-merchant.json   (gitignored; the demo merchant key)
 *   scripts/demo-fixtures.json    (committed; SGQR strings + UENs +
 *                                  metadata for demo day)
 *
 * Run: bun run scripts/day11-stage-demo.ts
 */

import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { bcs } from "@mysten/sui/bcs";
import { blake2b } from "@noble/hashes/blake2.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import deploy from "./deploy-testnet.json";

const REPO_ROOT = "/Users/ryan/projects/suiqr";
const SECRETS_DIR = join(REPO_ROOT, ".secrets");
const DEMO_KEY_FILE = join(SECRETS_DIR, "demo-merchant.json");
const FIXTURES_FILE = join(REPO_ROOT, "scripts", "demo-fixtures.json");

const CLOCK = "0x6";
const sui = new SuiClient({ url: getFullnodeUrl("testnet") });

// ── SGQR builder (inline; mirrors frontend/src/lib/sgqr/builder.ts) ───

const TAG_NAME_MAX = 25;
const TAG_CITY_MAX = 15;

function tlv(tag: string, value: string): string {
  if (!/^\d{2}$/.test(tag)) throw new Error(`bad tag ${tag}`);
  const len = value.length;
  if (len > 99) throw new Error(`tag ${tag} value too long`);
  return tag + len.toString().padStart(2, "0") + value;
}

function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= (bytes[i] & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) crc = ((crc << 1) ^ 0x1021) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function buildSgqr(args: {
  uen: string;
  merchantName: string;
  merchantCity: string;
  amountSgd?: string;
  billRef?: string;
}): string {
  const payNow = tlv("00", "SG.PAYNOW") + tlv("01", "2") + tlv("02", args.uen) + tlv("03", "0");
  let body = tlv("00", "01");
  body += tlv("01", "11"); // static
  body += tlv("26", payNow);
  body += tlv("52", "0000");
  body += tlv("53", "702"); // SGD
  if (args.amountSgd) body += tlv("54", args.amountSgd);
  body += tlv("58", "SG");
  body += tlv("59", args.merchantName.slice(0, TAG_NAME_MAX));
  body += tlv("60", args.merchantCity.slice(0, TAG_CITY_MAX));
  if (args.billRef) body += tlv("62", tlv("01", args.billRef));
  const withPrefix = body + "6304";
  const crc = crc16(new TextEncoder().encode(withPrefix));
  return withPrefix + crc.toString(16).toUpperCase().padStart(4, "0");
}

// ── ClaimMessage BCS shape (identical to Move) ─────────────────────────

const ClaimMessage = bcs.struct("ClaimMessage", {
  domain_tag: bcs.vector(bcs.u8()),
  chain_id: bcs.u8(),
  uen: bcs.vector(bcs.u8()),
  claimer: bcs.bytes(32),
  nonce: bcs.vector(bcs.u8()),
  expires_at_ms: bcs.u64(),
});

// ── Keypair loaders ────────────────────────────────────────────────────

function loadDevKeypair(): Ed25519Keypair {
  const keys = JSON.parse(
    readFileSync(`${process.env.HOME}/.sui/sui_config/sui.keystore`, "utf8"),
  ) as string[];
  const decoded = Buffer.from(keys[0], "base64");
  if (decoded[0] !== 0x00) throw new Error("not ed25519");
  return Ed25519Keypair.fromSecretKey(new Uint8Array(decoded.subarray(1)));
}

function loadIssuer(): Ed25519Keypair {
  const j = JSON.parse(
    readFileSync(join(SECRETS_DIR, "issuer-testnet.json"), "utf8"),
  ) as { secret_key_hex: string };
  return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(j.secret_key_hex, "hex")));
}

function loadOrGenerateDemo(): { kp: Ed25519Keypair; isNew: boolean } {
  if (existsSync(DEMO_KEY_FILE)) {
    const j = JSON.parse(readFileSync(DEMO_KEY_FILE, "utf8")) as { secret_key_hex: string };
    return {
      kp: Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(j.secret_key_hex, "hex"))),
      isNew: false,
    };
  }
  if (!existsSync(SECRETS_DIR)) mkdirSync(SECRETS_DIR, { recursive: true });
  const kp = Ed25519Keypair.generate();
  const { secretKey } = decodeSuiPrivateKey(kp.getSecretKey());
  writeFileSync(
    DEMO_KEY_FILE,
    JSON.stringify(
      {
        network: "testnet",
        scheme: "ed25519",
        secret_key_hex: Buffer.from(secretKey).toString("hex"),
        pubkey_hex: Buffer.from(kp.getPublicKey().toRawBytes()).toString("hex"),
        sui_address: kp.toSuiAddress(),
        generated_at: new Date().toISOString(),
        note: "suiqr demo-day merchant. Owns multiple UENs for the dress rehearsal.",
      },
      null,
      2,
    ),
  );
  return { kp, isNew: true };
}

function addressToBytes(addr: string): Uint8Array {
  const hex = addr.replace(/^0x/, "").padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── Demo merchant catalog ──────────────────────────────────────────────

const DEMO_MERCHANTS = [
  {
    uen: "T11KH0001A",
    name: "KOPI HOUSE",
    city: "Singapore",
    suggestedSgd: "3.50",
    description: "$3.50 SGD kopi-o + kaya toast set",
  },
  {
    uen: "T11CR0002B",
    name: "AH HUAT CHICKEN RICE",
    city: "Singapore",
    suggestedSgd: "5.00",
    description: "$5.00 SGD chicken rice plate",
  },
  {
    uen: "T11PS0003C",
    name: "WEST COAST PRINT SHOP",
    city: "Singapore",
    suggestedSgd: "12.00",
    description: "$12.00 SGD bulk photocopy job",
  },
];

async function isUenClaimed(uen: string): Promise<boolean> {
  try {
    const tx = new Transaction();
    tx.moveCall({
      target: `${deploy.package_id}::payments::is_registered`,
      arguments: [
        tx.object(deploy.merchant_registry_id),
        tx.pure.vector("u8", Array.from(new TextEncoder().encode(uen))),
      ],
    });
    const r = await sui.devInspectTransactionBlock({
      sender: "0x0",
      transactionBlock: tx,
    });
    if (r.effects?.status?.status !== "success") return false;
    const ret = r.results?.[0]?.returnValues?.[0];
    if (!ret) return false;
    const [bytes] = ret as [number[], string];
    return bytes.length > 0 && bytes[0] === 1;
  } catch {
    return false;
  }
}

async function main() {
  console.log("Day 11 stage: demo merchants on testnet\n");

  const dev = loadDevKeypair();
  const issuer = loadIssuer();
  const { kp: demo, isNew } = loadOrGenerateDemo();
  const demoAddr = demo.toSuiAddress();
  console.log(`demo merchant wallet: ${demoAddr}${isNew ? " (new)" : " (existing)"}`);

  // Top up the demo wallet so it has gas to register multiple UENs
  const balance = await sui.getBalance({ owner: demoAddr });
  if (BigInt(balance.totalBalance) < 50_000_000n) {
    console.log(`funding demo wallet from dev (${(50_000_000n - BigInt(balance.totalBalance)) / 1_000_000n}M MIST)…`);
    const fundTx = new Transaction();
    fundTx.setGasBudget(10_000_000n);
    const [c] = fundTx.splitCoins(fundTx.gas, [fundTx.pure.u64(50_000_000n)]);
    fundTx.transferObjects([c], fundTx.pure.address(demoAddr));
    const r = await sui.signAndExecuteTransaction({
      transaction: fundTx,
      signer: dev,
      options: { showEffects: true },
    });
    await sui.waitForTransaction({ digest: r.digest });
    console.log(`fund tx: ${r.digest}`);
  } else {
    console.log(`demo balance: ${(Number(balance.totalBalance) / 1e9).toFixed(4)} SUI (sufficient)`);
  }

  const fixtures: Array<{
    uen: string;
    name: string;
    city: string;
    suggested_sgd: string;
    description: string;
    merchant_address: string;
    sgqr_static: string;
    sgqr_with_amount: string;
    register_tx?: string;
    status: "registered" | "already_registered";
  }> = [];

  for (const m of DEMO_MERCHANTS) {
    console.log(`\n— ${m.uen} (${m.name}) —`);
    const already = await isUenClaimed(m.uen);
    let status: "registered" | "already_registered" = "already_registered";
    let registerTx: string | undefined;

    if (!already) {
      const nonce = new Uint8Array(32);
      crypto.getRandomValues(nonce);
      const expiresAtMs = BigInt(Date.now() + 60 * 60 * 1000);

      const msgBytes = ClaimMessage.serialize({
        domain_tag: Array.from(new TextEncoder().encode("SUIQR_CLAIM_V1")),
        chain_id: deploy.chain_id,
        uen: Array.from(new TextEncoder().encode(m.uen)),
        claimer: addressToBytes(demoAddr),
        nonce: Array.from(nonce),
        expires_at_ms: expiresAtMs,
      }).toBytes();
      const msgHash = blake2b(msgBytes, { dkLen: 32 });
      const sig = await issuer.sign(msgHash);

      const tx = new Transaction();
      tx.setGasBudget(20_000_000n);
      tx.moveCall({
        target: `${deploy.package_id}::payments::register_merchant`,
        arguments: [
          tx.object(deploy.merchant_registry_id),
          tx.pure.vector("u8", Array.from(new TextEncoder().encode(m.uen))),
          tx.pure.vector("u8", Array.from(nonce)),
          tx.pure.vector("u8", Array.from(sig)),
          tx.pure.u64(expiresAtMs),
          tx.pure.option("string", null),
          tx.object(CLOCK),
        ],
      });

      const r = await sui.signAndExecuteTransaction({
        transaction: tx,
        signer: demo,
        options: { showEffects: true },
      });
      if (r.effects?.status?.status !== "success") {
        console.error(`register failed: ${JSON.stringify(r.effects?.status)}`);
        continue;
      }
      await sui.waitForTransaction({ digest: r.digest });
      console.log(`  registered: ${r.digest}`);
      status = "registered";
      registerTx = r.digest;
    } else {
      console.log("  already registered — skipping");
    }

    const sgqrStatic = buildSgqr({
      uen: m.uen,
      merchantName: m.name,
      merchantCity: m.city,
    });
    const sgqrWithAmount = buildSgqr({
      uen: m.uen,
      merchantName: m.name,
      merchantCity: m.city,
      amountSgd: m.suggestedSgd,
    });

    fixtures.push({
      uen: m.uen,
      name: m.name,
      city: m.city,
      suggested_sgd: m.suggestedSgd,
      description: m.description,
      merchant_address: demoAddr,
      sgqr_static: sgqrStatic,
      sgqr_with_amount: sgqrWithAmount,
      register_tx: registerTx,
      status,
    });

    console.log(`  sgqr (static, ${sgqrStatic.length}c): ${sgqrStatic.slice(0, 60)}…`);
  }

  writeFileSync(
    FIXTURES_FILE,
    JSON.stringify(
      {
        network: "testnet",
        package_id: deploy.package_id,
        registry_id: deploy.merchant_registry_id,
        merchant_address: demoAddr,
        captured_at: new Date().toISOString(),
        merchants: fixtures,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${FIXTURES_FILE} (${fixtures.length} merchants)`);
  console.log("\nTry one on /scan:");
  if (fixtures[0]) console.log(`  ${fixtures[0].sgqr_static.slice(0, 80)}…`);
}

main().catch((e) => {
  console.error("stage FAILED:", e);
  process.exit(1);
});
