/**
 * 구(또는 법정동) 단위 월 상세 · 거래현황 · 지역 분석 (read-only, 매매 실거래).
 *
 * 거래 방향: 같은 단지·동·전용면적(㎡ 반올림)의 직전 거래 대비
 *   상승 / 하락 / 기타(동일가 또는 직전 거래 없음).
 * 신고가: 같은 단지·동·전용면적의 종전 최고가를 넘는 거래.
 * 최고가 대비 하락: 종전 최고가보다 10% 이상 낮은 거래.
 */
import type { RankingReader } from "@/lib/region-ranking/query";
import { seoulToday } from "@/lib/market/time";
import { regionScopeKey } from "@/lib/region/region-scope";

export type TradeDirection = "up" | "down" | "other";
export type DirectionCounts = Record<TradeDirection, number>;

export type RegionMonthBreakdownRow = { key: string; label: string } & DirectionCounts;

export type RegionMonthDetail = {
  direction: DirectionCounts;
  /** 구 범위: 법정동별. 동 범위에서는 빈 배열. */
  byDong: RegionMonthBreakdownRow[];
  /** 동 범위에서만: 단지별. */
  byComplex?: RegionMonthBreakdownRow[];
  byArea: RegionMonthBreakdownRow[];
};

export type RegionHighlightDeal = {
  aptName: string;
  dong: string;
  exclusiveArea: number;
  floor: number | null;
  dealDate: string;
  dealAmount: number;
  diff: number | null;
};

export type RegionMarketDetail = {
  status: "ok";
  lawdCd: string;
  /** 동 범위일 때만 존재. */
  dong?: string;
  months: Record<string, RegionMonthDetail>;
  highlights: {
    windowStart: string;
    windowEnd: string;
    topAmount: RegionHighlightDeal | null;
    biggestRise: RegionHighlightDeal | null;
    biggestDrop: RegionHighlightDeal | null;
  };
  analysis: {
    windowStart: string;
    windowEnd: string;
    tradeCount: number;
    recordHighCount: number;
    belowPeakCount: number;
    downCount: number;
  };
};

export const AREA_BANDS = [
  { key: "b1", label: "60㎡ 이하" },
  { key: "b2", label: "60~85㎡" },
  { key: "b3", label: "85~135㎡" },
  { key: "b4", label: "135㎡ 초과" },
] as const;

const DETAIL_MONTHS = 60;
const LOOKBACK_MONTHS = 72;
const HIGHLIGHT_DAYS = 30;
const ANALYSIS_MONTHS = 3;
const BELOW_PEAK_RATIO = 0.9;
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: RegionMarketDetail }>();

function shiftYm(ym: string, months: number): string {
  const idx = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1 + months;
  return `${Math.floor(idx / 12)}${String((idx % 12) + 1).padStart(2, "0")}`;
}

function shiftDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function shiftMonthsDay(day: string, months: number): string {
  const ym = shiftYm(day.slice(0, 7).replace("-", ""), months);
  return `${ym.slice(0, 4)}-${ym.slice(4, 6)}-${day.slice(8, 10) > "28" ? "28" : day.slice(8, 10)}`;
}

function emptyCounts(): DirectionCounts {
  return { up: 0, down: 0, other: 0 };
}

function breakdownRows(
  map: Map<string, DirectionCounts>,
  labelOf: (key: string) => string,
): RegionMonthBreakdownRow[] {
  return [...map.entries()]
    .map(([key, c]) => ({ key, label: labelOf(key), ...c }))
    .sort((a, b) => b.up + b.down + b.other - (a.up + a.down + a.other));
}

const TRADES_CTE = `
  t AS (
    SELECT id, apt_name, apt_name_norm AS n, dong,
           CAST(exclusive_area AS REAL) AS ea,
           ROUND(CAST(exclusive_area AS REAL), 0) AS ar,
           deal_date AS d, year_month AS ym,
           CAST(deal_amount AS REAL) AS a,
           floor
    FROM transactions
    WHERE lawd_cd = ? AND deal_type = 'trade' AND year_month >= ?
      AND CAST(deal_amount AS REAL) > 0 AND CAST(exclusive_area AS REAL) > 0
  )`;

/**
 * 동 범위: 구와 같은 인덱스 범위(lawd_cd, year_month, deal_type='trade')에서 dong만 거른다.
 * 매매만 읽으므로 전월세가 많은 동도 행 수가 구 매매 건수를 넘지 않고, 구 페이지와 같은
 * 페이지를 읽어 캐시를 공유한다. 창 함수의 PARTITION BY(n, dong, ar)는 동 안에서 닫히므로
 * 결과는 구 결과를 동으로 거른 것과 같다.
 */
const DONG_TRADES_CTE = TRADES_CTE.replace(
  "WHERE lawd_cd = ? AND deal_type = 'trade' AND year_month >= ?",
  "WHERE lawd_cd = ? AND deal_type = 'trade' AND year_month >= ? AND dong = ?",
);

