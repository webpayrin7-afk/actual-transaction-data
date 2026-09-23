/**
 * 집랩 지역 아파트 랭킹 V4 (read-time scoring over published V3 feature snapshots).
 *
 * 같은 지역·평형대 안에서 각 지표의 백분위를 구해 가중합한다.
 *   가격 수준 50% · 12개월 평당가 중앙값
 *   거래 활발도 20% · 12개월 거래 건수 (log)
 *   단지 규모 20% · 세대수 (log)
 *   회전율 10% · 12개월 거래 ÷ 세대수
 * 자격: 12개월 거래 6건 이상, 거래월 3개월 이상, 세대수 100 이상, 평당가 존재.
 * 데이터 출처 신뢰도와 최근 3개월 거래 증감은 점수에 쓰지 않는다
 * (전자는 품질 표시, 후자는 신고 지연으로 최근 구간이 과소 집계됨).
 */
import type { RankingAreaBandV3, RankingReader } from "./query";

export const RANKING_V4_VERSION = "ziplab-ranking-v4";

export const RANKING_V4_WEIGHTS = { price: 0.5, liquidity: 0.2, size: 0.2, turnover: 0.1 } as const;
export const RANKING_V4_ELIGIBILITY = { minTrades: 6, minActiveMonths: 3, minHouseholds: 100 } as const;

export type RankingV4Row = {
  complexId: string;
  name: string | null;
  dong: string | null;
  buildYear: number | null;
  rank: number;
  regionTotal: number;
  score: number;
  percentiles: { price: number; liquidity: number; size: number; turnover: number };
  metrics: {
    medianPricePerSqm: number;
    medianDealAmount: number | null;
    tradeCount: number;
    households: number;
    turnover: number;
    latestDealDate: string | null;
  };
  confidenceBucket: string | null;
};

export type RankingV4Board = {
  published: boolean;
  regionScope: "gu" | "dong";
  regionCode: string;
  areaBand: RankingAreaBandV3;
  transactionAsOf: string | null;
  featureRunId: string | null;
  candidateTotal: number;
  rows: RankingV4Row[];
};

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; value: RankingV4Board }>();

function scopeOf(regionCode: string): "gu" | "dong" | null {
  if (/^[0-9]{5}$/.test(regionCode)) return "gu";
  if (/^[0-9]{10}$/.test(regionCode)) return "dong";
  return null;
}

/** Mid-rank percentile in [0, 1]. */
function percentileOf(sorted: number[], value: number): number {
  let lo = 0;
  while (lo < sorted.length && sorted[lo]! < value) lo += 1;
  let hi = lo;
  while (hi < sorted.length && sorted[hi] === value) hi += 1;
  return sorted.length ? (lo + hi) / 2 / sorted.length : 0;
}

type Candidate = {
  complexId: string;
  name: string | null;
  dong: string | null;
  buildYear: number | null;
  price: number;
  amount: number | null;
  trades: number;
  activeMonths: number;
  households: number | null;
  latestDealDate: string | null;
  confidence: string | null;
};

