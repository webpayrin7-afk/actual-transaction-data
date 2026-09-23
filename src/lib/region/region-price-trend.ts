/**
 * 구 단위 지역 시세 평당가 (read-only, 공급면적 기준).
 *
 * 월 M의 값:
 *   1) 단지·전용면적 타입마다 M 이전 36개월 안의 가장 최근 거래월 평균 평당가
 *      (거래금액 ÷ 공급 평형 라벨, 라벨 규칙은 단지 상세 V3와 동일)
 *   2) 단지 값 = 타입 값의 평균
 *   3) 지역 값 = 단지 값의 세대수 가중 평균
 *      (세대수: 매매 거래가 있었던 평형의 세대수 합계, 없으면 단지 프로필 세대수.
 *       둘 다 없으면 제외)
 * 거래량은 공급 평형 확인 여부와 무관하게 계약월 매매 건수를 센다.
 */
import type { RankingReader } from "@/lib/region-ranking/query";
import { seoulToday } from "@/lib/market/time";

export type RegionPriceTrendPoint = {
  yearMonth: string;
  /** 지역 시세 평당가 (만원/공급평). 계산 가능한 단지가 없으면 null. */
  pyeongPrice: number | null;
  /** 이 달 값에 반영된 단지 수. */
  complexCount: number;
  /** 계약월 매매 거래 수. */
  tradeCount: number;
};

export type RegionPriceTrend = {
  status: "ok";
  lawdCd: string;
  basis: "SUPPLY_PYEONG_LABEL";
  method: "COMPLEX_LATEST_36M_HOUSEHOLD_WEIGHTED";
  points: RegionPriceTrendPoint[];
  latest: {
    yearMonth: string;
    pyeongPrice: number | null;
    complexCount: number;
    changes: Record<"6M" | "1Y" | "2Y" | "5Y", number | null>;
  } | null;
};

const SUPPLY_PYEONG_FACTOR = 3.305785;
const LOOKBACK_MONTHS = 36;
const CHANGE_MONTHS = { "6M": 6, "1Y": 12, "2Y": 24, "5Y": 60 } as const;
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: RegionPriceTrend }>();
const inflight = new Map<string, Promise<RegionPriceTrend>>();

function monthIndex(ym: string): number {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1;
}

function ymFromIndex(idx: number): string {
  return `${Math.floor(idx / 12)}${String((idx % 12) + 1).padStart(2, "0")}`;
}

