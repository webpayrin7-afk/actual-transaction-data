/**
 * Late-report daily ingestion policy (local, no production DB / no MOLIT).
 *
 *   npx tsx scripts/test-late-report-ingestion.ts
 */
import { resolve } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import assert from "node:assert/strict";

const dbPath = resolve("data/test-late-report-ingestion.db");
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(p)) unlinkSync(p);
}

process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.MOLIT_API_KEY;

import { ensureSchema, getDb } from "../src/lib/db/client";
import { replaceMonthTransactions } from "../src/lib/db/repository";
import { allCapitalLawdCodes } from "../src/lib/constants/regions-registry";
import {
  DAILY_RENT_MONTHS,
  DAILY_TRADE_MONTHS,
  FORCE_ROLLING_CRON_UTC,
  FORCED_ROLLING_RUNS_PER_DAY,
  EVENING_PROBE_CRON_UTC,
  YONGSAN_LAWD_CD,
  applySkipExisting,
  buildRollingSyncJobs,
  dailyRentMonths,
  dailyTradeMonths,
  estimateRollingFetchCost,
  isCellUnchanged,
  isForcedRollingSchedule,
  shouldRunWarehouseSync,
} from "../src/lib/molit/sync-policy";
import type { Transaction } from "../src/types/transaction";

const AS_OF = new Date("2026-09-09T12:00:00+09:00");

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
    floor: partial.floor ?? 5,
    buildYear: partial.buildYear ?? 1972,
    jibun: partial.jibun ?? "300-3",
    dealingGbn: partial.dealingGbn ?? "중개거래",
    lawdCd: partial.lawdCd ?? YONGSAN_LAWD_CD,
  };
}

