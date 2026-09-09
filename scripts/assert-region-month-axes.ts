/**
 * SECTION 1 deal_date vs SECTION 3 first_seen month axes + 성남 202608.
 * READ ONLY. no schema/index/sync writes.
 *   npx tsx scripts/assert-region-month-axes.ts
 */
import assert from "node:assert/strict";
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/lib/db/client";
import { getRegion } from "../src/lib/constants/regions";
import { getRegionDaily } from "../src/lib/molit/service";

const SEONGNAM_LAWDS = [
  { code: "41131", name: "수정구" },
  { code: "41133", name: "중원구" },
  { code: "41135", name: "분당구" },
];

async function countYm(
  db: NonNullable<ReturnType<typeof getDb>>,
  lawd: string,
  ym: string,
): Promise<number> {
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM transactions
          WHERE lawd_cd = ? AND deal_type = 'trade' AND year_month = ?`,
    args: [lawd, ym],
  });
  return Number(result.rows[0]?.n ?? 0);
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("no db");
  const region = getRegion("gyeonggi-seongnam");
  if (!region) throw new Error("missing seongnam");

  const byLawd: Record<string, number> = {};
  let dbTotal = 0;
  for (const { code, name } of SEONGNAM_LAWDS) {
    const n = await countYm(db, code, "202608");
    byLawd[name] = n;
    dbTotal += n;
  }
  console.log("DB 202608", { byLawd, dbTotal });
  assert.ok(dbTotal > 0, "성남 202608 DB 거래가 있는데 0이면 이 assertion을 바꾸지 말 것");

  const market = await getRegionDaily({
    regionSlug: "gyeonggi-seongnam",
    part: "market",
    contractMonth: "202608",
  });
  const latest = await getRegionDaily({
    regionSlug: "gyeonggi-seongnam",
    part: "latest",
  });
  const historyAug = await getRegionDaily({
    regionSlug: "gyeonggi-seongnam",
    part: "history",
    yearMonth: "202608",
  });

  console.log("API market 202608", {
    monthTradeCount: market.monthTradeCount,
    monthSingogaCount: market.monthSingogaCount,
    contractYearMonth: market.contractYearMonth,
    contractMonthOptionsLen: market.contractMonthOptions.length,
    activityYearMonths: market.activityYearMonths,
  });
  console.log("API latest", {
    selectedDate: latest.selectedDate,
    tradeCount: latest.tradeCount,
    activityYearMonths: latest.activityYearMonths,
  });
  console.log("API history 202608 deal_date", {
    historyTotalCount: historyAug.historyTotalCount,
    days: historyAug.days.length,
  });

  assert.equal(market.contractYearMonth, "202608");
  assert.equal(
    market.monthTradeCount,
    dbTotal,
    "SECTION 1 KPI must match DB deal_date/year_month 202608",
  );
  assert.ok(
    (market.contractMonthOptions?.length ?? 0) >= 1,
    "SECTION 1 options missing",
  );
  assert.ok(
    market.contractMonthOptions.includes("202608"),
    "SECTION 1 must offer 202608",
  );
  assert.ok(
    market.contractMonthOptions.length >= 24 ||
      market.contractMonthOptions.includes("202608"),
    "SECTION 1 must not hide warehouse months behind a 24m cap",
  );

  const s3 = latest.activityYearMonths;
  assert.ok(Array.isArray(s3), "SECTION 3 options missing");
  assert.ok(s3.includes("202608"), "SECTION 3 activityMonth must offer 202608");
  assert.ok(
    historyAug.historyTotalCount === dbTotal,
    `SECTION 3 202608 historyTotalCount ${historyAug.historyTotalCount} != DB ${dbTotal}`,
  );
  assert.ok(
    (historyAug.days?.length ?? 0) > 0,
    "SECTION 3 202608 calendar must have deal_date days",
  );

  const latestAfterAugMarket = await getRegionDaily({
    regionSlug: "gyeonggi-seongnam",
    part: "latest",
    contractMonth: "202608",
  });
  assert.equal(latestAfterAugMarket.selectedDate, latest.selectedDate);
  assert.equal(latestAfterAugMarket.tradeCount, latest.tradeCount);
  assert.deepEqual(
    latestAfterAugMarket.activityYearMonths,
    latest.activityYearMonths,
  );

  const historySep = await getRegionDaily({
    regionSlug: "gyeonggi-seongnam",
    part: "history",
    yearMonth: s3[0] || "202609",
  });
  const historySepAgain = await getRegionDaily({
    regionSlug: "gyeonggi-seongnam",
    part: "history",
    yearMonth: s3[0] || "202609",
    contractMonth: "202608",
  });
  assert.equal(historySep.historyTotalCount, historySepAgain.historyTotalCount);

  console.log("assert-region-month-axes: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
