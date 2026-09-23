/**
 * 구 단위 지역 평당가 (read-only, 전용면적 기준).
 * 시장 현황 `평당 중위가`와 같은 정의: 매매 거래의 거래금액 ÷ 전용 평(0.1평 반올림) 중앙값.
 * - points: 계약월별 값 + 거래량
 * - recent: 최근 30일 계약 구간 값과, 같은 구간의 6개월·1년·2년·5년 전 대비 변화율
 */
import type { RankingReader } from "@/lib/region-ranking/query";
import { seoulToday } from "@/lib/market/time";

export type RegionPriceTrendPoint = {
  yearMonth: string;
  medianPyeongPrice: number;
  tradeCount: number;
  /** 최근 3개월(해당 월 포함) 월별 중앙값의 거래건수 가중 평균. 표시용 완화값. */
  smoothedPyeongPrice: number;
};

const SMOOTH_MONTHS = 3;

function monthIndex(ym: string): number {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1;
}

function withSmoothing(
  raw: Array<Omit<RegionPriceTrendPoint, "smoothedPyeongPrice">>,
): RegionPriceTrendPoint[] {
  return raw.map((point, index) => {
    const idx = monthIndex(point.yearMonth);
    let weighted = 0;
    let count = 0;
    for (let i = index; i >= 0; i -= 1) {
      const p = raw[i]!;
      if (idx - monthIndex(p.yearMonth) >= SMOOTH_MONTHS) break;
      weighted += p.medianPyeongPrice * p.tradeCount;
      count += p.tradeCount;
    }
    return {
      ...point,
      smoothedPyeongPrice:
        count > 0 ? Math.round(weighted / count) : point.medianPyeongPrice,
    };
  });
}

export type RegionRecentPriceWindow = {
  start: string;
  end: string;
  medianPyeongPrice: number | null;
  tradeCount: number;
};

export type RegionRecentPrice = {
  current: RegionRecentPriceWindow;
  changes: Record<"6M" | "1Y" | "2Y" | "5Y", number | null>;
};

export type RegionPriceTrend = {
  status: "ok";
  lawdCd: string;
  points: RegionPriceTrendPoint[];
  recent: RegionRecentPrice;
};

const RECENT_WINDOW_DAYS = 30;
const CHANGE_MONTHS = { "6M": 6, "1Y": 12, "2Y": 24, "5Y": 60 } as const;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shiftDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
}

function shiftMonths(day: string, months: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return isoDay(target);
}

async function windowMedian(
  db: RankingReader,
  lawdCd: string,
  start: string,
  end: string,
): Promise<RegionRecentPriceWindow> {
  const result = await db.execute({
    sql: `WITH p AS (
            SELECT ROUND(CAST(deal_amount AS REAL)
                         / ROUND(CAST(exclusive_area AS REAL) / 3.3058, 1)) AS v
            FROM transactions
            WHERE lawd_cd = ? AND deal_type = 'trade'
              AND year_month BETWEEN ? AND ?
              AND deal_date BETWEEN ? AND ?
              AND CAST(deal_amount AS REAL) > 0
              AND CAST(exclusive_area AS REAL) > 0
          ), r AS (
            SELECT v, ROW_NUMBER() OVER (ORDER BY v) AS rn, COUNT(*) OVER () AS c
            FROM p
          )
          SELECT MAX(c) AS c, ROUND(AVG(v)) AS med
          FROM r
          WHERE rn IN ((c + 1) / 2, (c + 2) / 2)`,
    args: [
      lawdCd,
      start.slice(0, 7).replace("-", ""),
      end.slice(0, 7).replace("-", ""),
      start,
      end,
    ],
  });
  const row = result.rows[0];
  const med = row?.med == null ? null : Number(row.med);
  return {
    start,
    end,
    medianPyeongPrice: med != null && Number.isFinite(med) && med > 0 ? med : null,
    tradeCount: row?.c == null ? 0 : Number(row.c),
  };
}

async function readRecentPrice(
  db: RankingReader,
  lawdCd: string,
  today: string,
): Promise<RegionRecentPrice> {
  const end = today;
  const start = shiftDays(end, -(RECENT_WINDOW_DAYS - 1));
  const entries = Object.entries(CHANGE_MONTHS) as Array<
    [keyof typeof CHANGE_MONTHS, number]
  >;
  const [current, ...past] = await Promise.all([
    windowMedian(db, lawdCd, start, end),
    ...entries.map(([, months]) =>
      windowMedian(db, lawdCd, shiftMonths(start, months), shiftMonths(end, months)),
    ),
  ]);
  const changes = {} as RegionRecentPrice["changes"];
  entries.forEach(([key], index) => {
    const base = past[index]?.medianPyeongPrice ?? null;
    changes[key] =
      current.medianPyeongPrice != null && base != null && base > 0
        ? Math.round(((current.medianPyeongPrice - base) / base) * 10000) / 100
        : null;
  });
  return { current, changes };
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: RegionPriceTrend }>();

export async function readRegionPriceTrend(
  db: RankingReader,
  lawdCd: string,
): Promise<RegionPriceTrend> {
  const hit = cache.get(lawdCd);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const recentPromise = readRecentPrice(db, lawdCd, seoulToday());
  const result = await db.execute({
    sql: `WITH p AS (
            SELECT year_month AS ym,
                   ROUND(CAST(deal_amount AS REAL)
                         / ROUND(CAST(exclusive_area AS REAL) / 3.3058, 1)) AS v
            FROM transactions
            WHERE lawd_cd = ? AND deal_type = 'trade'
              AND CAST(deal_amount AS REAL) > 0
              AND CAST(exclusive_area AS REAL) > 0
          ), r AS (
            SELECT ym, v,
                   ROW_NUMBER() OVER (PARTITION BY ym ORDER BY v) AS rn,
                   COUNT(*) OVER (PARTITION BY ym) AS c
            FROM p
          )
          SELECT ym, MAX(c) AS c, ROUND(AVG(v)) AS med
          FROM r
          WHERE rn IN ((c + 1) / 2, (c + 2) / 2)
          GROUP BY ym
          ORDER BY ym`,
    args: [lawdCd],
  });

  const points = withSmoothing(
    result.rows
      .map((row) => ({
        yearMonth: String(row.ym),
        medianPyeongPrice: Number(row.med),
        tradeCount: Number(row.c),
      }))
      .filter(
        (p) =>
          /^\d{6}$/.test(p.yearMonth) &&
          Number.isFinite(p.medianPyeongPrice) &&
          p.medianPyeongPrice > 0,
      ),
  );

  const value: RegionPriceTrend = {
    status: "ok",
    lawdCd,
    points,
    recent: await recentPromise,
  };
  cache.set(lawdCd, { at: Date.now(), value });
  return value;
}