async function compute(db: RankingReader, lawdCd: string): Promise<RegionPriceTrend> {
  const [typeRows, volumeRows] = await Promise.all([
    db.execute({
      sql: `WITH cu AS (
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
            base AS MATERIALIZED (
              SELECT m.complex_id AS cid,
                     CAST(ROUND(CAST(t.exclusive_area AS REAL) * 100) AS INTEGER) AS ec,
                     t.year_month AS ym,
                     CAST(t.deal_amount AS REAL) AS a
              FROM transactions t
              JOIN apt_complex_master m
                ON m.lawd_cd = t.lawd_cd AND m.apt_name_norm = t.apt_name_norm
               AND m.legal_dong_name = t.dong
              WHERE t.lawd_cd = ? AND t.deal_type = 'trade'
                AND CAST(t.deal_amount AS REAL) > 0
            ),
            traded AS (SELECT DISTINCT cid, ec FROM base),
            hh AS (
              SELECT u.complex_id, SUM(u.household_count) AS h
              FROM unit_type_household_counts u
              JOIN traded tr ON tr.cid = u.complex_id AND tr.ec = u.exclusive_cents
              WHERE u.household_count IS NOT NULL
              GROUP BY u.complex_id
            ),
            agg AS (
              SELECT b.cid, b.ec, b.ym, AVG(b.a / ul.label) AS v
              FROM base b
              JOIN ul ON ul.complex_id = b.cid AND ul.exclusive_cents = b.ec
              WHERE ul.label > 0
              GROUP BY b.cid, b.ec, b.ym
            )
            SELECT agg.cid, agg.ec, agg.ym, agg.v, COALESCE(hh.h, p.household_count) AS w
            FROM agg
            LEFT JOIN hh ON hh.complex_id = agg.cid
            LEFT JOIN apt_complex_profile p ON p.complex_id = agg.cid`,
      args: [lawdCd, lawdCd],
    }),
    db.execute({
      sql: `SELECT year_month AS ym, COUNT(*) AS c
            FROM transactions
            WHERE lawd_cd = ? AND deal_type = 'trade' AND CAST(deal_amount AS REAL) > 0
            GROUP BY year_month`,
      args: [lawdCd],
    }),
  ]);

  const volume = new Map<string, number>();
  for (const row of volumeRows.rows) {
    const ym = String(row.ym);
    if (/^\d{6}$/.test(ym)) volume.set(ym, Number(row.c));
  }

  type TypeSeries = { cid: string; months: number[]; values: number[]; cursor: number };
  const types = new Map<string, TypeSeries>();
  const weights = new Map<string, number>();
  for (const row of typeRows.rows) {
    const ym = String(row.ym);
    const v = Number(row.v);
    if (!/^\d{6}$/.test(ym) || !Number.isFinite(v) || v <= 0) continue;
    const cid = String(row.cid);
    const w = Number(row.w);
    if (Number.isFinite(w) && w > 0) weights.set(cid, w);
    const key = `${cid}|${row.ec}`;
    let t = types.get(key);
    if (!t) {
      t = { cid, months: [], values: [], cursor: -1 };
      types.set(key, t);
    }
    t.months.push(monthIndex(ym));
    t.values.push(v);
  }
  for (const t of types.values()) {
    const order = t.months.map((m, i) => [m, t.values[i]!] as const).sort((a, b) => a[0] - b[0]);
    t.months = order.map((o) => o[0]);
    t.values = order.map((o) => o[1]);
  }

  const allMonths = [...volume.keys()].map(monthIndex);
  if (!allMonths.length) {
    return { status: "ok", lawdCd, basis: "SUPPLY_PYEONG_LABEL", method: "COMPLEX_LATEST_36M_HOUSEHOLD_WEIGHTED", points: [], latest: null };
  }
  const first = Math.min(...allMonths);
  const last = Math.max(...allMonths, monthIndex(seoulToday().slice(0, 7).replace("-", "")));

  const points: RegionPriceTrendPoint[] = [];
  for (let m = first; m <= last; m += 1) {
    const byComplex = new Map<string, { sum: number; n: number }>();
    for (const t of types.values()) {
      while (t.cursor + 1 < t.months.length && t.months[t.cursor + 1]! <= m) t.cursor += 1;
      if (t.cursor < 0 || m - t.months[t.cursor]! >= LOOKBACK_MONTHS) continue;
      if (!weights.has(t.cid)) continue;
      const agg = byComplex.get(t.cid) ?? { sum: 0, n: 0 };
      agg.sum += t.values[t.cursor]!;
      agg.n += 1;
      byComplex.set(t.cid, agg);
    }
    let num = 0;
    let den = 0;
    for (const [cid, agg] of byComplex) {
      const w = weights.get(cid)!;
      num += (agg.sum / agg.n) * w;
      den += w;
    }
    const ym = ymFromIndex(m);
    points.push({
      yearMonth: ym,
      pyeongPrice: den > 0 ? Math.round(num / den) : null,
      complexCount: byComplex.size,
      tradeCount: volume.get(ym) ?? 0,
    });
  }

  const tail = points[points.length - 1] ?? null;
  const changes = {} as Record<keyof typeof CHANGE_MONTHS, number | null>;
  for (const [key, months] of Object.entries(CHANGE_MONTHS) as Array<[keyof typeof CHANGE_MONTHS, number]>) {
    const base = points[points.length - 1 - months];
    changes[key] =
      tail?.pyeongPrice != null && base?.pyeongPrice != null && base.pyeongPrice > 0
        ? Math.round(((tail.pyeongPrice - base.pyeongPrice) / base.pyeongPrice) * 10000) / 100
        : null;
  }

  return {
    status: "ok",
    lawdCd,
    basis: "SUPPLY_PYEONG_LABEL",
    method: "COMPLEX_LATEST_36M_HOUSEHOLD_WEIGHTED",
    points,
    latest: tail
      ? {
          yearMonth: tail.yearMonth,
          pyeongPrice: tail.pyeongPrice,
          complexCount: tail.complexCount,
          changes,
        }
      : null,
  };
}

export async function readRegionPriceTrend(
  db: RankingReader,
  lawdCd: string,
): Promise<RegionPriceTrend> {
  const hit = cache.get(lawdCd);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const pending = inflight.get(lawdCd);
  if (pending) return pending;
  const job = compute(db, lawdCd)
    .then((value) => {
      cache.set(lawdCd, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(lawdCd));
  inflight.set(lawdCd, job);
  return job;
}
