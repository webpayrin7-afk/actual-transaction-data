import { getDb, hasDb, ensureSchema } from "@/lib/db/client";
import { LAWD_TO_REGION, ALL_REGIONS } from "@/lib/constants/regions";
import {
  MARKET_COMPLEX_KEY_VERSION,
  addDays,
  addMonths,
  medianOf,
  metroFromLawd,
  monthKey,
  resolvePeriodWindow,
  weekStartMonday,
  type StatsPeriod,
  type StatsScope,
} from "@/lib/market/keys";
import {
  readStatsDealFeed,
  rebuildAllStatsDealFeeds,
  computeStatsDealFeed,
  type StatsDealFeed,
} from "@/lib/market/stats-feeds";
import type { MarketDealItem, MarketVolumeItem } from "@/lib/market/home";
import { judgeTradesChronological } from "@/lib/market/judge";

/** 차트·KPI용 일별 집계 보관 기간 */
const STATS_KEEP_MONTHS = 24;
/** 신고가/하락 prior 정확도를 위한 워밍업(running max) 기간 */
const HIST_WARMUP_MONTHS = 36;

const READ_CACHE_TTL_MS = 60_000;

export interface StatsDayRow {
  day: string;
  scope: StatsScope;
  tradeCount: number;
  singogaCount: number;
  dropCount: number;
  medianAmount: number | null;
  avgAmount: number | null;
  medianPpsqm: number | null;
}

export interface StatsRegionDayRow {
  day: string;
  lawdCd: string;
  metro: "seoul" | "gyeonggi";
  regionSlug: string;
  regionName: string;
  tradeCount: number;
  singogaCount: number;
  dropCount: number;
}

export interface StatsSeriesPoint {
  key: string; // day | weekStart | YYYY-MM
  label: string;
  tradeCount: number;
  singogaCount: number;
  dropCount: number;
  medianAmount: number | null;
  medianPpsqm: number | null;
}

export interface StatsKpiBlock {
  tradeCount: number;
  tradePrev: number;
  tradeChangePct: number | null;
  singogaCount: number;
  singogaPrev: number;
  singogaChangePct: number | null;
  singogaSharePct: number | null;
  dropCount: number;
  dropPrev: number;
  dropChangePct: number | null;
  dropSharePct: number | null;
  medianAmount: number | null;
  medianAmountPrev: number | null;
  medianPpsqm: number | null;
  windowLabel: string;
  prevWindowLabel: string;
  compareLabel: string;
  reportingLagRisk: boolean;
  /** 주/월 중위가는 일별 중위의 중위(근사). true면 UI에서 안내 */
  medianIsApprox: boolean;
  windowFrom: string;
  windowTo: string;
  chartFrom: string;
  chartTo: string;
  canGoNext: boolean;
  canGoPrev: boolean;
  prevAnchor: string;
  nextAnchor: string;
  anchorDate: string;
}

export interface StatsRegionRank {
  lawdCd: string;
  regionSlug: string;
  regionName: string;
  metro: "seoul" | "gyeonggi";
  tradeCount: number;
  tradePrev: number;
  increaseCount: number;
  growthPct: number | null;
  singogaCount: number;
  singogaSharePct: number | null;
  dropCount: number;
  dropSharePct: number | null;
  href: string;
}

export interface MarketStatsResponse {
  source: "preagg" | "empty";
  asOfDate: string | null;
  selectedDate: string | null;
  computedAt: string | null;
  period: StatsPeriod;
  scope: StatsScope;
  dateBasisNote: string;
  complexKeyVersion: string;
  series: StatsSeriesPoint[];
  kpi: StatsKpiBlock | null;
  rankings: {
    volumeTop: StatsRegionRank[];
    growthTop: StatsRegionRank[];
    singogaTop: StatsRegionRank[];
    dropTop: StatsRegionRank[];
  };
  feeds: {
    notables: MarketDealItem[];
    singoga: MarketDealItem[];
    drops: MarketDealItem[];
    activeComplexes: MarketVolumeItem[];
    windowLabel: string;
    prevWindowLabel: string;
    windowFrom: string;
    windowTo: string;
  } | null;
  warning?: string;
}

