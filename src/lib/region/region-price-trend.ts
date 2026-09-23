/**
 * 구 단위 월별 평당 중위가 + 거래량 (read-only).
 * 시장 현황 `평당 중위가`와 같은 정의: 계약월 매매 거래의 거래금액 ÷ 전용 평(0.1평 반올림) 중앙값.
 */
import type { RankingReader } from "@/lib/region-ranking/query";

export type RegionPriceTrendPoint = {
  yearMonth: string;
  medianPyeongPrice: number;
  tradeCount: number;
};

export type RegionPriceTrend = {
  status: "ok";
  lawdCd: string;
  points: RegionPriceTrendPoint[];
};

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: RegionPriceTrend }>();

export async function readRegionPriceTrend(
  db: RankingReader,
  lawdCd: string,
): Promise<RegionPriceTrend> {
  const hit = cache.get(lawdCd);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

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

  const points: RegionPriceTrendPoint[] = result.rows
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
    );

  const value: RegionPriceTrend = { status: "ok", lawdCd, points };
  cache.set(lawdCd, { at: Date.now(), value });
  return value;
}
