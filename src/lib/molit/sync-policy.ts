/**
 * Daily MOLIT warehouse ingestion policy.
 *
 * MOLIT AptTrade is queried by contract month (DEAL_YMD), not publication day.
 * Late-reported past contracts are invisible unless those contract months are
 * re-fetched. Request paths must never call this module to trigger MOLIT.
 */

import { seoulToday, yearMonthFromSeoulDate } from "@/lib/market/time";
import type { DealType } from "@/types/transaction";

/** Daily rolling window: current KST month + previous 3 (covers ~3-month late reports). */
export const DAILY_TRADE_MONTHS = 4;
/** Rent is not part of the current late-report blocker — keep the cheaper window. */
export const DAILY_RENT_MONTHS = 2;

export const YONGSAN_LAWD_CD = "11170";

/** Dedicated evening force cron (UTC). GitHub `github.event.schedule` must match exactly. */
export const FORCE_ROLLING_CRON_UTC = {
  kst1800: "0 9 * * *",
} as const;

/** 23:00 KST evening probe slot — not forced. Current-month sentinel may still trigger rolling sync. */
export const EVENING_PROBE_CRON_UTC = "0 14 * * *";

/**
 * 06:00 KST sits inside the 15-minute probe cron (21-23 UTC).
 * Use a 15-minute grace so a delayed runner still forces the morning rolling sync.
 */
export const MORNING_FORCE_UTC = { hour: 21, minuteMaxExclusive: 15 } as const;

export const FORCED_ROLLING_RUNS_PER_DAY = 2;

export type RollingSyncJob = {
  lawdCd: string;
  yearMonth: string;
  kind: DealType;
};

export type DbCellSnap = { rowCount: number; maxDealDate: string };

/** Recent N contract months, newest first, on the Asia/Seoul calendar. */
export function rollingYearMonths(count: number, asOf: Date = new Date()): string[] {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return [];
  const today = seoulToday(asOf);
  let y = Number(today.slice(0, 4));
  let m = Number(today.slice(5, 7));
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

export function dailyTradeMonths(asOf: Date = new Date()): string[] {
  return rollingYearMonths(DAILY_TRADE_MONTHS, asOf);
}

export function dailyRentMonths(asOf: Date = new Date()): string[] {
  return rollingYearMonths(DAILY_RENT_MONTHS, asOf);
}

export function buildRollingSyncJobs(params: {
  lawdCodes: string[];
  tradeMonths?: number;
  rentMonths?: number;
  asOf?: Date;
}): { tradeYms: string[]; rentYms: string[]; jobs: RollingSyncJob[] } {
  const asOf = params.asOf ?? new Date();
  const tradeMonths = params.tradeMonths ?? DAILY_TRADE_MONTHS;
  const rentMonths = params.rentMonths ?? DAILY_RENT_MONTHS;
  const tradeYms = rollingYearMonths(Math.min(Math.max(tradeMonths, 0), 240), asOf);
  const rentYms = rollingYearMonths(Math.min(Math.max(rentMonths, 0), 240), asOf);
  const jobs: RollingSyncJob[] = [];
  for (const lawdCd of params.lawdCodes) {
    for (const yearMonth of tradeYms) {
      jobs.push({ lawdCd, yearMonth, kind: "trade" });
    }
    for (const yearMonth of rentYms) {
      jobs.push({ lawdCd, yearMonth, kind: "rent" });
    }
  }
  return { tradeYms, rentYms, jobs };
}

export function jobKey(job: RollingSyncJob): string {
  return `${job.lawdCd}|${job.yearMonth}|${job.kind}`;
}

/**
 * `--skip-existing=1` resumes historical backfill by dropping cells already
 * present in sync_months. Daily late-report sync MUST pass skipExisting=false
 * so a "complete" past month is still re-fetched.
 */
export function applySkipExisting(
  jobs: RollingSyncJob[],
  existingCells: Iterable<string>,
  skipExisting: boolean,
): { jobs: RollingSyncJob[]; skipped: number } {
  if (!skipExisting) return { jobs, skipped: 0 };
  const have = existingCells instanceof Set ? existingCells : new Set(existingCells);
  const kept = jobs.filter((j) => !have.has(jobKey(j)));
  return { jobs: kept, skipped: jobs.length - kept.length };
}

export function maxDealDateOf(items: Array<{ dealDate: string }>): string {
  let max = "";
  for (const tx of items) {
    if (tx.dealDate > max) max = tx.dealDate;
  }
  return max;
}

/**
 * only-changed prefilter: skip replaceMonthTransactions when API row count and
 * max deal_date match the warehouse snapshot.
 *
 * Known residual risk (not redesigned here): same count + same max date can
 * hide an in-place field correction. New late reports change rowCount (N→N+1)
 * and therefore pass this filter.
 */
export function isCellUnchanged(
  snap: DbCellSnap | undefined,
  items: Array<{ dealDate: string }>,
): boolean {
  if (!snap) return false;
  return snap.rowCount === items.length && snap.maxDealDate === maxDealDateOf(items);
}

export function shouldRunWarehouseSync(params: {
  force: boolean;
  probeStale: boolean;
}): boolean {
  return params.force || params.probeStale;
}

export function isForcedRollingSchedule(params: {
  eventName: string;
  schedule?: string;
  utcHour: number;
  utcMinute: number;
  dispatchForce?: boolean;
}): boolean {
  if (params.eventName === "workflow_dispatch" && params.dispatchForce !== false) {
    return true;
  }
  if (params.schedule === FORCE_ROLLING_CRON_UTC.kst1800) {
    return true;
  }
  if (
    params.utcHour === MORNING_FORCE_UTC.hour &&
    params.utcMinute < MORNING_FORCE_UTC.minuteMaxExclusive
  ) {
    return true;
  }
  return false;
}

export function estimateRollingFetchCost(lawdCount: number): {
  lawdCount: number;
  tradeMonths: number;
  rentMonths: number;
  tradeFetchesPerRun: number;
  rentFetchesPerRun: number;
  totalFetchesPerRun: number;
  forcedRunsPerDay: number;
  estimatedDailyForcedFetches: number;
} {
  const tradeFetchesPerRun = lawdCount * DAILY_TRADE_MONTHS;
  const rentFetchesPerRun = lawdCount * DAILY_RENT_MONTHS;
  const totalFetchesPerRun = tradeFetchesPerRun + rentFetchesPerRun;
  return {
    lawdCount,
    tradeMonths: DAILY_TRADE_MONTHS,
    rentMonths: DAILY_RENT_MONTHS,
    tradeFetchesPerRun,
    rentFetchesPerRun,
    totalFetchesPerRun,
    forcedRunsPerDay: FORCED_ROLLING_RUNS_PER_DAY,
    estimatedDailyForcedFetches: totalFetchesPerRun * FORCED_ROLLING_RUNS_PER_DAY,
  };
}

export function seoulYearMonthOf(asOf: Date): string {
  return yearMonthFromSeoulDate(seoulToday(asOf));
}
