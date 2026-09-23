/**
 * 구 단위 지역 평당가 (read-only, 공급면적 기준).
 *
 * 매매 실거래의 거래금액 ÷ 공급 평형 라벨(정수)의 중앙값. 평형 라벨은 단지 상세 V3와 같은 규칙:
 * 단지·전용면적별 canonical 공급면적이 하나로 확정(EXACT_SINGLE)되거나, 후보가 여러 개여도
 * 정수 평형이 모두 같을 때만 사용한다. 평형을 정할 수 없는 거래는 평당가에서 제외하고 거래량에만 센다.
 *
 * - points: 계약월별 값 + 거래량
 * - recent: 최근 30일 계약 구간 값과, 같은 구간의 6개월·1년·2년·5년 전 대비 변화율
 */
import type { RankingReader } from "@/lib/region-ranking/query";
import { seoulToday } from "@/lib/market/time";

export type RegionPriceTrendPoint = {
  yearMonth: string;
  /** 공급 평형 기준 중앙값. 평형 확인 거래가 없으면 null. */
  medianPyeongPrice: number | null;
  /** 전체 매매 거래 수 (평형 미확인 포함). */
  tradeCount: number;
  /** 평당가 계산에 쓴 거래 수. */
  priceSampleCount: number;
  /** 최근 3개월(해당 월 포함) 월별 중앙값의 표본 수 가중 평균. 표시용 완화값. */
  smoothedPyeongPrice: number | null;
};

export type RegionRecentPriceWindow = {
  start: string;
  end: string;
  medianPyeongPrice: number | null;
  tradeCount: number;
  priceSampleCount: number;
};

export type RegionRecentPrice = {
  current: RegionRecentPriceWindow;
  changes: Record<"6M" | "1Y" | "2Y" | "5Y", number | null>;
};

export type RegionPriceTrend = {
  status: "ok";
  lawdCd: string;
  basis: "SUPPLY_PYEONG_LABEL";
  points: RegionPriceTrendPoint[];
  recent: RegionRecentPrice;
};

const SUPPLY_PYEONG_FACTOR = 3.305785;
const SMOOTH_MONTHS = 3;
const RECENT_WINDOW_DAYS = 30;
const CHANGE_MONTHS = { "6M": 6, "1Y": 12, "2Y": 24, "5Y": 60 } as const;
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: RegionPriceTrend }>();

/** Trades in one 구 with the V3 supply-pyeong label when resolvable (`label` null otherwise). */
const SUPPLY_TRADES_CTE = `
  cu AS (
    SELECT c.complex_id, c.exclusive_cents, c.status,
           ROUND(ROUND(c.supply_area / ${SUPPLY_PYEONG_FACTOR}, 2)) AS lbl
    FROM apt_canonical_unit_types c
    JOIN apt_complex_master mm ON mm.complex_id = c.complex_id
    WHERE mm.lawd_cd = ? AND c.supply_cents >= 0 AND c.supply_area > 0
      AND c.status IN ('EXACT_SINGLE', 'AMBIGUOUS_MULTI')
  ),
  ul AS (
    SELECT complex_id, exclusive_cents,
           CASE
             WHEN SUM(status = 'EXACT_SINGLE') = 1
               THEN MAX(CASE WHEN status = 'EXACT_SINGLE' THEN lbl END)
             WHEN MIN(lbl) = MAX(lbl) THEN MIN(lbl)
           END AS label
    FROM cu GROUP BY complex_id, exclusive_cents
  ),
  st AS (
    SELECT t.year_month AS ym, t.deal_date AS d,
           CAST(t.deal_amount AS REAL) AS a, ul.label AS label
    FROM transactions t
    LEFT JOIN apt_complex_master m
      ON m.lawd_cd = t.lawd_cd AND m.apt_name_norm = t.apt_name_norm
     AND m.legal_dong_name = t.dong
    LEFT JOIN ul ON ul.complex_id = m.complex_id
     AND ul.exclusive_cents = CAST(ROUND(CAST(t.exclusive_area AS REAL) * 100) AS INTEGER)
    WHERE t.lawd_cd = ? AND t.deal_type = 'trade'
      AND CAST(t.deal_amount AS REAL) > 0 AND CAST(t.exclusive_area AS REAL) > 0
      __EXTRA__
  )`;

function monthIndex(ym: string): number {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
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
      if (p.medianPyeongPrice == null) continue;
      weighted += p.medianPyeongPrice * p.priceSampleCount;
      count += p.priceSampleCount;
    }
    return {
      ...point,
      smoothedPyeongPrice: count > 0 ? Math.round(weighted / count) : null,
    };
  });
}

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

