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
import { REGION_PRICE_INDEX_METHOD, REGION_PRICE_INDEX_TABLE } from "@/lib/region/region-price-index";
import { regionScopeKey } from "@/lib/region/region-scope";

export type RegionPriceTrendPoint = {
  yearMonth: string;
  /** 지역 시세 평당가 (만원/공급평). 계산 가능한 단지가 없으면 null. */
  pyeongPrice: number | null;
  /** 이 달 값에 반영된 단지 수. */
  complexCount: number;
  /** 계약월 매매 거래 수. */
  tradeCount: number;
};

export type RegionDongPrice = {
  bjdongCd: string;
  name: string;
  pyeongPrice: number | null;
  /** 1년 전 같은 방식 값 대비 변화율(%). */
  change1y: number | null;
  complexCount: number;
  /** 최근 12개월 계약 매매 건수. */
  tradeCount12m: number;
};

export type RegionPriceTrend = {
  status: "ok";
  lawdCd: string;
  /** 동 범위일 때만 존재: 이 시계열의 법정동. `dongs`는 비어 있다. */
  dong?: { bjdongCd: string; name: string };
  basis: "SUPPLY_PYEONG_LABEL";
  method: "COMPLEX_LATEST_36M_HOUSEHOLD_WEIGHTED";
  points: RegionPriceTrendPoint[];
  latest: {
    yearMonth: string;
    pyeongPrice: number | null;
    complexCount: number;
    changes: Record<"6M" | "1Y" | "2Y" | "5Y", number | null>;
  } | null;
  dongs: RegionDongPrice[];
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

export type RegionPriceRawPoint = {
  yearMonth: string;
  /** 반올림 전 지역 시세 평당가. */
  pyeongPrice: number | null;
  complexCount: number;
  tradeCount: number;
};

export type RegionDongPriceSeries = {
  bjdongCd: string;
  name: string;
  points: RegionPriceRawPoint[];
};

export type RegionPriceSeries = {
  lawdCd: string;
  points: RegionPriceRawPoint[];
  dongs: RegionDongPriceSeries[];
};

function emptyTrend(lawdCd: string): RegionPriceTrend {
  return { status: "ok", lawdCd, basis: "SUPPLY_PYEONG_LABEL", method: "COMPLEX_LATEST_36M_HOUSEHOLD_WEIGHTED", points: [], latest: null, dongs: [] };
}

function pctChange(now: number | null, base: number | null | undefined): number | null {
  return now != null && base != null && base > 0
    ? Math.round(((now - base) / base) * 10000) / 100
    : null;
}

/** 월별 원시 시계열(월 연속)에서 API 응답을 만든다. 계산 경로와 적재본 경로가 공유한다. */
export function buildRegionPriceTrend(series: RegionPriceSeries): RegionPriceTrend {
  const { lawdCd } = series;
  if (!series.points.length) return emptyTrend(lawdCd);
  const points: RegionPriceTrendPoint[] = series.points.map((p) => ({
    yearMonth: p.yearMonth,
    pyeongPrice: p.pyeongPrice != null ? Math.round(p.pyeongPrice) : null,
    complexCount: p.complexCount,
    tradeCount: p.tradeCount,
  }));

  const tail = points[points.length - 1]!;
  const changes = {} as Record<keyof typeof CHANGE_MONTHS, number | null>;
  for (const [key, months] of Object.entries(CHANGE_MONTHS) as Array<[keyof typeof CHANGE_MONTHS, number]>) {
    changes[key] = pctChange(tail.pyeongPrice, points[points.length - 1 - months]?.pyeongPrice);
  }

  const last = monthIndex(tail.yearMonth);
  const dongs: RegionDongPrice[] = [];
  for (const dong of series.dongs) {
    const byMonth = new Map(dong.points.map((p) => [monthIndex(p.yearMonth), p]));
    const now = byMonth.get(last);
    if (!now || now.complexCount <= 0 || now.pyeongPrice == null) continue;
    const price = Math.round(now.pyeongPrice);
    const prev = byMonth.get(last - 12);
    const prevPrice = prev && prev.complexCount > 0 ? prev.pyeongPrice : null;
    let trades = 0;
    for (let m = last - 11; m <= last; m += 1) trades += byMonth.get(m)?.tradeCount ?? 0;
    dongs.push({
      bjdongCd: dong.bjdongCd,
      name: dong.name,
      pyeongPrice: price,
      change1y: pctChange(price, prevPrice),
      complexCount: now.complexCount,
      tradeCount12m: trades,
    });
  }
  dongs.sort(
    (a, b) => (b.pyeongPrice ?? 0) - (a.pyeongPrice ?? 0) || a.bjdongCd.localeCompare(b.bjdongCd),
  );

  return {
    status: "ok",
    lawdCd,
    basis: "SUPPLY_PYEONG_LABEL",
    method: "COMPLEX_LATEST_36M_HOUSEHOLD_WEIGHTED",
    points,
    dongs,
    latest: {
      yearMonth: tail.yearMonth,
      pyeongPrice: tail.pyeongPrice,
      complexCount: tail.complexCount,
      changes,
    },
  };
}

/** 원천 거래·평형 테이블에서 구 및 법정동 월별 시계열을 직접 계산한다. */
export async function computeRegionPriceSeries(
  db: RankingReader,
  lawdCd: string,
): Promise<RegionPriceSeries> {
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
                     CAST(t.deal_amount AS REAL) AS a,
                     m.bjdong_cd AS bj,
                     m.legal_dong_name AS dn
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
              SELECT b.cid, b.ec, b.ym, AVG(b.a / ul.label) AS v,
                     MAX(b.bj) AS bj, MAX(b.dn) AS dn
              FROM base b
              JOIN ul ON ul.complex_id = b.cid AND ul.exclusive_cents = b.ec
              WHERE ul.label > 0
              GROUP BY b.cid, b.ec, b.ym
            )
            SELECT agg.cid, agg.ec, agg.ym, agg.v, agg.bj, agg.dn,
                   COALESCE(hh.h, p.household_count) AS w
            FROM agg
            LEFT JOIN hh ON hh.complex_id = agg.cid
            LEFT JOIN apt_complex_profile p ON p.complex_id = agg.cid`,
      args: [lawdCd, lawdCd],
    }),
    db.execute({
      sql: `SELECT year_month AS ym, dong, COUNT(*) AS c
            FROM transactions
            WHERE lawd_cd = ? AND deal_type = 'trade' AND CAST(deal_amount AS REAL) > 0
            GROUP BY year_month, dong`,
      args: [lawdCd],
    }),
  ]);

  const volume = new Map<string, number>();
  const dongVolume = new Map<string, Map<number, number>>();
  for (const row of volumeRows.rows) {
    const ym = String(row.ym);
    if (!/^\d{6}$/.test(ym)) continue;
    const c = Number(row.c);
    volume.set(ym, (volume.get(ym) ?? 0) + c);
    const dn = String(row.dong ?? "").trim();
    if (dn) {
      const byMonth = dongVolume.get(dn) ?? new Map<number, number>();
      const m = monthIndex(ym);
      byMonth.set(m, (byMonth.get(m) ?? 0) + c);
      dongVolume.set(dn, byMonth);
    }
  }

  type TypeSeries = { cid: string; months: number[]; values: number[]; cursor: number };
  const types = new Map<string, TypeSeries>();
  const weights = new Map<string, number>();
  const complexDong = new Map<string, { bj: string; name: string }>();
  for (const row of typeRows.rows) {
    const ym = String(row.ym);
    const v = Number(row.v);
    if (!/^\d{6}$/.test(ym) || !Number.isFinite(v) || v <= 0) continue;
    const cid = String(row.cid);
    const w = Number(row.w);
    if (Number.isFinite(w) && w > 0) weights.set(cid, w);
    if (row.bj != null && row.dn != null && !complexDong.has(cid)) {
      complexDong.set(cid, { bj: String(row.bj), name: String(row.dn) });
    }
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
  if (!allMonths.length) return { lawdCd, points: [], dongs: [] };
  const first = Math.min(...allMonths);
  const last = Math.max(...allMonths, monthIndex(seoulToday().slice(0, 7).replace("-", "")));

  const nameOf = new Map<string, string>();
  for (const d of complexDong.values()) if (!nameOf.has(d.bj)) nameOf.set(d.bj, d.name);
  const dongPoints = new Map<string, RegionPriceRawPoint[]>();
  for (const bj of nameOf.keys()) dongPoints.set(bj, []);

  const points: RegionPriceRawPoint[] = [];
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
    const byDong = new Map<string, { num: number; den: number; n: number }>();
    for (const [cid, agg] of byComplex) {
      const w = weights.get(cid)!;
      num += (agg.sum / agg.n) * w;
      den += w;
      const dong = complexDong.get(cid);
      if (dong) {
        const d = byDong.get(dong.bj) ?? { num: 0, den: 0, n: 0 };
        d.num += (agg.sum / agg.n) * w;
        d.den += w;
        d.n += 1;
        byDong.set(dong.bj, d);
      }
    }
    const ym = ymFromIndex(m);
    points.push({
      yearMonth: ym,
      pyeongPrice: den > 0 ? num / den : null,
      complexCount: byComplex.size,
      tradeCount: volume.get(ym) ?? 0,
    });
    for (const [bj, list] of dongPoints) {
      const d = byDong.get(bj);
      list.push({
        yearMonth: ym,
        pyeongPrice: d && d.den > 0 ? d.num / d.den : null,
        complexCount: d?.n ?? 0,
        tradeCount: dongVolume.get(nameOf.get(bj)!)?.get(m) ?? 0,
      });
    }
  }

  return {
    lawdCd,
    points,
    dongs: [...dongPoints.entries()].map(([bj, list]) => ({
      bjdongCd: bj,
      name: nameOf.get(bj)!,
      points: list,
    })),
  };
}

export async function computeRegionPriceTrend(
  db: RankingReader,
  lawdCd: string,
): Promise<RegionPriceTrend> {
  return buildRegionPriceTrend(await computeRegionPriceSeries(db, lawdCd));
}

function dongCodeRange(lawdCd: string): [string, string] {
  return [`${lawdCd}00000`, `${lawdCd}99999`];
}

/** 적재본이 있으면 구 시계열 전체와 최근 13개월 법정동 값만 읽는다. 없으면 null. */
async function readMaterialized(db: RankingReader, lawdCd: string): Promise<RegionPriceTrend | null> {
  const [lo, hi] = dongCodeRange(lawdCd);
  const readDongs = (fromYm: string) =>
    db.execute({
      sql: `SELECT region_code, region_name, year_month, pyeong_price, complex_count, trade_count
            FROM ${REGION_PRICE_INDEX_TABLE}
            WHERE method_version = ? AND scope = 'dong'
              AND region_code BETWEEN ? AND ? AND year_month >= ?`,
      args: [REGION_PRICE_INDEX_METHOD, lo, hi, fromYm],
    });
  const speculativeFrom = monthIndex(seoulToday().slice(0, 7).replace("-", "")) - 14;
  let guRows;
  let dongRows;
  try {
    [guRows, dongRows] = await Promise.all([
      db.execute({
        sql: `SELECT year_month, pyeong_price, complex_count, trade_count
              FROM ${REGION_PRICE_INDEX_TABLE}
              WHERE method_version = ? AND scope = 'gu' AND region_code = ?
              ORDER BY year_month`,
        args: [REGION_PRICE_INDEX_METHOD, lawdCd],
      }),
      readDongs(ymFromIndex(speculativeFrom)),
    ]);
  } catch {
    return null;
  }
  if (!guRows.rows.length) return null;
  const toPoint = (r: Record<string, unknown>): RegionPriceRawPoint => ({
    yearMonth: String(r.year_month),
    pyeongPrice: r.pyeong_price == null ? null : Number(r.pyeong_price),
    complexCount: Number(r.complex_count ?? 0),
    tradeCount: Number(r.trade_count ?? 0),
  });
  const points = guRows.rows.map(toPoint);
  const last = monthIndex(points[points.length - 1]!.yearMonth);
  if (last - 12 < speculativeFrom) dongRows = await readDongs(ymFromIndex(last - 12));
  const dongs = new Map<string, RegionDongPriceSeries>();
  for (const r of dongRows.rows) {
    const bj = String(r.region_code).slice(5);
    let d = dongs.get(bj);
    if (!d) {
      d = { bjdongCd: bj, name: String(r.region_name), points: [] };
      dongs.set(bj, d);
    }
    d.points.push(toPoint(r));
  }
  return buildRegionPriceTrend({ lawdCd, points, dongs: [...dongs.values()] });
}

/** 한 법정동의 월별 시계열을 API 응답 모양으로 만든다(동 목록 없음). */
function buildDongPriceTrend(lawdCd: string, series: RegionDongPriceSeries): RegionPriceTrend {
  const trend = buildRegionPriceTrend({ lawdCd, points: series.points, dongs: [] });
  return { ...trend, dong: { bjdongCd: series.bjdongCd, name: series.name } };
}

/** 적재본에서 법정동 하나의 전체 시계열을 읽는다. 없으면 null. */
async function readMaterializedDong(
  db: RankingReader,
  lawdCd: string,
  dong: string,
): Promise<RegionPriceTrend | null> {
  const [lo, hi] = dongCodeRange(lawdCd);
  let rows;
  try {
    rows = await db.execute({
      sql: `SELECT region_code, region_name, year_month, pyeong_price, complex_count, trade_count
            FROM ${REGION_PRICE_INDEX_TABLE}
            WHERE method_version = ? AND scope = 'dong'
              AND region_code BETWEEN ? AND ? AND region_name = ?
            ORDER BY year_month`,
      args: [REGION_PRICE_INDEX_METHOD, lo, hi, dong],
    });
  } catch {
    return null;
  }
  if (!rows.rows.length) return null;
  const first = rows.rows[0]!;
  return buildDongPriceTrend(lawdCd, {
    bjdongCd: String(first.region_code).slice(5),
    name: String(first.region_name),
    points: rows.rows.map((r) => ({
      yearMonth: String(r.year_month),
      pyeongPrice: r.pyeong_price == null ? null : Number(r.pyeong_price),
      complexCount: Number(r.complex_count ?? 0),
      tradeCount: Number(r.trade_count ?? 0),
    })),
  });
}

/** 구 적재본이 있는지. 있으면 적재 때 동 목록도 같은 계산으로 함께 들어갔다. */
async function hasMaterializedGu(db: RankingReader, lawdCd: string): Promise<boolean> {
  try {
    const rows = await db.execute({
      sql: `SELECT 1 FROM ${REGION_PRICE_INDEX_TABLE}
            WHERE method_version = ? AND scope = 'gu' AND region_code = ?
            LIMIT 1`,
      args: [REGION_PRICE_INDEX_METHOD, lawdCd],
    });
    return rows.rows.length > 0;
  } catch {
    return false;
  }
}

function emptyDongTrend(lawdCd: string, dong: string): RegionPriceTrend {
  return { ...emptyTrend(lawdCd), dong: { bjdongCd: "", name: dong } };
}

/** 적재본이 없을 때: 구 시계열을 계산해 해당 동만 꺼낸다(구 계산과 같은 비용). */
async function computeDongPriceTrend(
  db: RankingReader,
  lawdCd: string,
  dong: string,
): Promise<RegionPriceTrend> {
  const series = await computeRegionPriceSeries(db, lawdCd);
  const match = series.dongs.find((d) => d.name === dong);
  if (!match) return emptyDongTrend(lawdCd, dong);
  return buildDongPriceTrend(lawdCd, match);
}

/**
 * 동 적재본이 없을 때: 구 적재본이 있으면 그 동은 적재 계산에서 빠진 동(표본 부족·없는 동)이라
 * 다시 계산해도 빈 결과다 — 구 전체 재계산(20초 이상) 없이 바로 빈 시계열을 준다.
 */
async function readDongFallback(
  db: RankingReader,
  lawdCd: string,
  dong: string,
): Promise<RegionPriceTrend> {
  if (await hasMaterializedGu(db, lawdCd)) return emptyDongTrend(lawdCd, dong);
  return computeDongPriceTrend(db, lawdCd, dong);
}

/**
 * 구(또는 `dong` 법정동) 시세 평당가 시계열. 적재본(region_price_index)을 먼저 읽고,
 * 없으면 원천 거래에서 계산한다.
 */
export async function readRegionPriceTrend(
  db: RankingReader,
  lawdCd: string,
  dong?: string | null,
): Promise<RegionPriceTrend> {
  const key = regionScopeKey({ lawdCd, dong });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = (
    dong
      ? readMaterializedDong(db, lawdCd, dong).then(
          (stored) => stored ?? readDongFallback(db, lawdCd, dong),
        )
      : readMaterialized(db, lawdCd).then((stored) => stored ?? computeRegionPriceTrend(db, lawdCd))
  )
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
