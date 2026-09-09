/**
 * READ ONLY late-report coverage simulation.
 * Does not write production DB, does not run sync, does not call MOLIT
 * unless --api-sample=1 is passed (still no persist).
 *
 *   npx tsx scripts/simulate-late-report-coverage.ts
 *   npx tsx scripts/simulate-late-report-coverage.ts --lag-sample=1
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { allCapitalLawdCodes } from "../src/lib/constants/regions-registry";
import { seoulDateOf } from "../src/lib/market/time";
import {
  DAILY_RENT_MONTHS,
  DAILY_TRADE_MONTHS,
  FORCE_ROLLING_CRON_UTC,
  FORCED_ROLLING_RUNS_PER_DAY,
  YONGSAN_LAWD_CD,
  applySkipExisting,
  buildRollingSyncJobs,
  estimateRollingFetchCost,
  isForcedRollingSchedule,
  shouldRunWarehouseSync,
} from "../src/lib/molit/sync-policy";

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`) || process.argv.some((a) => a.startsWith(`--${name}=`));
}

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function monthLag(dealDate: string, firstSeenAt: string): number | null {
  const dealYm = dealDate.slice(0, 7);
  const seenDay = seoulDateOf(firstSeenAt);
  if (dealYm.length < 7 || seenDay.length < 7) return null;
  const dy = Number(dealYm.slice(0, 4));
  const dm = Number(dealYm.slice(5, 7));
  const sy = Number(seenDay.slice(0, 4));
  const sm = Number(seenDay.slice(5, 7));
  if (![dy, dm, sy, sm].every((n) => Number.isFinite(n))) return null;
  return sy * 12 + sm - (dy * 12 + dm);
}

async function optionalApiSample(): Promise<Record<string, unknown> | null> {
  if (argValue("api-sample", "0") !== "1") return null;
  if (!process.env.MOLIT_API_KEY) {
    console.log("[api-sample] skipped (no MOLIT_API_KEY)");
    return null;
  }
  const { fetchOneTradeForSync } = await import("../src/lib/molit/client");
  const items = await fetchOneTradeForSync(YONGSAN_LAWD_CD, "202606");
  const mijub = items.filter((tx) => {
    const name = tx.aptName.replace(/\s+/g, "");
    return (
      name.includes("미주") &&
      Math.abs(tx.exclusiveArea - 149.09) < 0.05 &&
      tx.dealAmount === 178000 &&
      tx.dealDate === "2026-06-30"
    );
  });
  return {
    lawdCd: YONGSAN_LAWD_CD,
    yearMonth: "202606",
    apiRowCount: items.length,
    mijubMatches: mijub.length,
    persist: 0,
  };
}

async function optionalLagSample(): Promise<Record<string, number> | null> {
  if (argValue("lag-sample", "0") !== "1" && !hasFlag("lag-sample")) {
    return null;
  }
  if (!process.env.TURSO_DATABASE_URL) {
    console.log("[lag-sample] skipped (no TURSO_DATABASE_URL)");
    return null;
  }
  const { getDb } = await import("../src/lib/db/client");
  const db = getDb();
  if (!db) {
    console.log("[lag-sample] skipped (db unavailable)");
    return null;
  }
  const res = await db.execute({
    sql: `SELECT deal_date, first_seen_at
          FROM transactions
          WHERE deal_type = 'trade'
            AND first_seen_at IS NOT NULL
            AND first_seen_at != ''
          ORDER BY first_seen_at DESC
          LIMIT 2000`,
    args: [],
  });
  const buckets = { "0m": 0, "1m": 0, "2m": 0, "3m": 0, "4m+": 0, unknown: 0 };
  for (const row of res.rows) {
    const lag = monthLag(String(row.deal_date ?? ""), String(row.first_seen_at ?? ""));
    if (lag == null || lag < 0) buckets.unknown += 1;
    else if (lag === 0) buckets["0m"] += 1;
    else if (lag === 1) buckets["1m"] += 1;
    else if (lag === 2) buckets["2m"] += 1;
    else if (lag === 3) buckets["3m"] += 1;
    else buckets["4m+"] += 1;
  }
  const recent = await db.execute({
    sql: `SELECT deal_date, first_seen_at
          FROM transactions
          WHERE deal_type = 'trade'
            AND first_seen_at IS NOT NULL
            AND first_seen_at != ''
            AND first_seen_at >= ?
          ORDER BY first_seen_at DESC
          LIMIT 2000`,
    args: [new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString()],
  });
  const recentBuckets = { "0m": 0, "1m": 0, "2m": 0, "3m": 0, "4m+": 0, unknown: 0 };
  for (const row of recent.rows) {
    const lag = monthLag(String(row.deal_date ?? ""), String(row.first_seen_at ?? ""));
    if (lag == null || lag < 0) recentBuckets.unknown += 1;
    else if (lag === 0) recentBuckets["0m"] += 1;
    else if (lag === 1) recentBuckets["1m"] += 1;
    else if (lag === 2) recentBuckets["2m"] += 1;
    else if (lag === 3) recentBuckets["3m"] += 1;
    else recentBuckets["4m+"] += 1;
  }
  const mijub = await db.execute({
    sql: `SELECT id, apt_name, deal_date, exclusive_area, deal_amount
          FROM transactions
          WHERE lawd_cd = ?
            AND year_month = '202606'
            AND deal_type = 'trade'
            AND deal_date = '2026-06-30'
            AND deal_amount = 178000
          LIMIT 5`,
    args: [YONGSAN_LAWD_CD],
  });
  return {
    sampled: res.rows.length,
    ...buckets,
    recent14dSampled: recent.rows.length,
    recent14d: recentBuckets,
    yongsanMijubWarehouseRows: mijub.rows.length,
  };
}

async function main() {
  const asOf = new Date("2026-09-09T12:00:00+09:00");
  const lawds = allCapitalLawdCodes();
  const planned = buildRollingSyncJobs({
    lawdCodes: lawds,
    asOf,
  });
  const yongsanJobs = planned.jobs.filter((j) => j.lawdCd === YONGSAN_LAWD_CD);
  const yongsanTrade202606 = yongsanJobs.find(
    (j) => j.yearMonth === "202606" && j.kind === "trade",
  );
  const allJobKeys = planned.jobs.map((j) => `${j.lawdCd}|${j.yearMonth}|${j.kind}`);
  const skip0 = applySkipExisting(planned.jobs, allJobKeys, false);
  const skip1 = applySkipExisting(planned.jobs, allJobKeys, true);

  const probeUnchangedForced = shouldRunWarehouseSync({
    force: isForcedRollingSchedule({
      eventName: "schedule",
      schedule: FORCE_ROLLING_CRON_UTC.kst1800,
      utcHour: 9,
      utcMinute: 0,
    }),
    probeStale: false,
  });
  const probeUnchangedNormal = shouldRunWarehouseSync({
    force: isForcedRollingSchedule({
      eventName: "schedule",
      schedule: "*/15 0-5 * * *",
      utcHour: 2,
      utcMinute: 0,
    }),
    probeStale: false,
  });

  const oldTradeFetches = lawds.length * 2;
  const cost = estimateRollingFetchCost(lawds.length);
  const lag = await optionalLagSample();
  const apiSample = await optionalApiSample();

  const report = {
    asOf: "2026-09-09",
    write: 0,
    molitCells: apiSample ? 1 : 0,
    tradeMonths: planned.tradeYms,
    rentMonths: planned.rentYms,
    yongsanLawd: YONGSAN_LAWD_CD,
    "202606 included": planned.tradeYms.includes("202606"),
    "Yongsan 202606 trade job": Boolean(yongsanTrade202606),
    "probe unchanged forced run executes": probeUnchangedForced,
    "normal probe skip when fresh": probeUnchangedNormal === false,
    skipExisting0KeepsJobs: skip0.jobs.length === planned.jobs.length,
    skipExisting1WouldDropAll: skip1.jobs.length === 0,
    dailyFlags: {
      skipExisting: 0,
      onlyChanged: 1,
      tradeMonths: DAILY_TRADE_MONTHS,
      rentMonths: DAILY_RENT_MONTHS,
      forcedRunsPerDay: FORCED_ROLLING_RUNS_PER_DAY,
    },
    cost: {
      lawdCount: lawds.length,
      oldTradeFetchesPerFullRun: oldTradeFetches,
      newTradeFetchesPerFullRun: cost.tradeFetchesPerRun,
      rentFetchesPerFullRun: cost.rentFetchesPerRun,
      totalFetchesPerFullRun: cost.totalFetchesPerRun,
      estimatedDailyForcedFetches: cost.estimatedDailyForcedFetches,
    },
    lagSample: lag,
    apiSample,
  };

  console.log(JSON.stringify(report, null, 2));

  if (
    !report["202606 included"] ||
    !report["Yongsan 202606 trade job"] ||
    !report["probe unchanged forced run executes"]
  ) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