type ScopeAcc = {
  tradeCount: number;
  singogaCount: number;
  dropCount: number;
  amounts: number[];
  ppsqm: number[];
};

type RegionAcc = {
  tradeCount: number;
  singogaCount: number;
  dropCount: number;
  metro: "seoul" | "gyeonggi";
  regionSlug: string;
  regionName: string;
};

let readCache: {
  expiresAt: number;
  key: string;
  data: MarketStatsResponse;
} | null = null;

function lawdMeta(lawdCd: string): {
  metro: "seoul" | "gyeonggi";
  regionSlug: string;
  regionName: string;
} | null {
  const metro = metroFromLawd(lawdCd);
  if (metro === "other") return null;
  const region = LAWD_TO_REGION[lawdCd];
  if (region) {
    return {
      metro,
      regionSlug: region.slug,
      regionName: region.name,
    };
  }
  const fallback = ALL_REGIONS.find((r) => r.lawdCodes.includes(lawdCd));
  if (!fallback) return null;
  return {
    metro,
    regionSlug: fallback.slug,
    regionName: fallback.name,
  };
}

function emptyStats(
  period: StatsPeriod,
  scope: StatsScope,
  warning?: string,
): MarketStatsResponse {
  return {
    source: "empty",
    asOfDate: null,
    selectedDate: null,
    computedAt: null,
    period,
    scope,
    dateBasisNote:
      "계약일(deal_date) 기준입니다. 국토부 신고·적재 시차로 ‘오늘’과 다를 수 있습니다.",
    complexKeyVersion: MARKET_COMPLEX_KEY_VERSION,
    series: [],
    kpi: null,
    rankings: {
      volumeTop: [],
      growthTop: [],
      singogaTop: [],
      dropTop: [],
    },
    feeds: null,
    warning,
  };
}

