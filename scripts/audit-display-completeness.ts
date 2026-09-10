/**
 * READ-ONLY: warehouse vs product API display completeness.
 * No MOLIT. No writes.
 *
 *   npx tsx scripts/audit-display-completeness.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/lib/db/client";
import { getRegion } from "../src/lib/constants/regions";
import { getAptDetail } from "../src/lib/molit/apt";
import { clearRegionDailyCaches, getRegionDaily } from "../src/lib/molit/service";

const SAMPLES: { slug: string; lawds: string[]; months: string[] }[] = [
  { slug: "seoul-gangnam", lawds: ["11680"], months: ["202609", "202608", "202501", "202401", "202301", "202003", "201610"] },
  { slug: "seoul-songpa", lawds: ["11710"], months: ["202609", "202608", "202501", "202401", "202301", "202003"] },
  { slug: "seoul-yongsan", lawds: ["11170"], months: ["202609", "202608", "202501", "202401", "202301", "202003"] },
  { slug: "gyeonggi-seongnam", lawds: ["41131", "41133", "41135"], months: ["202609", "202608", "202501", "202401", "202301", "202003"] },
  { slug: "gyeonggi-suwon", lawds: ["41111", "41113", "41115", "41117"], months: ["202609", "202608", "202501", "202401", "202301", "202003"] },
  { slug: "gyeonggi-bucheon", lawds: ["41192", "41194", "41196"], months: ["202609", "202508", "202409", "202309", "202001"] },
  { slug: "gyeonggi-hwaseong", lawds: ["41591", "41593", "41595", "41597"], months: ["202609", "202508", "202409", "202309", "202001", "201610"] },
];

async function warehouseCount(
  db: NonNullable<ReturnType<typeof getDb>>,
  lawds: string[],
  ym: string,
): Promise<number> {
  const ph = lawds.map(() => "?").join(",");
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM transactions
          WHERE lawd_cd IN (${ph}) AND deal_type='trade' AND year_month=?`,
    args: [...lawds, ym],
  });
  return Number(result.rows[0]?.n ?? 0);
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("no db");
  clearRegionDailyCaches();
  const rows: unknown[] = [];
  let failDbUi = 0;
  let failCountMismatch = 0;

  for (const sample of SAMPLES) {
    const region = getRegion(sample.slug);
    if (!region) throw new Error(sample.slug);
    for (const ym of sample.months) {
      const warehouse = await warehouseCount(db, sample.lawds, ym);
      const t0 = performance.now();
      const history = await getRegionDaily({
        regionSlug: sample.slug,
        part: "history",
        yearMonth: ym,
      });
      const ms = Math.round(performance.now() - t0);
      const api = history.historyTotalCount;
      const uiAccessible = api;
      if (warehouse > 0 && api === 0) failDbUi += 1;
      if (warehouse !== api) failCountMismatch += 1;
      rows.push({
        slug: sample.slug,
        ym,
        warehouse,
        api,
        uiAccessible,
        ms,
        optionsHasYm: history.activityYearMonths.includes(ym) || warehouse === 0,
      });
    }
  }

  const mijub = await getAptDetail({
    aptName: "미주B",
    regionSlug: "seoul-yongsan",
    months: 120,
    gu: "용산구",
  });
  const mijubHit = mijub?.items.some(
    (i) => i.dealDate === "2026-06-30" && i.dealAmount === 178000,
  );

  console.log(
    JSON.stringify(
      {
        failDbUi,
        failCountMismatch,
        mijub20260630: mijubHit ? "PASS" : "FAIL",
        aptSource: mijub?.source,
        aptTradeCount: mijub?.stats.totalTradeCount,
        samples: rows,
      },
      null,
      2,
    ),
  );
  if (failDbUi > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
