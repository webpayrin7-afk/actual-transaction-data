import "server-only";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db/client";
import { seoulToday } from "@/lib/market/time";
import {
  fetchRoneSeries,
  fetchRoneSeriesMany,
  type RonePoint,
} from "@/lib/market/rone";
import {
  trendRegionById,
  trendRegionsOf,
  type TrendRegion,
  type TrendRegionGroup,
} from "@/lib/market/trends-regions";

/** 월 1회 갱신되는 원자료 — 결과를 6시간 캐시 (Next Data Cache). */
const TRENDS_REVALIDATE_SECONDS = 21_600;
/** 신고 기한: 계약 후 30일. 이 기한이 지나지 않은 달은 거래량이 덜 집계돼 제외한다. */
const REPORTING_LAG_DAYS = 30;

export type TrendPoint = { ym: string; value: number };

export type TrendVolumePoint = { ym: string; count: number };

export type TrendSeries = {
  status: "ok";
  regionId: string;
  tradeIndex: TrendPoint[] | null;
  jeonseIndex: TrendPoint[] | null;
  medianTradePrice: TrendPoint[] | null;
  jeonseRatio: TrendPoint[] | null;
  volume: {
    points: TrendVolumePoint[];
    /** 모든 하위 시도가 수집된 첫 달 */
    from: string | null;
    /** 신고 기한이 지난 마지막 달 */
    to: string | null;
    note?: string;
  } | null;
  computedAt: string;
};

export type TrendRankRow = {
  regionId: string;
  label: string;
  latestYm: string;
  latest: number;
  change: Record<"1y" | "3y" | "5y" | "10y", number | null>;
  peakYm: string;
  /** 전고점 대비 현재 (%) — 0이면 현재가 최고점 */
  fromPeak: number;
};

export type TrendRanking = {
  status: "ok";
  group: TrendRegionGroup;
  latestYm: string | null;
  rows: TrendRankRow[];
  missing: number;
  computedAt: string;
};

function ymIndex(ym: string): number {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1;
}

function ymFromIndex(i: number): string {
  return `${Math.floor(i / 12)}${String((i % 12) + 1).padStart(2, "0")}`;
}

/** 오늘(서울) 기준 신고 기한이 지난 마지막 계약월. */
export function lastCompleteVolumeMonth(today = seoulToday()): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const cutoff = new Date(Date.UTC(y, m - 1, d) - REPORTING_LAG_DAYS * 86_400_000);
  // cutoff 날짜가 속한 달의 전달까지는 말일 + 30일이 지났다.
  return ymFromIndex(cutoff.getUTCFullYear() * 12 + cutoff.getUTCMonth() - 1);
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

async function safeRone(p: Promise<RonePoint[]>): Promise<TrendPoint[] | null> {
  try {
    const rows = await p;
    return rows.length ? rows : null;
  } catch (error) {
    console.warn("[trends] rone", error instanceof Error ? error.message : error);
    return null;
  }
}

async function readVolume(region: TrendRegion): Promise<TrendSeries["volume"]> {
  if (!region.lawdRanges) {
    return { points: [], from: null, to: null, note: region.volumeNote };
  }
  const db = getDb();
  if (!db) return null;
  const where = region.lawdRanges.map(() => "(lawd_cd >= ? AND lawd_cd <= ?)").join(" OR ");
  // sync_months: (lawd_cd, year_month, deal_kind) PK — 시군구·계약월별 적재 건수.
  // transactions를 직접 세면 수백만 행 스캔(서울만 25초)이라 적재 건수를 쓴다.
  const res = await db.execute({
    sql: `SELECT substr(lawd_cd, 1, 2) AS sido, year_month AS ym, SUM(row_count) AS n
          FROM sync_months
          WHERE deal_kind = 'trade' AND (${where})
          GROUP BY sido, ym`,
    args: region.lawdRanges.flat(),
  });
  const to = lastCompleteVolumeMonth();
  const firstBySido = new Map<string, string>();
  const byMonth = new Map<string, number>();
  for (const row of res.rows) {
    const sido = String(row.sido);
    const ym = String(row.ym);
    const n = Number(row.n) || 0;
    const prev = firstBySido.get(sido);
    if (!prev || ym < prev) firstBySido.set(sido, ym);
    byMonth.set(ym, (byMonth.get(ym) ?? 0) + n);
  }
  if (!firstBySido.size) return { points: [], from: null, to: null };
  const from = [...firstBySido.values()].sort().at(-1)!;
  const points: TrendVolumePoint[] = [];
  for (let i = ymIndex(from); i <= ymIndex(to); i++) {
    const ym = ymFromIndex(i);
    points.push({ ym, count: byMonth.get(ym) ?? 0 });
  }
  return { points, from, to };
}