function pctChange(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

function yearMonthsBetween(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  let cur = fromDay.slice(0, 7) + "-01";
  const end = toDay.slice(0, 7) + "-01";
  while (cur <= end) {
    out.push(cur.slice(0, 4) + cur.slice(5, 7));
    cur = addMonths(cur, 1);
  }
  return out;
}

/** sync / db:stats — 일별 사전 집계 재생성 */
export async function rebuildMarketStats(): Promise<{
  asOfDate: string;
  days: number;
  regions: number;
  ms: number;
}> {
  if (!hasDb()) throw new Error("DB unavailable");
  await ensureSchema();
  const db = getDb();
  if (!db) throw new Error("DB unavailable");

  const t0 = Date.now();
  const maxRow = await db.execute({
    sql: `SELECT MAX(deal_date) AS m FROM transactions WHERE deal_type = ?`,
    args: ["trade"],
  });
  const asOfDate = String(maxRow.rows[0]?.m ?? "");
  if (!asOfDate) throw new Error("no trade data");

  const statsFrom = addMonths(asOfDate, -STATS_KEEP_MONTHS);
  const histFrom = addMonths(asOfDate, -HIST_WARMUP_MONTHS);

  const runningMax = new Map<string, number>();
  const scopeDay = new Map<string, ScopeAcc>(); // day|scope
  const regionDay = new Map<string, RegionAcc>(); // day|lawd

  function bumpScope(
    day: string,
    scope: StatsScope,
    amount: number,
    area: number,
    flags: { singoga: boolean; drop: boolean },
  ) {
    const key = `${day}|${scope}`;
    let acc = scopeDay.get(key);
    if (!acc) {
      acc = {
        tradeCount: 0,
        singogaCount: 0,
        dropCount: 0,
        amounts: [],
        ppsqm: [],
      };
      scopeDay.set(key, acc);
    }
    acc.tradeCount += 1;
    if (flags.singoga) acc.singogaCount += 1;
    if (flags.drop) acc.dropCount += 1;
    if (day >= statsFrom) {
      acc.amounts.push(amount);
      if (area > 0) acc.ppsqm.push(amount / area);
    }
  }

  function bumpRegion(
    day: string,
    lawdCd: string,
    flags: { singoga: boolean; drop: boolean },
  ) {
    if (day < statsFrom) return;
    const meta = lawdMeta(lawdCd);
    if (!meta) return;
    const key = `${day}|${lawdCd}`;
    let acc = regionDay.get(key);
    if (!acc) {
      acc = {
        tradeCount: 0,
        singogaCount: 0,
        dropCount: 0,
        metro: meta.metro,
        regionSlug: meta.regionSlug,
        regionName: meta.regionName,
      };
      regionDay.set(key, acc);
    }
    acc.tradeCount += 1;
    if (flags.singoga) acc.singogaCount += 1;
    if (flags.drop) acc.dropCount += 1;
  }

  const months = yearMonthsBetween(histFrom, asOfDate);
  for (const ym of months) {
    const result = await db.execute({
      sql: `SELECT id, lawd_cd, deal_date, apt_name_norm, dong,
                   exclusive_area, deal_amount
            FROM transactions
            WHERE deal_type = ?
              AND year_month = ?
              AND deal_date >= ?
              AND deal_date <= ?
            ORDER BY deal_date ASC, id ASC`,
      args: ["trade", ym, histFrom, asOfDate],
    });

    const monthTrades = [];
    for (const row of result.rows) {
      const amount = Number(row.deal_amount) || 0;
      if (amount <= 0) continue;
      monthTrades.push({
        id: String(row.id),
        dealDate: String(row.deal_date).slice(0, 10),
        aptNameNorm: String(row.apt_name_norm),
        lawdCd: String(row.lawd_cd),
        dong: String(row.dong ?? ""),
        exclusiveArea: Number(row.exclusive_area) || 0,
        dealAmount: amount,
      });
    }

    // 동일일 비연쇄 — runningMax는 월을 넘어 유지
    const flagsMap = judgeTradesChronological(monthTrades, runningMax);

    for (const t of monthTrades) {
      const f = flagsMap.get(t.id);
      const flags = {
        singoga: Boolean(f?.singoga),
        drop: Boolean(f?.drop),
      };
      const day = t.dealDate;
      if (day >= statsFrom) {
        bumpScope(day, "all", t.dealAmount, t.exclusiveArea, flags);
        const metro = metroFromLawd(t.lawdCd);
        if (metro === "seoul")
          bumpScope(day, "seoul", t.dealAmount, t.exclusiveArea, flags);
        if (metro === "gyeonggi")
          bumpScope(day, "gyeonggi", t.dealAmount, t.exclusiveArea, flags);
        bumpRegion(day, t.lawdCd, flags);
      }
    }
  }

  // persist
  await db.execute(`DELETE FROM market_stats_daily`);
  await db.execute(`DELETE FROM market_stats_daily_region`);

  const dailyArgs: Array<Array<string | number | null>> = [];
  for (const [mapKey, acc] of scopeDay) {
    const [day, scope] = mapKey.split("|") as [string, StatsScope];
    if (day < statsFrom) continue;
    const medianAmount = medianOf(acc.amounts);
    const avgAmount =
      acc.amounts.length > 0
        ? Math.round(
            acc.amounts.reduce((s, v) => s + v, 0) / acc.amounts.length,
          )
        : null;
    const medianPpsqm = medianOf(acc.ppsqm);
    dailyArgs.push([
      day,
      scope,
      acc.tradeCount,
      acc.singogaCount,
      acc.dropCount,
      medianAmount,
      avgAmount,
      medianPpsqm == null ? null : Math.round(medianPpsqm * 100) / 100,
    ]);
  }

  // batch insert
  const CHUNK = 200;
  for (let i = 0; i < dailyArgs.length; i += CHUNK) {
    const slice = dailyArgs.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "(?,?,?,?,?,?,?,?)").join(",");
    await db.execute({
      sql: `INSERT INTO market_stats_daily
            (day, scope, trade_count, singoga_count, drop_count, median_amount, avg_amount, median_ppsqm)
            VALUES ${placeholders}`,
      args: slice.flat(),
    });
  }

  const regionArgs: Array<Array<string | number>> = [];
  for (const [mapKey, acc] of regionDay) {
    const [day, lawdCd] = mapKey.split("|");
    if (!day || !lawdCd || day < statsFrom) continue;
    regionArgs.push([
      day,
      lawdCd,
      acc.metro,
      acc.regionSlug,
      acc.regionName,
      acc.tradeCount,
      acc.singogaCount,
      acc.dropCount,
    ]);
  }

  for (let i = 0; i < regionArgs.length; i += CHUNK) {
    const slice = regionArgs.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "(?,?,?,?,?,?,?,?)").join(",");
    await db.execute({
      sql: `INSERT INTO market_stats_daily_region
            (day, lawd_cd, metro, region_slug, region_name, trade_count, singoga_count, drop_count)
            VALUES ${placeholders}`,
      args: slice.flat(),
    });
  }

  const computedAt = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO market_stats_meta (id, as_of_date, computed_at, hist_from, stats_from)
          VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            as_of_date = excluded.as_of_date,
            computed_at = excluded.computed_at,
            hist_from = excluded.hist_from,
            stats_from = excluded.stats_from`,
    args: [asOfDate, computedAt, histFrom, statsFrom],
  });

  // 기간×지역 실거래 피드 스냅샷 (요청 시 대량 스캔 방지)
  try {
    await rebuildAllStatsDealFeeds(asOfDate);
  } catch (err) {
    console.warn("[market-stats] deal feeds rebuild failed:", err);
  }

  readCache = null;

  return {
    asOfDate,
    days: dailyArgs.length,
    regions: regionArgs.length,
    ms: Date.now() - t0,
  };
}

async function loadMeta(): Promise<{
  asOfDate: string;
  computedAt: string;
} | null> {
  const db = getDb();
  if (!db) return null;
  const r = await db.execute({
    sql: `SELECT as_of_date, computed_at FROM market_stats_meta WHERE id = 1`,
    args: [],
  });
  const row = r.rows[0];
  if (!row?.as_of_date) return null;
  return {
    asOfDate: String(row.as_of_date),
    computedAt: String(row.computed_at ?? ""),
  };
}

async function loadDailyScope(
  scope: StatsScope,
  from: string,
  to: string,
): Promise<StatsDayRow[]> {
  const db = getDb();
  if (!db) return [];
  const r = await db.execute({
    sql: `SELECT day, scope, trade_count, singoga_count, drop_count,
                 median_amount, avg_amount, median_ppsqm
          FROM market_stats_daily
          WHERE scope = ? AND day >= ? AND day <= ?
          ORDER BY day ASC`,
    args: [scope, from, to],
  });
  return r.rows.map((row) => ({
    day: String(row.day),
    scope: String(row.scope) as StatsScope,
    tradeCount: Number(row.trade_count) || 0,
    singogaCount: Number(row.singoga_count) || 0,
    dropCount: Number(row.drop_count) || 0,
    medianAmount:
      row.median_amount == null ? null : Number(row.median_amount),
    avgAmount: row.avg_amount == null ? null : Number(row.avg_amount),
    medianPpsqm: row.median_ppsqm == null ? null : Number(row.median_ppsqm),
  }));
}

async function loadRegionRange(
  scope: StatsScope,
  from: string,
  to: string,
): Promise<StatsRegionDayRow[]> {
  const db = getDb();
  if (!db) return [];
  const metroFilter =
    scope === "all"
      ? ""
      : scope === "seoul"
        ? "AND metro = 'seoul'"
        : "AND metro = 'gyeonggi'";
  const r = await db.execute({
    sql: `SELECT day, lawd_cd, metro, region_slug, region_name,
                 trade_count, singoga_count, drop_count
          FROM market_stats_daily_region
          WHERE day >= ? AND day <= ?
          ${metroFilter}
          ORDER BY day ASC`,
    args: [from, to],
  });
  return r.rows.map((row) => ({
    day: String(row.day),
    lawdCd: String(row.lawd_cd),
    metro: String(row.metro) as "seoul" | "gyeonggi",
    regionSlug: String(row.region_slug),
    regionName: String(row.region_name),
    tradeCount: Number(row.trade_count) || 0,
    singogaCount: Number(row.singoga_count) || 0,
    dropCount: Number(row.drop_count) || 0,
  }));
}

function rollupSeries(
  days: StatsDayRow[],
  period: StatsPeriod,
): StatsSeriesPoint[] {
  if (period === "daily") {
    return days.map((d) => ({
      key: d.day,
      label: d.day.slice(5).replace("-", "/"),
      tradeCount: d.tradeCount,
      singogaCount: d.singogaCount,
      dropCount: d.dropCount,
      medianAmount: d.medianAmount,
      medianPpsqm: d.medianPpsqm,
    }));
  }

  type Bucket = {
    key: string;
    label: string;
    tradeCount: number;
    singogaCount: number;
    dropCount: number;
    amounts: number[];
    ppsqm: number[];
  };
  const map = new Map<string, Bucket>();

  for (const d of days) {
    const key =
      period === "weekly" ? weekStartMonday(d.day) : monthKey(d.day);
    // 슬래시 표기: "05.11"은 Number()로 파싱되어 Recharts 축이 깨질 수 있음
    const label =
      period === "weekly"
        ? key.slice(5).replace("-", "/")
        : key.slice(2).replace("-", "/");
    let b = map.get(key);
    if (!b) {
      b = {
        key,
        label,
        tradeCount: 0,
        singogaCount: 0,
        dropCount: 0,
        amounts: [],
        ppsqm: [],
      };
      map.set(key, b);
    }
    b.tradeCount += d.tradeCount;
    b.singogaCount += d.singogaCount;
    b.dropCount += d.dropCount;
    if (d.medianAmount != null) b.amounts.push(d.medianAmount);
    if (d.medianPpsqm != null) b.ppsqm.push(d.medianPpsqm);
  }

  return [...map.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((b) => ({
      key: b.key,
      label: b.label,
      tradeCount: b.tradeCount,
      singogaCount: b.singogaCount,
      dropCount: b.dropCount,
      // 일별 중위의 중위 ≈ 기간 중위 근사 (사전집계 비용 대비 실용)
      medianAmount: medianOf(b.amounts),
      medianPpsqm: medianOf(b.ppsqm),
    }));
}

function sumDays(
  days: StatsDayRow[],
  from: string,
  to: string,
): {
  trade: number;
  singoga: number;
  drop: number;
  medians: number[];
  ppsqm: number[];
} {
  let trade = 0;
  let singoga = 0;
  let drop = 0;
  const medians: number[] = [];
  const ppsqm: number[] = [];
  for (const d of days) {
    if (d.day < from || d.day > to) continue;
    trade += d.tradeCount;
    singoga += d.singogaCount;
    drop += d.dropCount;
    if (d.medianAmount != null) medians.push(d.medianAmount);
    if (d.medianPpsqm != null) ppsqm.push(d.medianPpsqm);
  }
  return { trade, singoga, drop, medians, ppsqm };
}

function buildKpi(
  days: StatsDayRow[],
  selectedDate: string,
  asOf: string,
  period: StatsPeriod,
): StatsKpiBlock {
  const w = resolvePeriodWindow(selectedDate, period, asOf);
  const cur = sumDays(days, w.curFrom, w.curTo);
  const prev = sumDays(days, w.prevFrom, w.prevTo);

  return {
    tradeCount: cur.trade,
    tradePrev: prev.trade,
    tradeChangePct: pctChange(cur.trade, prev.trade),
    singogaCount: cur.singoga,
    singogaPrev: prev.singoga,
    singogaChangePct: pctChange(cur.singoga, prev.singoga),
    singogaSharePct:
      cur.trade > 0
        ? Math.round((cur.singoga / cur.trade) * 1000) / 10
        : null,
    dropCount: cur.drop,
    dropPrev: prev.drop,
    dropChangePct: pctChange(cur.drop, prev.drop),
    dropSharePct:
      cur.trade > 0 ? Math.round((cur.drop / cur.trade) * 1000) / 10 : null,
    medianAmount: medianOf(cur.medians),
    medianAmountPrev: medianOf(prev.medians),
    medianPpsqm: medianOf(cur.ppsqm),
    windowLabel: w.windowLabel,
    prevWindowLabel: w.prevWindowLabel,
    compareLabel: w.compareLabel,
    reportingLagRisk: w.reportingLagRisk,
    medianIsApprox: period !== "daily",
    windowFrom: w.curFrom,
    windowTo: w.curTo,
    chartFrom: w.chartFrom,
    chartTo: w.chartTo,
    canGoNext: w.canGoNext,
    canGoPrev: w.canGoPrev,
    prevAnchor: w.prevAnchor,
    nextAnchor: w.nextAnchor,
    anchorDate: w.anchorDate,
  };
}

function buildRankings(
  rows: StatsRegionDayRow[],
  selectedDate: string,
  asOf: string,
  period: StatsPeriod,
): MarketStatsResponse["rankings"] {
  const w = resolvePeriodWindow(selectedDate, period, asOf);
  const { curFrom, curTo, prevFrom, prevTo } = w;
  const minTrades =
    period === "daily" ? 5 : period === "weekly" ? 8 : 20;

  type Agg = {
    lawdCd: string;
    regionSlug: string;
    regionName: string;
    metro: "seoul" | "gyeonggi";
    curTrade: number;
    prevTrade: number;
    curSingoga: number;
    curDrop: number;
  };
  const map = new Map<string, Agg>();

  for (const r of rows) {
    let a = map.get(r.lawdCd);
    if (!a) {
      a = {
        lawdCd: r.lawdCd,
        regionSlug: r.regionSlug,
        regionName: r.regionName,
        metro: r.metro,
        curTrade: 0,
        prevTrade: 0,
        curSingoga: 0,
        curDrop: 0,
      };
      map.set(r.lawdCd, a);
    }
    if (r.day >= curFrom && r.day <= curTo) {
      a.curTrade += r.tradeCount;
      a.curSingoga += r.singogaCount;
      a.curDrop += r.dropCount;
    } else if (r.day >= prevFrom && r.day <= prevTo) {
      a.prevTrade += r.tradeCount;
    }
  }

  const list: StatsRegionRank[] = [...map.values()].map((a) => ({
    lawdCd: a.lawdCd,
    regionSlug: a.regionSlug,
    regionName: a.regionName,
    metro: a.metro,
    tradeCount: a.curTrade,
    tradePrev: a.prevTrade,
    increaseCount: a.curTrade - a.prevTrade,
    growthPct: pctChange(a.curTrade, a.prevTrade),
    singogaCount: a.curSingoga,
    singogaSharePct:
      a.curTrade > 0
        ? Math.round((a.curSingoga / a.curTrade) * 1000) / 10
        : null,
    dropCount: a.curDrop,
    dropSharePct:
      a.curTrade > 0 ? Math.round((a.curDrop / a.curTrade) * 1000) / 10 : null,
    href: `/region/${a.regionSlug}`,
  }));

  const volumeTop = [...list]
    .filter((x) => x.tradeCount > 0)
    .sort((a, b) => b.tradeCount - a.tradeCount)
    .slice(0, 8);

  const growthTop = [...list]
    .filter(
      (x) =>
        x.tradeCount >= minTrades &&
        x.tradePrev >= Math.max(3, Math.floor(minTrades / 2)) &&
        (x.growthPct ?? 0) > 0,
    )
    .sort((a, b) => (b.growthPct ?? 0) - (a.growthPct ?? 0))
    .slice(0, 8);

  const singogaTop = [...list]
    .filter((x) => x.singogaCount > 0 && x.tradeCount >= minTrades)
    .sort(
      (a, b) =>
        b.singogaCount - a.singogaCount ||
        (b.singogaSharePct ?? 0) - (a.singogaSharePct ?? 0),
    )
    .slice(0, 8);

  const dropTop = [...list]
    .filter((x) => x.dropCount > 0 && x.tradeCount >= minTrades)
    .sort(
      (a, b) =>
        b.dropCount - a.dropCount ||
        (b.dropSharePct ?? 0) - (a.dropSharePct ?? 0),
    )
    .slice(0, 8);

  return { volumeTop, growthTop, singogaTop, dropTop };
}

export async function getMarketStats(params: {
  period: StatsPeriod;
  scope: StatsScope;
  date?: string | null;
}): Promise<MarketStatsResponse> {
  const cacheKey = `${params.period}|${params.scope}|${params.date ?? ""}`;
  if (readCache && readCache.key === cacheKey && readCache.expiresAt > Date.now()) {
    return readCache.data;
  }

  if (!hasDb()) {
    return emptyStats(params.period, params.scope, "실거래 DB가 연결되지 않았습니다.");
  }
  await ensureSchema();

  const meta = await loadMeta();
  if (!meta) {
    return emptyStats(
      params.period,
      params.scope,
      "통계 집계가 없습니다. npm run db:stats 로 생성하세요.",
    );
  }

  const asOf = meta.asOfDate;
  const rawDate = (params.date ?? asOf).slice(0, 10);
  const selectedDate = rawDate > asOf ? asOf : rawDate;
  const window = resolvePeriodWindow(selectedDate, params.period, asOf);
  const anchor = window.anchorDate;

  const [days, regionsFull] = await Promise.all([
    loadDailyScope(params.scope, window.chartFrom, window.chartTo),
    loadRegionRange(
      params.scope,
      window.prevFrom < window.curFrom ? window.prevFrom : window.curFrom,
      window.curTo,
    ),
  ]);

  if (days.length === 0) {
    return {
      ...emptyStats(params.period, params.scope, "해당 기간 집계가 없습니다."),
      asOfDate: asOf,
      selectedDate: anchor,
      computedAt: meta.computedAt,
    };
  }

  const series = rollupSeries(days, params.period);
  const kpi = buildKpi(days, anchor, asOf, params.period);
  const rankings = buildRankings(regionsFull, anchor, asOf, params.period);

  // 기본 as-of 스냅샷이 선택 기간과 같으면 캐시 피드, 아니면 on-demand
  const defaultWindow = resolvePeriodWindow(asOf, params.period, asOf);
  const isDefaultSelection =
    window.curFrom === defaultWindow.curFrom &&
    window.curTo === defaultWindow.curTo;

  let feedSnap: StatsDealFeed | null = null;
  if (isDefaultSelection) {
    feedSnap = await readStatsDealFeed(params.period, params.scope);
  }
  if (!feedSnap) {
    try {
      feedSnap = await computeStatsDealFeed(
        asOf,
        params.period,
        params.scope,
        anchor,
      );
    } catch (err) {
      console.warn("[market-stats] on-demand feed compute failed:", err);
    }
  }

  const data: MarketStatsResponse = {
    source: "preagg",
    asOfDate: asOf,
    selectedDate: anchor,
    computedAt: meta.computedAt,
    period: params.period,
    scope: params.scope,
    dateBasisNote: window.reportingLagRisk
      ? "계약일 기준입니다. 최신 계약 기간은 신고 지연으로 거래량이 과소 보일 수 있어, 단순 급락으로 해석하지 마세요."
      : "계약일(deal_date) 기준입니다. 홈의 ‘새로 확인’(discovery_at)과 다른 시간축입니다.",
    complexKeyVersion: MARKET_COMPLEX_KEY_VERSION,
    series,
    kpi,
    rankings,
    feeds: feedSnap
      ? {
          notables: feedSnap.notables,
          singoga: feedSnap.singoga,
          drops: feedSnap.drops,
          activeComplexes: feedSnap.activeComplexes,
          windowLabel: feedSnap.window.windowLabel,
          prevWindowLabel: feedSnap.window.prevWindowLabel,
          windowFrom: feedSnap.window.curFrom,
          windowTo: feedSnap.window.curTo,
        }
      : null,
  };

  readCache = { expiresAt: Date.now() + READ_CACHE_TTL_MS, key: cacheKey, data };
  return data;
}
