/**
 * Day 7 smoke: a fresh zero-SUI wallet registers a merchant via the
 * quay sponsored-gas mechanism. The sponsor wallet pays the gas; the
 * fresh wallet only signs to authorize. Proves AD: sponsored-tx works
 * end-to-end on testnet against the live payments module.
 *
 * This is the headless equivalent of what /api/sponsor wraps.
 */

import {
  SuiJsonRpcClient as SuiClient,
  getJsonRpcFullnodeUrl as getFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { bcs } from "@mysten/sui/bcs";
import { blake2b } from "@noble/hashes/blake2.js";
import { readFileSync } from "node:fs";

import deploy from "./deploy-testnet.json";

const CLOCK = "0x6";
const sui = new SuiClient({ url: getFullnodeUrl("testnet") });

const ClaimMessage = bcs.struct("ClaimMessage", {
  domain_tag: bcs.vector(bcs.u8()),
  chain_id: bcs.u8(),
  uen: bcs.vector(bcs.u8()),
  claimer: bcs.bytes(32),
  nonce: bcs.vector(bcs.u8()),
  expires_at_ms: bcs.u64(),
  evidence_hash: bcs.vector(bcs.u8()),
});

// 32 bytes of 0xEE — stable smoke-test placeholder matching unit-test vectors.
const DEMO_EVIDENCE_HASH = new Uint8Array(32).fill(0xee);

function loadSponsor(): Ed25519Keypair {
  const j = JSON.parse(
    readFileSync("/Users/ryan/projects/suiqr/.secrets/sponsor-testnet.json", "utf8"),
  ) as { secret_key_hex: string };
  return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(j.secret_key_hex, "hex")));
}

function loadIssuer(): Ed25519Keypair {
  const j = JSON.parse(
    readFileSync("/Users/ryan/projects/suiqr/.secrets/issuer-testnet.json", "utf8"),
  ) as { secret_key_hex: string };
  return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(j.secret_key_hex, "hex")));
}

function addressToBytes(addr: string): Uint8Array {
  const hex = addr.replace(/^0x/, "").padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function main() {
  console.log("Day 7 smoke: sponsored register_merchant from 0-SUI wallet\n");

  const sender = Ed25519Keypair.generate();
  const senderAddr = sender.toSuiAddress();
  console.log(`fresh sender (0 SUI): ${senderAddr}`);

  const sponsor = loadSponsor();
  const sponsorAddr = sponsor.toSuiAddress();
  const sponsorBal = await sui.getBalance({ owner: sponsorAddr });
  console.log(`sponsor: ${sponsorAddr}`);
  console.log(`sponsor balance: ${(Number(sponsorBal.totalBalance) / 1e9).toFixed(4)} SUI`);

  const senderBalBefore = await sui.getBalance({ owner: senderAddr });
  console.log(`sender balance before: ${senderBalBefore.totalBalance} MIST (must be 0)`);
  if (senderBalBefore.totalBalance !== "0") {
    throw new Error("expected sender to start with 0 SUI");
  }

  // Sign an attestation for the fresh wallet using the issuer key
  const issuer = loadIssuer();
  const uen = `T7${Math.floor(Math.random() * 9_000_000) + 1_000_000}A`;
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  const expiresAtMs = BigInt(Date.now() + 30 * 60 * 1000);

  const msgBytes = ClaimMessage.serialize({
    domain_tag: Array.from(new TextEncoder().encode("QUAY_CLAIM_V1")),
    chain_id: deploy.chain_id,
    uen: Array.from(new TextEncoder().encode(uen)),
    claimer: addressToBytes(senderAddr),
    nonce: Array.from(nonce),
    expires_at_ms: expiresAtMs,
    evidence_hash: Array.from(DEMO_EVIDENCE_HASH),
  }).toBytes();
  const msgHash = blake2b(msgBytes, { dkLen: 32 });
  const sig = await issuer.sign(msgHash);
  console.log(`\nattestation issued for UEN ${uen}`);

  // Build sponsored tx: sender = fresh wallet, gas_owner = sponsor
  const tx = new Transaction();
  tx.setSender(senderAddr);
  tx.setGasOwner(sponsorAddr);
  tx.setGasBudget(20_000_000n);

  tx.moveCall({
    target: `${deploy.package_id}::payments::register_merchant`,
    arguments: [
      tx.object(deploy.merchant_registry_id),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(uen))),
      tx.pure.vector("u8", Array.from(nonce)),
      tx.pure.vector("u8", Array.from(sig)),
      tx.pure.u64(expiresAtMs),
      tx.pure.option("string", null),
      tx.pure.vector("u8", Array.from(DEMO_EVIDENCE_HASH)),
      tx.object(CLOCK),
    ],
  });

  // Build to bytes — the SDK fetches a gas coin owned by sponsorAddr
  const bytes = await tx.build({ client: sui });
  console.log(`tx bytes: ${bytes.length}`);

  // Both parties sign the same bytes
  const senderSig = await sender.signTransaction(bytes);
  const sponsorSig = await sponsor.signTransaction(bytes);

  console.log("submitting with sender + sponsor signatures…");
  const result = await sui.executeTransactionBlock({
    transactionBlock: bytes,
    signature: [senderSig.signature, sponsorSig.signature],
    options: { showEffects: true, showEvents: true },
  });
  if (result.effects?.status?.status !== "success") {
    throw new Error(`sponsored tx failed: ${JSON.stringify(result.effects?.status)}`);
  }
  await sui.waitForTransaction({ digest: result.digest });
  console.log(`\n✓ sponsored register tx: ${result.digest}`);
  console.log(`  https://suiscan.xyz/testnet/tx/${result.digest}`);

  const events = (result.events ?? []).filter((e) =>
    e.type.endsWith("::payments::MerchantRegistered"),
  );
  console.log(`  MerchantRegistered events: ${events.length}`);

  // Verify the sender STILL has 0 SUI (proves sponsor paid gas)
  const senderBalAfter = await sui.getBalance({ owner: senderAddr });
  console.log(`sender balance after: ${senderBalAfter.totalBalance} MIST`);
  if (senderBalAfter.totalBalance !== "0") {
    console.log("  WARNING: sender accumulated some SUI; expected 0");
  } else {
    console.log("  ✓ sender still at 0 SUI — sponsor paid all gas");
  }
}

main().catch((e) => {
  console.error("smoke FAILED:", e);
  process.exit(1);
});