export function scoreRankingV4(candidates: Candidate[]): Omit<RankingV4Row, "regionTotal">[] {
  const e = RANKING_V4_ELIGIBILITY;
  const eligible = candidates.filter(
    (c) =>
      c.price > 0 &&
      c.trades >= e.minTrades &&
      c.activeMonths >= e.minActiveMonths &&
      c.households != null &&
      c.households >= e.minHouseholds,
  ) as Array<Candidate & { households: number }>;
  const sortedOf = (fn: (c: Candidate & { households: number }) => number) =>
    eligible.map(fn).sort((a, b) => a - b);
  const prices = sortedOf((c) => c.price);
  const liq = sortedOf((c) => Math.log(c.trades));
  const size = sortedOf((c) => Math.log(c.households));
  const turn = sortedOf((c) => c.trades / c.households);
  const w = RANKING_V4_WEIGHTS;
  return eligible
    .map((c) => {
      const p = {
        price: percentileOf(prices, c.price),
        liquidity: percentileOf(liq, Math.log(c.trades)),
        size: percentileOf(size, Math.log(c.households)),
        turnover: percentileOf(turn, c.trades / c.households),
      };
      const score =
        w.price * p.price + w.liquidity * p.liquidity + w.size * p.size + w.turnover * p.turnover;
      return {
        complexId: c.complexId,
        name: c.name,
        dong: c.dong,
        buildYear: c.buildYear,
        rank: 0,
        score: Math.round(score * 10000) / 10000,
        percentiles: p,
        metrics: {
          medianPricePerSqm: c.price,
          medianDealAmount: c.amount,
          tradeCount: c.trades,
          households: c.households,
          turnover: c.trades / c.households,
          latestDealDate: c.latestDealDate,
        },
        confidenceBucket: c.confidence,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.metrics.medianPricePerSqm - a.metrics.medianPricePerSqm ||
        a.complexId.localeCompare(b.complexId),
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

export async function readRankingV4Board(
  db: RankingReader,
  query: { regionCode: string; areaBand: RankingAreaBandV3; period?: string },
): Promise<RankingV4Board> {
  const regionScope = scopeOf(query.regionCode);
  const period = query.period ?? "12M";
  if (!regionScope) {
    return {
      published: false,
      regionScope: "gu",
      regionCode: query.regionCode,
      areaBand: query.areaBand,
      transactionAsOf: null,
      featureRunId: null,
      candidateTotal: 0,
      rows: [],
    };
  }
  const pub = await db.execute({
    sql: `SELECT feature_run_id, transaction_as_of FROM region_ranking_publications
          WHERE region_scope = ? AND region_code = ? AND area_band = ? AND period = ?`,
    args: [regionScope, query.regionCode, query.areaBand, period],
  });
  const pointer = pub.rows[0];
  const featureRunId = pointer?.feature_run_id == null ? null : String(pointer.feature_run_id);
  const empty: RankingV4Board = {
    published: false,
    regionScope,
    regionCode: query.regionCode,
    areaBand: query.areaBand,
    transactionAsOf: pointer ? String(pointer.transaction_as_of) : null,
    featureRunId,
    candidateTotal: 0,
    rows: [],
  };
  if (!featureRunId) return empty;

  const key = `${featureRunId}|${regionScope}|${query.regionCode}|${query.areaBand}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const lawd = query.regionCode.slice(0, 5);
  const bjdong = regionScope === "dong" ? query.regionCode.slice(5) : null;
  const result = await db.execute({
    sql: `WITH uh AS (
            SELECT u.complex_id, SUM(u.household_count) AS h
            FROM unit_type_household_counts u
            JOIN apt_complex_master mm ON mm.complex_id = u.complex_id
            WHERE mm.lawd_cd = ? AND u.household_count IS NOT NULL
            GROUP BY u.complex_id
          )
          SELECT f.complex_id, f.median_price_per_sqm, f.median_deal_amount, f.trade_count,
                 COALESCE(f.household_count, uh.h) AS households,
                 f.active_month_count, f.latest_deal_date, f.profile_confidence,
                 m.apt_name, m.apt_name_norm, m.legal_dong_name, p.approval_date
          FROM ranking_feature_snapshots f
          LEFT JOIN apt_complex_master m ON m.complex_id = f.complex_id
          LEFT JOIN apt_complex_profile p ON p.complex_id = f.complex_id
          LEFT JOIN uh ON uh.complex_id = f.complex_id
          WHERE f.feature_run_id = ? AND f.lawd_cd = ? AND f.area_band = ?
            AND f.eligible_input = 1
            ${bjdong ? "AND f.bjdong_cd = ?" : ""}`,
    args: bjdong
      ? [lawd, featureRunId, lawd, query.areaBand, bjdong]
      : [lawd, featureRunId, lawd, query.areaBand],
  });

  const candidates: Candidate[] = result.rows.map((row) => {
    const approval = row.approval_date == null ? null : String(row.approval_date);
    const year = approval ? /^(\d{4})/.exec(approval)?.[1] : null;
    return {
      complexId: String(row.complex_id),
      name:
        row.apt_name != null
          ? String(row.apt_name)
          : row.apt_name_norm != null
            ? String(row.apt_name_norm)
            : null,
      dong: row.legal_dong_name == null ? null : String(row.legal_dong_name),
      buildYear: year ? Number(year) : null,
      price: row.median_price_per_sqm == null ? 0 : Number(row.median_price_per_sqm),
      amount: row.median_deal_amount == null ? null : Number(row.median_deal_amount),
      trades: Number(row.trade_count ?? 0),
      activeMonths: Number(row.active_month_count ?? 0),
      households: row.households == null ? null : Number(row.households),
      latestDealDate: row.latest_deal_date == null ? null : String(row.latest_deal_date),
      confidence: row.profile_confidence == null ? null : String(row.profile_confidence),
    };
  });
  const scored = scoreRankingV4(candidates);
  const value: RankingV4Board = {
    ...empty,
    published: true,
    candidateTotal: candidates.length,
    rows: scored.map((row) => ({ ...row, regionTotal: scored.length })),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}
