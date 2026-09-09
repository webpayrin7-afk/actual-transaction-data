/**
 * POST-R2: full-history serving + DB-first request path.
 * Local file DB only. No production writes. No request-time MOLIT.
 *
 *   npx tsx scripts/test-full-history-serving.ts
 */
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const dbPath = resolve("data/test-full-history-serving.db");
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(p)) unlinkSync(p);
}

process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.MOLIT_API_KEY;
delete process.env.ENABLE_DISCOVERY_AT_COLUMN;

import { ensureSchema, getDb } from "../src/lib/db/client";
import {
  queryAptTransactions,
  replaceMonthTransactions,
} from "../src/lib/db/repository";
import { getAptDetail } from "../src/lib/molit/apt";
import { seoulToday } from "../src/lib/market/time";
import {
  clearRegionDailyCaches,
  getRegionDaily,
  getTransactions,
} from "../src/lib/molit/service";
import { YONGSAN_LAWD_CD } from "../src/lib/molit/sync-policy";
import { monthSelectorOptions } from "../src/lib/region/market-insight";
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

  await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "201610",
    dealKind: "trade",
    items: [
      tx({
        id: "old-2016",
        aptName: "미주B",
        dealAmount: 50000,
        dealDate: "2016-10-11",
        floor: 2,
        jibun: "16-10",
      }),
    ],
    setFirstSeenOnInsert: false,
  });
  await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "202003",
    dealKind: "trade",
    items: [
      tx({
        id: "y2020",
        aptName: "미주B",
        dealAmount: 80000,
        dealDate: "2020-03-15",
        floor: 3,
        jibun: "20-3",
      }),
    ],
    setFirstSeenOnInsert: false,
  });
  await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "202606",
    dealKind: "trade",
    items: [
      tx({
        id: "miju-b",
        aptName: "미주B",
        dealAmount: 178000,
        dealDate: "2026-06-30",
      }),
    ],
    setFirstSeenOnInsert: false,
  });
  await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "202501",
    dealKind: "trade",
    items: [
      tx({
        id: "late-old-deal",
        aptName: "지연신고",
        dealAmount: 120000,
        dealDate: "2025-01-08",
        floor: 8,
        jibun: "25-1",
      }),
    ],
    setFirstSeenOnInsert: true,
  });

  const monthOpts = monthSelectorOptions(["201610", "202003", "202606"], todayYm);
  assert.ok(monthOpts.includes("201610"));
  assert.ok(monthOpts[0] === todayYm);

  clearRegionDailyCaches();
  const hist2016 = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    part: "history",
    yearMonth: "201610",
  });
  assert.equal(hist2016.source, "db");
  assert.equal(hist2016.historyTotalCount, 1);
  assert.ok(hist2016.activityYearMonths.includes("201610"));
  assert.ok(hist2016.activityYearMonths.includes("202003"));

  const hist2020 = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    part: "history",
    yearMonth: "202003",
  });
  assert.equal(hist2020.historyTotalCount, 1);

  const latest = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    part: "latest",
  });
  assert.equal(latest.latestIsToday, true);
  assert.ok(latest.deals.some((d) => d.aptName === "지연신고"));
  assert.equal(
    latest.deals.some((d) => d.aptName === "미주B"),
    false,
  );

  const histJan = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    part: "history",
    yearMonth: "202501",
  });
  assert.equal(histJan.historyTotalCount, 1, "old deal_date of today discovery");

  const txPage = await getTransactions({
    lawdCodes: [YONGSAN_LAWD_CD],
    regionSlug: "seoul-yongsan",
    yearMonth: "202003",
    dealType: "trade",
    page: 1,
    pageSize: 50,
  });
  assert.equal(txPage.source, "db");
  assert.equal(txPage.totalCount, 1);
  assert.equal(txPage.warning, undefined);

  const aptRows = await queryAptTransactions({
    lawdCodes: [YONGSAN_LAWD_CD],
    aptName: "미주B",
    yearMonths: [],
  });
  assert.ok(aptRows.some((r) => r.dealDate === "2016-10-11"));
  assert.ok(aptRows.some((r) => r.dealDate === "2026-06-30" && r.dealAmount === 178000));

  const apt = await getAptDetail({
    aptName: "미주B",
    regionSlug: "seoul-yongsan",
    months: 6,
    gu: "용산구",
  });
  assert.ok(apt);
  assert.equal(apt.source, "db");
  assert.equal(apt.partial, false);
  assert.ok(apt.items.some((i) => i.dealDate === "2016-10-11"));
  assert.ok(
    apt.items.some(
      (i) => i.dealDate === "2026-06-30" && i.dealAmount === 178000,
    ),
  );
  assert.equal(apt.stats.totalTradeCount, 3);

  const many = Array.from({ length: 12 }, (_, i) =>
    tx({
      id: `bulk-${i}`,
      aptName: "대량월",
      dealAmount: 10000 + i,
      dealDate: `2024-05-${String(i + 1).padStart(2, "0")}`,
      floor: i + 1,
      jibun: `24-${i}`,
    }),
  );
  await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "202405",
    dealKind: "trade",
    items: many,
    setFirstSeenOnInsert: false,
  });
  clearRegionDailyCaches();
  const histMay = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    part: "history",
    yearMonth: "202405",
  });
  assert.equal(histMay.historyTotalCount, 12);
  assert.notEqual(histMay.historyTotalCount, 5);

  console.log(
    JSON.stringify({
      ok: true,
      cases: [
        "2016-section3-visible",
        "2020-section3-visible",
        "today-discovery-old-deal-section2-and-section3",
        "apt-full-history-uncapped",
        "mijub-visible",
        "getTransactions-db-only",
        "month-total-not-page-size",
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