async function readRecentPrice(
  db: RankingReader,
  lawdCd: string,
  today: string,
): Promise<RegionRecentPrice> {
  const end = today;
  const start = shiftDays(end, -(RECENT_WINDOW_DAYS - 1));
  const entries = Object.entries(CHANGE_MONTHS) as Array<[keyof typeof CHANGE_MONTHS, number]>;
  const windows = [
    { start, end },
    ...entries.map(([, months]) => ({
      start: shiftMonths(start, months),
      end: shiftMonths(end, months),
    })),
  ];
  const range = windows.map(() => "(d BETWEEN ? AND ?)").join(" OR ");
  const result = await db.execute({
    sql: `WITH ${SUPPLY_TRADES_CTE.replace(
      "__EXTRA__",
      `AND t.year_month IN (${windows
        .flatMap((w) => {
          const out: string[] = [];
          for (let m = monthIndex(w.start.slice(0, 7).replace("-", "")); m <= monthIndex(w.end.slice(0, 7).replace("-", "")); m += 1) {
            out.push(`'${Math.floor(m / 12)}${String((m % 12) + 1).padStart(2, "0")}'`);
          }
          return out;
        })
        .join(",")})`,
    )}
          SELECT d, a, label FROM st WHERE ${range}`,
    args: [lawdCd, lawdCd, ...windows.flatMap((w) => [w.start, w.end])],
  });

  const stats = windows.map((w) => {
    const rows = result.rows.filter((r) => String(r.d) >= w.start && String(r.d) <= w.end);
    const prices = rows
      .filter((r) => r.label != null && Number(r.label) > 0)
      .map((r) => Number(r.a) / Number(r.label));
    return {
      start: w.start,
      end: w.end,
      medianPyeongPrice: median(prices),
      tradeCount: rows.length,
      priceSampleCount: prices.length,
    };
  });
  const [current, ...past] = stats;
  const changes = {} as RegionRecentPrice["changes"];
  entries.forEach(([key], index) => {
    const base = past[index]?.medianPyeongPrice ?? null;
    changes[key] =
      current!.medianPyeongPrice != null && base != null && base > 0
        ? Math.round(((current!.medianPyeongPrice - base) / base) * 10000) / 100
        : null;
  });
  return { current: current!, changes };
}

export async function readRegionPriceTrend(
  db: RankingReader,
  lawdCd: string,
): Promise<RegionPriceTrend> {
  const hit = cache.get(lawdCd);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const recentPromise = readRecentPrice(db, lawdCd, seoulToday());
  const result = await db.execute({
    sql: `WITH ${SUPPLY_TRADES_CTE.replace("__EXTRA__", "")},
          stm AS MATERIALIZED (SELECT ym, a, label FROM st),
          p AS (SELECT ym, ROUND(a / label) AS v FROM stm WHERE label > 0),
          r AS (
            SELECT ym, v,
                   ROW_NUMBER() OVER (PARTITION BY ym ORDER BY v) AS rn,
                   COUNT(*) OVER (PARTITION BY ym) AS c
            FROM p
          )
          SELECT 'price' AS kind, ym, MAX(c) AS c, ROUND(AVG(v)) AS med
          FROM r WHERE rn IN ((c + 1) / 2, (c + 2) / 2)
          GROUP BY ym
          UNION ALL
          SELECT 'volume', ym, COUNT(*), NULL FROM stm GROUP BY ym`,
    args: [lawdCd, lawdCd],
  });

  const byYm = new Map<string, { med: number | null; sample: number; total: number }>();
  for (const row of result.rows) {
    const ym = String(row.ym);
    if (!/^\d{6}$/.test(ym)) continue;
    const entry = byYm.get(ym) ?? { med: null, sample: 0, total: 0 };
    if (String(row.kind) === "price") {
      const med = Number(row.med);
      entry.med = Number.isFinite(med) && med > 0 ? med : null;
      entry.sample = Number(row.c);
    } else {
      entry.total = Number(row.c);
    }
    byYm.set(ym, entry);
  }
  const points = withSmoothing(
    [...byYm.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ym, e]) => ({
        yearMonth: ym,
        medianPyeongPrice: e.med,
        tradeCount: e.total,
        priceSampleCount: e.sample,
      })),
  );

  const value: RegionPriceTrend = {
    status: "ok",
    lawdCd,
    basis: "SUPPLY_PYEONG_LABEL",
    points,
    recent: await recentPromise,
  };
  cache.set(lawdCd, { at: Date.now(), value });
  return value;
}
