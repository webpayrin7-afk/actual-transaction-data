import { config } from "dotenv";
config({ path: ".env.local" });
process.env.TURSO_DATABASE_URL = "file:/workspace/data/molit.db";

async function main() {
  const { getAptDetail } = await import("../src/lib/molit/apt");
  const t0 = Date.now();
  const d = await getAptDetail({
    aptName: "안양역한양수자인리버파크",
    regionSlug: "gyeonggi-anyang",
    months: 36,
    gu: "만안구",
  });
  console.log(
    JSON.stringify(
      {
        ms: Date.now() - t0,
        source: d?.source,
        items: d?.items.length,
        trades: d?.stats.totalTradeCount,
        chart: d?.chart.length,
        loadedMonths: d?.loadedMonths,
        apt: d?.aptName,
      },
      null,
      2,
    ),
  );
  const t2 = Date.now();
  await getAptDetail({
    aptName: "안양역한양수자인리버파크",
    regionSlug: "gyeonggi-anyang",
    months: 36,
    gu: "만안구",
  });
  console.log("memory_cache_ms", Date.now() - t2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