export async function readRegionMarketDetail(
  db: RankingReader,
  lawdCd: string,
  dong?: string | null,
): Promise<RegionMarketDetail> {
  const cacheKey = regionScopeKey({ lawdCd, dong });
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const today = seoulToday();
  const currentYm = today.slice(0, 7).replace("-", "");
  const lookbackYm = shiftYm(currentYm, -LOOKBACK_MONTHS);
  const detailYm = shiftYm(currentYm, -(DETAIL_MONTHS - 1));
  const analysisStart = shiftMonthsDay(today, -ANALYSIS_MONTHS);
  const highlightStart = shiftDays(today, -(HIGHLIGHT_DAYS - 1));

  const tradesCte = dong ? DONG_TRADES_CTE : TRADES_CTE;
  /** 구: 동별 구성, 동: 단지별 구성. */
  const groupCol = dong ? "apt_name" : "dong";
  const scopeArgs = dong ? [lawdCd, lookbackYm, dong] : [lawdCd, lookbackYm];

  const [agg, recent] = await Promise.all([
    db.execute({
      sql: `WITH ${tradesCte},
            w AS MATERIALIZED (
              SELECT ym, ${groupCol}, ea, a,
                     LAG(a) OVER (PARTITION BY n, dong, ar ORDER BY d, id) AS prev
              FROM t
            ),
            x AS MATERIALIZED (
              SELECT ym, ${groupCol},
                     CASE WHEN ea <= 60 THEN 'b1' WHEN ea <= 85 THEN 'b2'
                          WHEN ea <= 135 THEN 'b3' ELSE 'b4' END AS band,
                     CASE WHEN prev IS NULL OR a = prev THEN 'other'
                          WHEN a > prev THEN 'up' ELSE 'down' END AS dir
              FROM w WHERE ym >= ?
            )
            SELECT 'dong' AS kind, ym, ${groupCol} AS k, dir, COUNT(*) AS c
            FROM x GROUP BY ym, ${groupCol}, dir
            UNION ALL
            SELECT 'band', ym, band, dir, COUNT(*) FROM x GROUP BY ym, band, dir`,
      args: [...scopeArgs, detailYm],
    }),
    db.execute({
      sql: `WITH ${tradesCte},
            w AS MATERIALIZED (
              SELECT apt_name, dong, ea, floor, d, a,
                     LAG(a) OVER (PARTITION BY n, dong, ar ORDER BY d, id) AS prev,
                     MAX(a) OVER (
                       PARTITION BY n, dong, ar ORDER BY d, id
                       ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                     ) AS pmax
              FROM t
            )
            SELECT apt_name, dong, ea, floor, d, a, prev, pmax
            FROM w WHERE d >= ? AND d <= ?`,
      args: [...scopeArgs, analysisStart, today],
    }),
  ]);

  const monthMaps = new Map<
    string,
    { dir: DirectionCounts; dong: Map<string, DirectionCounts>; band: Map<string, DirectionCounts> }
  >();
  for (const row of agg.rows) {
    const ym = String(row.ym);
    const dir = String(row.dir) as TradeDirection;
    const c = Number(row.c);
    let m = monthMaps.get(ym);
    if (!m) {
      m = { dir: emptyCounts(), dong: new Map(), band: new Map() };
      monthMaps.set(ym, m);
    }
    const target = String(row.kind) === "dong" ? m.dong : m.band;
    const key = String(row.k ?? "") || "기타";
    const counts = target.get(key) ?? emptyCounts();
    counts[dir] += c;
    target.set(key, counts);
    if (String(row.kind) === "band") m.dir[dir] += c;
  }
  const bandLabel = (key: string) => AREA_BANDS.find((b) => b.key === key)?.label ?? key;
  const months: Record<string, RegionMonthDetail> = {};
  for (const [ym, m] of monthMaps) {
    const groups = breakdownRows(m.dong, (k) => k);
    months[ym] = {
      direction: m.dir,
      byDong: dong ? [] : groups,
      ...(dong ? { byComplex: groups } : {}),
      byArea: AREA_BANDS.filter((b) => m.band.has(b.key)).map((b) => ({
        key: b.key,
        label: bandLabel(b.key),
        ...m.band.get(b.key)!,
      })),
    };
  }

  const toDeal = (row: (typeof recent.rows)[number], diff: number | null): RegionHighlightDeal => ({
    aptName: String(row.apt_name ?? ""),
    dong: String(row.dong ?? ""),
    exclusiveArea: Number(row.ea),
    floor: row.floor == null ? null : Number(row.floor),
    dealDate: String(row.d),
    dealAmount: Number(row.a),
    diff,
  });

  let topAmount: RegionHighlightDeal | null = null;
  let biggestRise: RegionHighlightDeal | null = null;
  let biggestDrop: RegionHighlightDeal | null = null;
  let recordHighCount = 0;
  let belowPeakCount = 0;
  let downCount = 0;
  for (const row of recent.rows) {
    const a = Number(row.a);
    const prev = row.prev == null ? null : Number(row.prev);
    const pmax = row.pmax == null ? null : Number(row.pmax);
    const diff = prev != null ? a - prev : null;
    if (pmax != null && a > pmax) recordHighCount += 1;
    if (pmax != null && a < pmax * BELOW_PEAK_RATIO) belowPeakCount += 1;
    if (diff != null && diff < 0) downCount += 1;
    if (String(row.d) < highlightStart) continue;
    if (!topAmount || a > topAmount.dealAmount) topAmount = toDeal(row, diff);
    if (diff != null && diff > 0 && (!biggestRise || diff > (biggestRise.diff ?? 0))) {
      biggestRise = toDeal(row, diff);
    }
    if (diff != null && diff < 0 && (!biggestDrop || diff < (biggestDrop.diff ?? 0))) {
      biggestDrop = toDeal(row, diff);
    }
  }

  const value: RegionMarketDetail = {
    status: "ok",
    lawdCd,
    ...(dong ? { dong } : {}),
    months,
    highlights: { windowStart: highlightStart, windowEnd: today, topAmount, biggestRise, biggestDrop },
    analysis: {
      windowStart: analysisStart,
      windowEnd: today,
      tradeCount: recent.rows.length,
      recordHighCount,
      belowPeakCount,
      downCount,
    },
  };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}
