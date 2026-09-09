/**
 * discovery_at ingest + product-feed guards (local file DB).
 * production Turso에 연결하지 않는다. schema ALTER는 file: 에서만.
 *
 *   npx tsx scripts/test-discovery-at.ts
 */
import { resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import assert from "node:assert/strict";

const dbPath = resolve("data/test-discovery-at.db");
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(p)) unlinkSync(p);
}

process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.MOLIT_API_KEY;
delete process.env.ENABLE_DISCOVERY_AT_COLUMN;

import { ensureSchema, getDb } from "../src/lib/db/client";
import {
  hasDiscoveryAtColumn,
  shouldMigrateDiscoveryAtColumn,
} from "../src/lib/db/discovery-axis";
import {
  queryAptTransactions,
  replaceMonthTransactions,
} from "../src/lib/db/repository";
import { computeMarketHome } from "../src/lib/market/home";
import { seoulToday } from "../src/lib/market/time";
import {
  clearRegionDailyCaches,
  getRegionDaily,
} from "../src/lib/molit/service";
import { resolveActiveTrades } from "../src/lib/molit/trade-resolve";
import { YONGSAN_LAWD_CD } from "../src/lib/molit/sync-policy";
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
    exclusiveArea: partial.exclusiveArea ?? 84.9,
    dealAmount: partial.dealAmount,
    monthlyRent: partial.monthlyRent ?? 0,
    floor: partial.floor ?? 5,
    buildYear: partial.buildYear ?? 1972,
    jibun: partial.jibun ?? "300-3",
    dealingGbn: partial.dealingGbn ?? "중개거래",
    lawdCd: partial.lawdCd ?? YONGSAN_LAWD_CD,
    ingestMeta: partial.ingestMeta,
  };
}

async function rowByApt(name: string) {
  const db = getDb();
  assert.ok(db);
  const r = await db.execute({
    sql: `SELECT first_seen_at, last_seen_at, discovery_at, deal_date
          FROM transactions WHERE apt_name = ?`,
    args: [name],
  });
  return r.rows[0];
}

