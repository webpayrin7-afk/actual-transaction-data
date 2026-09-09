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
import {
  contractMonthOptions,
  shiftYearMonth,
} from "../src/lib/region/market-insight";

const SEONGNAM_LAWDS = [
  { code: "41131", name: "수정구" },
  { code: "41133", name: "중원구" },
  { code: "41135", name: "분당구" },
];

function consecutiveDesc(months: string[]): void {
  assert.ok(months.length > 0, "month options empty");
  for (let i = 1; i < months.length; i++) {
    assert.equal(
      months[i],
      shiftYearMonth(months[i - 1]!, -1),
      `gap at ${months[i - 1]} -> ${months[i]}`,
    );
  }
}

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
  console.log("API history 202608 first_seen", {
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
  consecutiveDesc(market.contractMonthOptions);
  assert.ok(
    market.contractMonthOptions.includes("202608"),
    "SECTION 1 must offer 202608",
  );
  assert.ok(
    market.contractMonthOptions.length <= 24,
    "SECTION 1 lookback is at most 24 months",
  );
  assert.ok(
    contractMonthOptions(market.contractMonthOptions[0]!, 24).includes("202608"),
  );

  const s3 = latest.activityYearMonths;
  assert.ok(Array.isArray(s3), "SECTION 3 options missing");
  assert.notDeepEqual(
    market.contractMonthOptions,
    s3,
    "contractMonth options must not equal activityMonth options",
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
