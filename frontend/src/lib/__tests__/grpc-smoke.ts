/**
 * Live mainnet smoke test for the gRPC + GraphQL transports.
 *
 * NOT a unit test — it hits the network, so it is deliberately outside the
 * `bun test src/lib` suite (no `.test.ts` suffix) and is run by hand:
 *
 *   cd frontend && bun run src/lib/__tests__/grpc-smoke.ts
 *
 * It exercises the paths that broke when Sui retired JSON-RPC, through the
 * real modules rather than a re-implementation, so a green run means the app's
 * own code can read chain state again.
 */

import { QUAY } from "@/lib/sui-config";
import { getSuiClient, SUI_GRPC_URL } from "@/lib/sui-client";
import { getEntriesTableId, lookupUen, listOwnedMerchantEntries } from "@/lib/quay/lookup";
import { queryEventsByType, SUI_GRAPHQL_URL } from "@/lib/quay/events";
import { MerchantEntryBcs } from "@/lib/quay/move-bcs";
import {
  USDSUI,
  getPoolCash,
  getSharePrice,
  readBalanceSheet,
  preflightScallopHealthy,
} from "@/lib/quay/scallop";

const sui = getSuiClient();
let failures = 0;

async function check(name: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name}: ${detail}`);
  } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`gRPC:    ${SUI_GRPC_URL}`);
console.log(`GraphQL: ${SUI_GRAPHQL_URL}\n`);

console.log("registry (gRPC + BCS)");
await check("getEntriesTableId", async () => {
  const id = await getEntriesTableId(sui, QUAY.registryId);
  if (!id.startsWith("0x")) throw new Error(`bad table id ${id}`);
  return id.slice(0, 18) + "…";
});

// Discover a real registered merchant from the registry table itself, so this
// keeps working as the registry changes AND does not depend on event history.
let sampleUen: string | null = null;
let sampleOwner: string | null = null;
await check("enumerate registry table", async () => {
  const tableId = await getEntriesTableId(sui, QUAY.registryId);
  const page = await sui.listDynamicFields({
    parentId: tableId,
    limit: 10,
    include: { value: true },
  });
  const first = page.dynamicFields.find((f) => f.value?.bcs);
  if (!first?.value?.bcs) throw new Error("registry table is empty");
  const entry = MerchantEntryBcs.parse(first.value.bcs);
  sampleOwner = entry.sui_address;
  return `${page.dynamicFields.length} entr(ies), first owner ${sampleOwner.slice(0, 12)}…`;
});

await check("listOwnedMerchantEntries", async () => {
  if (!sampleOwner) throw new Error("no owner discovered above");
  const rows = await listOwnedMerchantEntries(
    sui,
    QUAY.registryId,
    QUAY.packageId,
    sampleOwner,
  );
  if (rows.length === 0) throw new Error("owner from the table resolved to zero UENs");
  sampleUen = rows[0]?.uen ?? null;
  return `${rows.length} UEN(s): ${rows.map((r) => r.uen).join(", ")}`;
});

await check("lookupUen (claimed)", async () => {
  if (!sampleUen) throw new Error("no UEN discovered above");
  const res = await lookupUen(sui, QUAY.registryId, sampleUen);
  if (!res.claimed) throw new Error(`${sampleUen} reported unclaimed`);
  return `${sampleUen} -> ${res.owner.slice(0, 12)}… blob=${res.metadataBlobId ? "yes" : "none"}`;
});

await check("lookupUen (unclaimed)", async () => {
  const res = await lookupUen(sui, QUAY.registryId, "00000000ZZ");
  if (res.claimed) throw new Error("bogus UEN reported as claimed");
  return "correctly unclaimed";
});

console.log("\nscallop (gRPC dynamic fields + BCS)");
await check("readBalanceSheet", async () => {
  const bs = await readBalanceSheet(sui, USDSUI.coinType);
  if (!bs) throw new Error("no reserve for USDsui");
  return `cash=${bs.cash} supply=${bs.marketCoinSupply}`;
});

await check("getSharePrice sane", async () => {
  const sp = await getSharePrice(sui, USDSUI.coinType);
  // A mis-ordered BCS struct yields an absurd ratio rather than an error, so
  // assert the band instead of merely that it returned.
  if (!(sp > 1.0 && sp < 1.5)) throw new Error(`share price ${sp} outside sane band`);
  return sp.toFixed(6);
});

await check("getPoolCash", async () => `${await getPoolCash(sui, USDSUI.coinType)}`);

await check("preflightScallopHealthy", async () => {
  // Takes the asset object, not a coin-type string.
  const r = await preflightScallopHealthy(sui, USDSUI);
  if (r !== true) throw new Error(`preflight says unhealthy (${r})`);
  return "healthy";
});

console.log("\npayments (GraphQL)");
await check("PaymentReceipt events", async () => {
  const events = await queryEventsByType(
    `${QUAY.packageId}::payments::PaymentReceipt`,
    5,
  );
  const p = events[0]?.parsedJson as { amount?: string } | undefined;
  return `${events.length} event(s), newest amount ${p?.amount ?? "n/a"}`;
});

console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