async function main() {
  assert.equal(shouldMigrateDiscoveryAtColumn(), true);
  const db = getDb();
  assert.ok(db, "local file db");
  await ensureSchema(db);
  assert.equal(await hasDiscoveryAtColumn(db), true);

  const today = seoulToday();
  const ym = `${today.slice(0, 4)}${today.slice(5, 7)}`;

  // discovery=1 INSERT → first_seen now, discovery now
  const d1 = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: ym,
    dealKind: "trade",
    items: [
      tx({
        id: "disc-1",
        aptName: "발견A",
        dealAmount: 250000,
        dealDate: today,
        floor: 1,
        jibun: "1-1",
      }),
    ],
    setFirstSeenOnInsert: true,
  });
  assert.equal(d1.inserted, 1);
  const seen1 = await rowByApt("발견A");
  assert.ok(seen1?.first_seen_at);
  assert.ok(seen1?.discovery_at);
  assert.equal(String(seen1!.first_seen_at), String(seen1!.discovery_at));
  const keepFirst = String(seen1!.first_seen_at);
  const keepDiscovery = String(seen1!.discovery_at);
  const keepLast = String(seen1!.last_seen_at);

  // discovery=0 INSERT → first_seen now, discovery NULL
  const d0 = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: ym,
    dealKind: "trade",
    items: [
      tx({
        id: "disc-1",
        aptName: "발견A",
        dealAmount: 250000,
        dealDate: today,
        floor: 1,
        jibun: "1-1",
      }),
      tx({
        id: "back-1",
        aptName: "백필B",
        dealAmount: 122000,
        dealDate: today,
        floor: 2,
        jibun: "2-2",
      }),
    ],
    setFirstSeenOnInsert: false,
  });
  assert.equal(d0.inserted, 1);
  assert.equal(d0.unchanged, 1);
  const seen0 = await rowByApt("백필B");
  assert.ok(seen0?.first_seen_at, "backfill still records warehouse first_seen");
  assert.equal(
    seen0?.discovery_at == null || seen0?.discovery_at === "",
    true,
    "backfill discovery_at NULL",
  );

  // unchanged WRITE 0 preserves both
  const noop = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: ym,
    dealKind: "trade",
    items: [
      tx({
        id: "disc-1",
        aptName: "발견A",
        dealAmount: 250000,
        dealDate: today,
        floor: 1,
        jibun: "1-1",
      }),
      tx({
        id: "back-1",
        aptName: "백필B",
        dealAmount: 122000,
        dealDate: today,
        floor: 2,
        jibun: "2-2",
      }),
    ],
    setFirstSeenOnInsert: true,
  });
  assert.equal(noop.inserted, 0);
  assert.equal(noop.updated, 0);
  assert.equal(noop.deleted, 0);
  assert.equal(noop.unchanged, 2);
  assert.equal(noop.wrote, false);
  const afterNoop = await rowByApt("발견A");
  assert.equal(String(afterNoop!.first_seen_at), keepFirst);
  assert.equal(String(afterNoop!.discovery_at), keepDiscovery);
  assert.equal(String(afterNoop!.last_seen_at), keepLast);

  // UPDATE preserves both timestamps
  await new Promise((r) => setTimeout(r, 5));
  const upd = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: ym,
    dealKind: "trade",
    items: [
      tx({
        id: "disc-1",
        aptName: "발견A",
        dealAmount: 250000,
        dealDate: today,
        floor: 1,
        jibun: "1-1",
        dealingGbn: "직거래",
      }),
      tx({
        id: "back-1",
        aptName: "백필B",
        dealAmount: 122000,
        dealDate: today,
        floor: 2,
        jibun: "2-2",
      }),
    ],
    setFirstSeenOnInsert: true,
  });
  assert.equal(upd.updated, 1);
  assert.equal(upd.unchanged, 1);
  const afterUpd = await rowByApt("발견A");
  assert.equal(String(afterUpd!.first_seen_at), keepFirst);
  assert.equal(String(afterUpd!.discovery_at), keepDiscovery);
  assert.notEqual(String(afterUpd!.last_seen_at), keepLast);

  // deal-date paths still see backfill rows
  const aptRows = await queryAptTransactions({
    lawdCodes: [YONGSAN_LAWD_CD],
    aptName: "백필B",
    yearMonths: [ym],
    dealKinds: ["trade"],
  });
  assert.equal(aptRows.length, 1);
  assert.equal(aptRows[0]?.dealAmount, 122000);

  // Home excludes discovery NULL
  const home = await computeMarketHome();
  assert.equal(home.source, "db");
  const homeNames = [
    ...home.notables,
    ...home.singoga,
    ...home.drops,
    ...home.highDeals,
  ].map((d) => d.aptName);
  assert.equal(home.kpis.newDealCount, 1, "Home counts only discovery_at rows");
  assert.equal(home.kpis.highCount >= 1, true);
  assert.ok(homeNames.includes("발견A"));
  assert.equal(homeNames.includes("백필B"), false);

  // Region Section2 excludes discovery NULL; Section3 deal_date includes both
  clearRegionDailyCaches();
  const region = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    contractMonth: ym,
    yearMonth: ym,
    part: "all",
  });
  assert.equal(region.source, "db");
  assert.equal(region.monthTradeCount, 2, "Section1 deal_date includes backfill");
  const section2Names = region.deals.map((d) => d.aptName);
  assert.equal(section2Names.includes("백필B"), false, "Section2 excludes discovery NULL");
  assert.ok(section2Names.includes("발견A"), "Section2 keeps discovery rows");
  const calendarCount =
    region.days.find((d) => d.date === today)?.dealCount ?? 0;
  assert.equal(calendarCount, 2, "Section3 calendar includes discovery NULL");
  const historyNames = region.historySections.flatMap((s) =>
    s.deals.map((d) => d.aptName),
  );
  assert.ok(historyNames.includes("백필B"), "Section3 history includes discovery NULL");
  assert.ok(historyNames.includes("발견A"), "Section3 history keeps discovery rows");
  assert.equal(region.historyTotalCount, 2);
  assert.equal(region.historyDateAxis, "deal_date");

  // cancellation resolver unchanged: cancel+live → 1 INSERT, discovery set
  const live: Transaction = tx({
    id: "live",
    aptName: "취소쌍",
    dealAmount: 178000,
    dealDate: "2026-06-30",
    exclusiveArea: 149.09,
    floor: 4,
    jibun: "302-48",
    ingestMeta: {
      cdealType: "",
      cdealDay: "",
      rgstDate: "26.09.01",
      aptDong: "",
    },
  });
  const cancel: Transaction = tx({
    id: "cancel",
    aptName: "취소쌍",
    dealAmount: 178000,
    dealDate: "2026-06-30",
    exclusiveArea: 149.09,
    floor: 4,
    jibun: "302-48",
    ingestMeta: {
      cdealType: "O",
      cdealDay: "30",
      rgstDate: "26.09.02",
      aptDong: "",
    },
  });
  const resolved = resolveActiveTrades([cancel, live], YONGSAN_LAWD_CD).active;
  assert.equal(resolved.length, 1);
  const cancelIns = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "202606",
    dealKind: "trade",
    items: resolved,
    setFirstSeenOnInsert: true,
  });
  assert.equal(cancelIns.inserted, 1);
  const cancelRow = await rowByApt("취소쌍");
  assert.ok(cancelRow?.first_seen_at);
  assert.ok(cancelRow?.discovery_at);

  console.log(
    JSON.stringify(
      {
        ok: true,
        cases: [
          "discovery=1-sets-both",
          "discovery=0-first_seen-now-discovery-null",
          "update-preserves-both",
          "unchanged-write-0",
          "home-excludes-discovery-null",
          "region-section2-excludes-discovery-null",
          "region-section3-includes-discovery-null",
          "deal-date-paths-unchanged",
          "cancellation-resolver-unchanged",
        ],
      },
      null,
      2,
    ),
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