async function computeTrendSeries(region: TrendRegion): Promise<TrendSeries> {
  const [tradeIndex, jeonseIndex, medianTradePrice, jeonseRatio, volume] = await Promise.all([
    safeRone(fetchRoneSeries("tradeIndex", region.clsId)),
    safeRone(fetchRoneSeries("jeonseIndex", region.clsId)),
    safeRone(fetchRoneSeries("medianTradePrice", region.clsId)),
    safeRone(fetchRoneSeries("jeonseRatio", region.clsId)),
    readVolume(region).catch((error) => {
      console.error("[trends] volume", error);
      return null;
    }),
  ]);
  // 원천 장애 결과를 캐시에 남기지 않도록 전부 실패하면 던진다.
  if (!tradeIndex && !jeonseIndex && !medianTradePrice && !jeonseRatio) {
    throw new Error("R-ONE unavailable");
  }
  return {
    status: "ok",
    regionId: region.id,
    tradeIndex: tradeIndex?.map((p) => ({ ym: p.ym, value: round(p.value, 2) })) ?? null,
    jeonseIndex: jeonseIndex?.map((p) => ({ ym: p.ym, value: round(p.value, 2) })) ?? null,
    // 천원 → 만원
    medianTradePrice: medianTradePrice?.map((p) => ({ ym: p.ym, value: Math.round(p.value / 10) })) ?? null,
    jeonseRatio: jeonseRatio?.map((p) => ({ ym: p.ym, value: round(p.value, 1) })) ?? null,
    volume,
    computedAt: new Date().toISOString(),
  };
}

const cachedTrendSeries = unstable_cache(
  // volumeTo는 키 용도: 달이 바뀌면 새로 계산한다.
  async (regionId: string, volumeTo: string) => {
    void volumeTo;
    const region = trendRegionById(regionId);
    if (!region) throw new Error(`unknown region ${regionId}`);
    return computeTrendSeries(region);
  },
  ["market-trends-series-v1"],
  { revalidate: TRENDS_REVALIDATE_SECONDS, tags: ["market-trends"] },
);

export async function getTrendSeries(region: TrendRegion): Promise<TrendSeries> {
  return cachedTrendSeries(region.id, lastCompleteVolumeMonth());
}

function pctChange(now: number, base: number | undefined): number | null {
  if (base == null || base <= 0) return null;
  return round((now / base - 1) * 100, 1);
}

export function rankRowFromSeries(region: TrendRegion, series: RonePoint[]): TrendRankRow | null {
  if (!series.length) return null;
  const last = series.at(-1)!;
  const byYm = new Map(series.map((p) => [p.ym, p.value]));
  const back = (years: number) => byYm.get(ymFromIndex(ymIndex(last.ym) - years * 12));
  let peak = series[0]!;
  for (const p of series) if (p.value >= peak.value) peak = p;
  return {
    regionId: region.id,
    label: region.label,
    latestYm: last.ym,
    latest: round(last.value, 2),
    change: {
      "1y": pctChange(last.value, back(1)),
      "3y": pctChange(last.value, back(3)),
      "5y": pctChange(last.value, back(5)),
      "10y": pctChange(last.value, back(10)),
    },
    peakYm: peak.ym,
    fromPeak: round((last.value / peak.value - 1) * 100, 1),
  };
}

async function computeRanking(group: TrendRegionGroup): Promise<TrendRanking> {
  const regions = trendRegionsOf(group);
  const series = await fetchRoneSeriesMany(
    "tradeIndex",
    regions.map((r) => r.clsId),
  );
  const rows: TrendRankRow[] = [];
  let missing = 0;
  for (const r of regions) {
    const s = series.get(r.clsId);
    const row = s ? rankRowFromSeries(r, s) : null;
    if (row) rows.push(row);
    else missing++;
  }
  if (!rows.length) throw new Error("ranking unavailable");
  const latestYm = rows.map((r) => r.latestYm).sort().at(-1) ?? null;
  return { status: "ok", group, latestYm, rows, missing, computedAt: new Date().toISOString() };
}

const cachedRanking = unstable_cache(
  async (group: TrendRegionGroup) => computeRanking(group),
  ["market-trends-ranking-v1"],
  { revalidate: TRENDS_REVALIDATE_SECONDS, tags: ["market-trends"] },
);

export async function getTrendRanking(group: TrendRegionGroup): Promise<TrendRanking> {
  return cachedRanking(group);
}
