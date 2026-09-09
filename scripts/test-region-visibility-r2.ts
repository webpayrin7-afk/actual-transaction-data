/**
 * PHASE R2: Section3 deal_date visibility + discovery isolation.
 * Local file DB only. No production writes.
 *
 *   npx tsx scripts/test-region-visibility-r2.ts
 */
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const dbPath = resolve("data/test-region-visibility-r2.db");
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(p)) unlinkSync(p);
}

process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.MOLIT_API_KEY;
delete process.env.ENABLE_DISCOVERY_AT_COLUMN;

import { ensureSchema, getDb } from "../src/lib/db/client";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import { seoulToday } from "../src/lib/market/time";
import {
  clearRegionDailyCaches,
  getRegionDaily,
} from "../src/lib/molit/service";
import { YONGSAN_LAWD_CD } from "../src/lib/molit/sync-policy";
import { newlySeenCompactStatus } from "../src/lib/region/market-insight";
import type { Transaction } from "../src/types/transaction";

function tx(
  partial: Partial<Transaction> & Pick<Transaction, "id" | "dealAmount" | "dealDate">,
): Transaction {
  return {
    id: partial.id,
    dealType: partial.dealType ?? "trade",
    dealDate: partial.dealDate,
    aptName: partial.aptName ?? "미주B",
    gu: partial.gu ?? "용산구",
    dong: partial.dong ?? "이촌동",
    exclusiveArea: partial.exclusiveArea ?? 149.09,
    dealAmount: partial.dealAmount,
    monthlyRent: partial.monthlyRent ?? 0,
    floor: partial.floor ?? 4,
    buildYear: partial.buildYear ?? 1972,
    jibun: partial.jibun ?? "302-48",
    dealingGbn: partial.dealingGbn ?? "중개거래",
    lawdCd: partial.lawdCd ?? YONGSAN_LAWD_CD,
  };
}

async function main() {
  const db = getDb();
  assert.ok(db);
  await ensureSchema(db);

  const today = seoulToday();
  const todayYm = `${today.slice(0, 4)}${today.slice(5, 7)}`;

  const todayIns = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: todayYm,
    dealKind: "trade",
    items: [
      tx({
        id: "today-disc",
        aptName: "발견오늘",
        dealAmount: 200000,
        dealDate: today,
        floor: 1,
        jibun: "1-1",
      }),
    ],
    setFirstSeenOnInsert: true,
  });
  assert.equal(todayIns.inserted, 1);

  const augIns = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "202608",
    dealKind: "trade",
    items: [
      tx({
        id: "aug-hist",
        aptName: "8월역사",
        dealAmount: 155000,
        dealDate: "2026-08-12",
        floor: 3,
        jibun: "8-12",
      }),
    ],
    setFirstSeenOnInsert: false,
  });
  assert.equal(augIns.inserted, 1);

  const junIns = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "202606",
    dealKind: "trade",
    items: [
      tx({
        id: "miju-b",
        aptName: "미주B",
        dealAmount: 178000,
        dealDate: "2026-06-30",
        exclusiveArea: 149.09,
        floor: 4,
        jibun: "302-48",
      }),
    ],
    setFirstSeenOnInsert: false,
  });
  assert.equal(junIns.inserted, 1);

  const discNull = await db.execute({
    sql: `SELECT apt_name, discovery_at FROM transactions
          WHERE apt_name IN ('8월역사', '미주B')`,
  });
  for (const row of discNull.rows) {
    assert.equal(
      row.discovery_at == null || row.discovery_at === "",
      true,
      `${row.apt_name} repair discovery must be NULL`,
    );
  }
  const discNow = await db.execute({
    sql: `SELECT discovery_at FROM transactions WHERE apt_name='발견오늘'`,
  });
  assert.ok(discNow.rows[0]?.discovery_at, "normal discovery=1 sets discovery_at");

  clearRegionDailyCaches();
  const latest = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    part: "latest",
  });
  assert.equal(latest.latestIsToday, true);
  assert.ok(
    latest.deals.some((d) => d.aptName === "발견오늘"),
    "today discovery → Section2 visible",
  );
  assert.equal(
    latest.deals.some((d) => d.aptName === "8월역사"),
    false,
    "historical discovery NULL must not appear in Section2",
  );
  assert.ok(latest.activityYearMonths.includes("202608"));
  assert.ok(latest.activityYearMonths.includes("202606"));
  assert.equal(newlySeenCompactStatus({ isToday: true, heroDate: today }), null);

  const historyAug = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    part: "history",
    yearMonth: "202608",
  });
  assert.equal(historyAug.historyDateAxis, "deal_date");
  assert.equal(historyAug.historyTotalCount, 1, "warehouse 1 / API total 1");
  assert.ok(
    historyAug.days.some((d) => d.date === "2026-08-12" && d.dealCount === 1),
    "8월 deal → 8월 calendar visible",
  );

  const historyJun = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    part: "history",
    yearMonth: "202606",
  });
  assert.equal(historyJun.historyTotalCount, 1);
  const junDays = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    part: "days",
    yearMonth: "202606",
    dates: ["2026-06-30"],
  });
  const junNames = junDays.historySections.flatMap((s) =>
    s.deals.map((d) => `${d.aptName}|${d.dealDate}|${d.dealAmount}`),
  );
  assert.ok(
    junNames.includes("미주B|2026-06-30|178000"),
    "MijuB historical row visible on deal_date",
  );

  const dbAug = Number(
    (
      await db.execute({
        sql: `SELECT COUNT(*) AS n FROM transactions
              WHERE lawd_cd=? AND deal_type='trade' AND year_month='202608'`,
        args: [YONGSAN_LAWD_CD],
      })
    ).rows[0]?.n ?? 0,
  );
  assert.equal(dbAug, historyAug.historyTotalCount, "warehouse row count > UI total → fail");

  console.log(
    JSON.stringify({
      ok: true,
      cases: [
        "historical-row-discovery-null-section3-visible",
        "today-discovery-section2-visible",
        "august-deal-august-calendar",
        "warehouse-count-equals-history-total",
        "repair-discovery-0-null",
        "normal-discovery-1-now",
        "mijub-2026-06-30-178000",
      ],
    }),
  );

  try {
    unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
