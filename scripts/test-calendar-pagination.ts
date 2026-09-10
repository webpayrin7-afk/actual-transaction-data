/**
 * Calendar date outside the initial history page still returns deals.
 * Local file DB only. No production writes.
 *
 *   npx tsx scripts/test-calendar-pagination.ts
 */
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const dbPath = resolve("data/test-calendar-pagination.db");
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(p)) unlinkSync(p);
}

process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.MOLIT_API_KEY;
delete process.env.ENABLE_DISCOVERY_AT_COLUMN;

import { ensureSchema, getDb } from "../src/lib/db/client";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import {
  clearRegionDailyCaches,
  getRegionDaily,
} from "../src/lib/molit/service";
import { YONGSAN_LAWD_CD } from "../src/lib/molit/sync-policy";
import {
  HISTORY_DAY_FETCH_CAP,
  HISTORY_INITIAL_DAY_COUNT,
  listedHistoryDates,
} from "../src/lib/region/market-insight";
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

  const items = Array.from({ length: 12 }, (_, i) => {
    const day = String(i + 1).padStart(2, "0");
    return tx({
      id: `aug-${day}`,
      aptName: `달력${day}`,
      dealAmount: 100000 + i * 1000,
      dealDate: `2026-08-${day}`,
      jibun: `8-${day}`,
    });
  });
  const ins = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "202608",
    dealKind: "trade",
    items,
    setFirstSeenOnInsert: false,
  });
  assert.equal(ins.inserted, 12);

  clearRegionDailyCaches();
  const history = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    part: "history",
    yearMonth: "202608",
  });
  const active = history.days
    .filter((d) => d.dealCount > 0)
    .map((d) => d.date);
  assert.equal(active.length, 12);
  assert.equal(active[0], "2026-08-12");
  assert.equal(active.at(-1), "2026-08-01");
  assert.equal(history.historySections.length, 0, "history stays calendar-only");

  const initial = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    part: "days",
    yearMonth: "202608",
  });
  assert.equal(initial.historySections.length, HISTORY_INITIAL_DAY_COUNT);
  assert.deepEqual(
    initial.historySections.map((s) => s.date),
    active.slice(0, HISTORY_INITIAL_DAY_COUNT),
  );
  assert.equal(
    initial.historySections.some((s) => s.date === "2026-08-01"),
    false,
    "month-start is outside the initial page",
  );

  const start = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    part: "days",
    yearMonth: "202608",
    dates: ["2026-08-01"],
  });
  assert.equal(start.historySections.length, 1);
  assert.equal(start.historySections[0]?.date, "2026-08-01");
  assert.ok(
    (start.historySections[0]?.deals.length ?? 0) > 0,
    "calendar count>0 date must return UI rows when fetched explicitly",
  );

  const overCap = await getRegionDaily({
    regionSlug: "seoul-yongsan",
    part: "days",
    yearMonth: "202608",
    dates: active,
  });
  assert.ok(overCap.historySections.length <= HISTORY_DAY_FETCH_CAP);
  assert.equal(
    overCap.historySections.some((s) => s.date === "2026-08-01"),
    false,
    "requesting the whole month still cannot stand in for a targeted extra fetch",
  );

  const listed = listedHistoryDates({
    activeDates: active,
    visibleDayCount: HISTORY_INITIAL_DAY_COUNT,
    selectedDate: "2026-08-01",
    extraDates: ["2026-08-01"],
  });
  assert.equal(listed[0], "2026-08-01");
  assert.equal(listed.length, HISTORY_INITIAL_DAY_COUNT + 1);

  console.log(
    JSON.stringify({
      ok: true,
      cases: [
        "history-calendar-only",
        "days-default-initial-page",
        "month-start-explicit-fetch",
        "cap-does-not-include-month-start",
        "listed-dates-pin-selected",
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
