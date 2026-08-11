import { getSupabaseClient } from "@/lib/server/supabase";
const sb = getSupabaseClient()!;
// Throwaway address so no real merchant's counter is touched.
const PROBE = "0x" + "7".repeat(64);
await sb.from("sponsor_usage").delete().eq("usage_key", PROBE);

for (let i = 1; i <= 40; i++) {
  await fetch("https://app.quay.cash/api/sponsor/withdraw", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner: PROBE, destination: PROBE, amount_usdsui_minor: "1" }),
  }).catch(() => {});
  const { data } = await sb.from("sponsor_usage").select("usage_key,count").eq("usage_key", PROBE).maybeSingle();
  if (data) {
    console.log(`DEPLOYED (poll ${i}): sponsor_usage row written, count=${data.count}`);
    await sb.from("sponsor_usage").delete().eq("usage_key", PROBE);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 15000));
}
console.log("no sponsor_usage row after 10 minutes — deploy may not have landed");
process.exit(1);
