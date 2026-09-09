/**
 * READ-ONLY latency probe for /region 시장 현황 (getRegionDaily).
 * Does not write. Prints timings only.
 */
import { config } from "dotenv";
import { getRegion } from "@/lib/constants/regions";
import { hasDb } from "@/lib/db/client";
import { queryRentPool, queryTradePool } from "@/lib/db/repository";
import { getRegionDaily } from "@/lib/molit/service";
import { recentYearMonths } from "@/lib/utils/format";

config({ path: ".env.local" });
config();

const SLUGS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "seoul-gangnam",
      "seoul-songpa",
      "gyeonggi-seongnam",
      "gyeonggi-suwon",
      "gyeonggi-gwangju",
      "seoul-yongsan",
    ];

function now() {
  return performance.now();
}

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = now();
  const result = await fn();
  const ms = Math.round(now() - t0);
  console.log(`  ${label}: ${ms}ms`);
  return result;
}

async function probeSlug(slug: string, ym: string) {
  const region = getRegion(slug);
  if (!region) {
    console.log(`\n=== ${slug} UNKNOWN ===`);
    return;
  }
  console.log(`\n=== ${slug} (${region.fullName}) ym=${ym} db=${hasDb()} ===`);

  const historyMonths = recentYearMonths(24);

  await time("queryTradePool current month", () =>
    queryTradePool({ lawdCodes: region.lawdCodes, yearMonths: [ym] }).then(
      (rows) => {
        console.log(`    rows=${rows?.length ?? "null"}`);
        return rows;
      },
    ),
  );

  const history = await time("queryTradePool 24m", () =>
    queryTradePool({
      lawdCodes: region.lawdCodes,
      yearMonths: historyMonths,
    }).then((rows) => {
      console.log(`    rows=${rows?.length ?? "null"}`);
      return rows;
    }),
  );

  await time("queryRentPool 24m (jeonse)", () =>
    queryRentPool({
      lawdCodes: region.lawdCodes,
      yearMonths: historyMonths,
    }).then((rows) => {
      console.log(`    rows=${rows?.length ?? "null"}`);
      return rows;
    }),
  );

  const daily = await time("getRegionDaily (full, cold-ish)", () =>
    getRegionDaily({ regionSlug: slug, yearMonth: ym }),
  );
  console.log(
    `    source=${daily.source} axis=${daily.dateAxis} monthDeals=${daily.monthDeals.length} days=${daily.days.length} selected=${daily.selectedDate} tradeCount=${daily.tradeCount} singoga=${daily.selectedDaySingogaCount} json=${Buffer.byteLength(JSON.stringify(daily))}B`,
  );

  await time("getRegionDaily (repeat, same process)", () =>
    getRegionDaily({ regionSlug: slug, yearMonth: ym }),
  );

  void history;
}

async function main() {
  const ym = recentYearMonths(1)[0];
  console.log(`probe-region-daily ym=${ym} at ${new Date().toISOString()}`);
  for (const slug of SLUGS) {
    await probeSlug(slug, ym);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