function mainPolicy() {
  // A. 2026-09 trade months include 202606 (미주B contract month)
  const trade = dailyTradeMonths(AS_OF);
  assert.deepEqual(trade, ["202609", "202608", "202607", "202606"]);
  assert.equal(DAILY_TRADE_MONTHS, 4);

  // B. rent stays 2 months
  const rent = dailyRentMonths(AS_OF);
  assert.deepEqual(rent, ["202609", "202608"]);
  assert.equal(DAILY_RENT_MONTHS, 2);

  const yongsan = buildRollingSyncJobs({
    lawdCodes: [YONGSAN_LAWD_CD],
    asOf: AS_OF,
  });
  assert.deepEqual(yongsan.tradeYms, trade);
  assert.deepEqual(yongsan.rentYms, rent);
  assert.ok(
    yongsan.jobs.some(
      (j) =>
        j.lawdCd === YONGSAN_LAWD_CD &&
        j.yearMonth === "202606" &&
        j.kind === "trade",
    ),
    "Yongsan 202606 trade job must be generated",
  );
  assert.equal(
    yongsan.jobs.filter((j) => j.kind === "trade").length,
    4,
  );
  assert.equal(
    yongsan.jobs.filter((j) => j.kind === "rent").length,
    2,
  );
  assert.equal(
    yongsan.jobs.filter((j) => j.kind === "rent" && j.yearMonth === "202606")
      .length,
    0,
    "rent window must not auto-expand to 202606",
  );

  // skip-existing=0 does not drop a sync_months-complete 202606 cell
  const complete = new Set([`${YONGSAN_LAWD_CD}|202606|trade`]);
  const daily = applySkipExisting(yongsan.jobs, complete, false);
  assert.equal(daily.skipped, 0);
  assert.ok(
    daily.jobs.some((j) => j.yearMonth === "202606" && j.kind === "trade"),
  );
  const resumed = applySkipExisting(yongsan.jobs, complete, true);
  assert.ok(resumed.skipped >= 1);
  assert.equal(
    resumed.jobs.some((j) => j.yearMonth === "202606" && j.kind === "trade"),
    false,
  );

  // C. forced run: probe unchanged still executes warehouse sync
  assert.equal(
    shouldRunWarehouseSync({ force: true, probeStale: false }),
    true,
  );
  assert.equal(
    isForcedRollingSchedule({
      eventName: "schedule",
      schedule: FORCE_ROLLING_CRON_UTC.kst1800,
      utcHour: 9,
      utcMinute: 7,
    }),
    true,
    "18:00 KST cron stays forced even if runner starts late",
  );
  assert.equal(
    isForcedRollingSchedule({
      eventName: "schedule",
      utcHour: 21,
      utcMinute: 8,
    }),
    true,
    "06:00 KST 15-min grace",
  );
  assert.equal(
    isForcedRollingSchedule({
      eventName: "schedule",
      schedule: EVENING_PROBE_CRON_UTC,
      utcHour: 14,
      utcMinute: 0,
    }),
    false,
    "23:00 KST is probe-based, not forced",
  );

  // D. normal probe run keeps skip semantics
  assert.equal(
    shouldRunWarehouseSync({ force: false, probeStale: false }),
    false,
  );
  assert.equal(
    shouldRunWarehouseSync({ force: false, probeStale: true }),
    true,
  );
  assert.equal(
    isForcedRollingSchedule({
      eventName: "schedule",
      schedule: "*/15 0-5 * * *",
      utcHour: 1,
      utcMinute: 15,
    }),
    false,
  );

  // only-changed: late report N→N+1 is NOT unchanged
  const prior = [
    tx({ id: "old", dealAmount: 100000, dealDate: "2026-06-10" }),
  ];
  const withLate = [
    ...prior,
    tx({ id: "mijub", dealAmount: 178000, dealDate: "2026-06-30" }),
  ];
  const snap = { rowCount: prior.length, maxDealDate: "2026-06-10" };
  assert.equal(isCellUnchanged(snap, prior), true);
  assert.equal(isCellUnchanged(snap, withLate), false);

  const lawds = allCapitalLawdCodes();
  const cost = estimateRollingFetchCost(lawds.length);
  assert.equal(cost.tradeFetchesPerRun, lawds.length * 4);
  assert.equal(cost.rentFetchesPerRun, lawds.length * 2);
  assert.equal(cost.forcedRunsPerDay, 2);
  assert.equal(FORCED_ROLLING_RUNS_PER_DAY, 2);

  const workflow = readFileSync(
    resolve(".github/workflows/sync-molit.yml"),
    "utf8",
  );
  assert.match(workflow, /default: "4"/);
  assert.match(workflow, /TRADE=4/);
  assert.match(workflow, /RENT=2/);
  assert.match(workflow, /0 9 \* \* \*/);
  assert.match(workflow, /0 14 \* \* \*/);
  assert.match(workflow, /UTC_MIN" -lt 15/);
  assert.equal(workflow.includes('github.event.schedule }}" = "0 14 * * *"'), false);
}

async function mainDirtyPaths() {
  const db = getDb();
  assert.ok(db);
  await ensureSchema(db);

  const existing = [
    tx({ id: "old", dealAmount: 100000, dealDate: "2026-06-10", floor: 2 }),
  ];
  const first = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "202606",
    dealKind: "trade",
    items: existing,
    setFirstSeenOnInsert: true,
  });
  assert.equal(first.inserted, 1);
  const row = (
    await db.execute(
      `SELECT id, first_seen_at, last_seen_at, dealing_gbn FROM transactions`,
    )
  ).rows[0];
  assert.ok(row);
  const keepFirst = String(row!.first_seen_at);
  const keepLast = String(row!.last_seen_at);

  // E + F. unchanged re-fetch: first_seen + last_seen preserved, transaction write 0
  const noop = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "202606",
    dealKind: "trade",
    items: existing.map((t) => ({ ...t })),
    setFirstSeenOnInsert: true,
  });
  assert.equal(noop.inserted, 0);
  assert.equal(noop.updated, 0);
  assert.equal(noop.deleted, 0);
  assert.equal(noop.unchanged, 1);
  assert.equal(noop.wrote, false);
  const afterNoop = (
    await db.execute(`SELECT first_seen_at, last_seen_at FROM transactions`)
  ).rows[0];
  assert.equal(String(afterNoop!.first_seen_at), keepFirst);
  assert.equal(String(afterNoop!.last_seen_at), keepLast);

  const syncAfterNoop = await db.execute({
    sql: `SELECT row_count FROM sync_months WHERE lawd_cd=? AND year_month=? AND deal_kind='trade'`,
    args: [YONGSAN_LAWD_CD, "202606"],
  });
  // metadata exists from the original INSERT, but noop must not require a new tx write
  assert.equal(Number(syncAfterNoop.rows[0]?.row_count), 1);

  // G. new late-report → INSERT, existing first_seen untouched
  const withLate = [
    ...existing,
    tx({
      id: "mijub",
      dealAmount: 178000,
      dealDate: "2026-06-30",
      exclusiveArea: 149.09,
    }),
  ];
  const ins = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "202606",
    dealKind: "trade",
    items: withLate,
    setFirstSeenOnInsert: true,
  });
  assert.equal(ins.inserted, 1);
  assert.equal(ins.updated, 0);
  assert.equal(ins.unchanged, 1);
  assert.equal(ins.wrote, true);
  const oldAfterInsert = (
    await db.execute({
      sql: `SELECT first_seen_at FROM transactions WHERE deal_amount = ?`,
      args: [100000],
    })
  ).rows[0];
  assert.equal(String(oldAfterInsert!.first_seen_at), keepFirst);
  const lateRow = (
    await db.execute({
      sql: `SELECT first_seen_at FROM transactions WHERE deal_amount = ?`,
      args: [178000],
    })
  ).rows[0];
  assert.ok(lateRow?.first_seen_at);

  // H. actual correction → UPDATE, first_seen preserved, last_seen changes
  await new Promise((r) => setTimeout(r, 5));
  const corrected = withLate.map((t) =>
    t.dealAmount === 100000 ? { ...t, dealingGbn: "직거래" } : t,
  );
  const upd = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "202606",
    dealKind: "trade",
    items: corrected,
    setFirstSeenOnInsert: true,
  });
  assert.equal(upd.updated, 1);
  assert.equal(upd.inserted, 0);
  assert.equal(upd.wrote, true);
  const correctedRow = (
    await db.execute({
      sql: `SELECT first_seen_at, last_seen_at, dealing_gbn FROM transactions WHERE deal_amount = ?`,
      args: [100000],
    })
  ).rows[0];
  assert.equal(String(correctedRow!.first_seen_at), keepFirst);
  assert.notEqual(String(correctedRow!.last_seen_at), keepLast);
  assert.equal(String(correctedRow!.dealing_gbn), "직거래");

  const cancelPair = [
    tx({
      id: "live",
      dealAmount: 178000,
      dealDate: "2026-06-30",
      floor: 4,
      exclusiveArea: 149.09,
      jibun: "302-48",
      dong: "이촌동",
    }),
    tx({
      id: "cancel",
      dealAmount: 178000,
      dealDate: "2026-06-30",
      floor: 4,
      exclusiveArea: 149.09,
      jibun: "302-48",
      dong: "이촌동",
    }),
  ];
  const dup = await replaceMonthTransactions({
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "202605",
    dealKind: "trade",
    items: cancelPair,
    setFirstSeenOnInsert: true,
  });
  assert.equal(dup.inserted, 1);
  assert.equal(dup.updated, 0);
  const dupCount = await db.execute(
    `SELECT COUNT(*) AS n FROM transactions WHERE year_month='202605'`,
  );
  assert.equal(Number(dupCount.rows[0]?.n), 1);
}

async function main() {
  mainPolicy();
  await mainDirtyPaths();
  console.log(
    JSON.stringify(
      {
        ok: true,
        asOf: "2026-09-09",
        cases: [
          "A-trade-months-4-include-202606",
          "B-rent-months-2",
          "C-forced-bypass-probe",
          "D-normal-probe-skip",
          "E-first_seen-preserved",
          "F-unchanged-write-0",
          "G-late-insert",
          "H-correction-update",
          "skip-existing-0-keeps-complete-month",
          "cancel-pair-dedupes-to-1",
          "06:00-forced",
          "18:00-forced",
          "23:00-non-forced",
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
