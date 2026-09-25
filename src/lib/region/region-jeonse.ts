/**
 * 구(또는 법정동) 단위 전세가율 · 갭 (read-only 계산 + region_jeonse_* 적재본 읽기).
 * 동 범위는 적재본이 없어 최근 3년 시계열만 요청 때 계산한다.
 *
 * 전세: 임대 거래 중 월세 0(또는 NULL)이고 보증금 > 0인 거래.
 * 비교 단위(pair): 단지(apt_complex_master) × 전용면적 타입(㎡ 반올림).
 * 월 M의 pair 값:
 *   매매가 = M 포함 직전 3개월 매매 거래금액 중앙값
 *   전세가 = 같은 3개월 전세 보증금 중앙값
 *   둘 다 있을 때만 집계. 전세가율 = 전세가 ÷ 매매가, 갭 = 매매가 − 전세가(만원).
 * 지역 월 전세가율 = 집계된 pair 전세가율의 중앙값.
 * 기준월(asOfMonth) = 최신 매매 계약월, 단 진행 중인 달력월은 제외(신고 미완료).
 * 시계열: 매매·전세 3개월 창이 모두 수집 구간에 들어오는 첫 달 ~ 기준월 (최대 240개월).
 *
 * 목록(lowGap, highRatio) 표본 기준: 기준월 3개월 창에서 매매 2건 이상 · 전세 2건 이상인 pair.
 *   (중앙값이 단일 거래 한 건에 좌우되지 않도록 하는 최소치)
 * jeonseBelow2yAgo: 기준월 3개월 전세 중앙값이 24개월 전(통상 임대차 기간) 같은 pair의
 *   3개월 전세 중앙값보다 낮은 pair. 두 시점 모두 전세 2건 이상인 pair만 대상(eligible).
 */
import type { RankingReader } from "@/lib/region-ranking/query";
import { seoulToday } from "@/lib/market/time";
import { DONG_TX_FROM, DONG_TX_WHERE, regionScopeKey } from "@/lib/region/region-scope";

export const REGION_JEONSE_INDEX_TABLE = "region_jeonse_index";
export const REGION_JEONSE_SNAPSHOT_TABLE = "region_jeonse_snapshot";
export const REGION_JEONSE_METHOD = "PAIR_TRAILING_3M_MEDIAN_V1";

export const REGION_JEONSE_DDL = [
  `CREATE TABLE IF NOT EXISTS ${REGION_JEONSE_INDEX_TABLE} (
    method_version TEXT NOT NULL,
    lawd_cd TEXT NOT NULL,
    year_month TEXT NOT NULL,
    jeonse_ratio REAL,
    pair_count INTEGER NOT NULL DEFAULT 0,
    calculated_at TEXT NOT NULL,
    PRIMARY KEY (method_version, lawd_cd, year_month)
  )`,
  `CREATE TABLE IF NOT EXISTS ${REGION_JEONSE_SNAPSHOT_TABLE} (
    method_version TEXT NOT NULL,
    lawd_cd TEXT NOT NULL,
    as_of_month TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    calculated_at TEXT NOT NULL,
    PRIMARY KEY (method_version, lawd_cd)
  )`,
];

export async function ensureRegionJeonseTables(db: RankingReader): Promise<void> {
  for (const sql of REGION_JEONSE_DDL) await db.execute({ sql });
}

export type RegionJeonsePoint = {
  yearMonth: string;
  jeonseRatio: number | null;
  pairCount: number;
};

export type RegionJeonsePair = {
  complexId: string;
  aptName: string;
  dong: string;
  exclusiveArea: number;
  tradeMedian: number;
  jeonseMedian: number;
  jeonseRatio: number;
  gap: number;
};

export type RegionJeonseDrop = {
  complexId: string;
  aptName: string;
  dong: string;
  exclusiveArea: number;
  jeonseNow: number;
  jeonse2yAgo: number;
  change: number;
  changePct: number;
};

export type RegionJeonse = {
  status: "ok";
  lawdCd: string;
  /** 동 범위일 때만 존재. */
  dong?: string;
  asOfMonth: string;
  series: RegionJeonsePoint[];
  latest: {
    jeonseRatio: number | null;
    pairCount: number;
    change1yPp: number | null;
  };
  lowGap: RegionJeonsePair[];
  highRatio: RegionJeonsePair[];
  jeonseBelow2yAgo: {
    count: number;
    eligible: number;
    share: number | null;
    items: RegionJeonseDrop[];
  };
};

type Snapshot = Omit<RegionJeonse, "status" | "lawdCd" | "series">;

const MAX_SERIES_MONTHS = 240;
/**
 * 동 범위 시계열 길이. 동은 적재본이 없어 요청 때 계산하므로 읽는 행 수를 줄이려고
 * 최근 3년만 그린다(목록·2년 전 비교에 필요한 창은 모두 포함).
 */
const DONG_SERIES_MONTHS = 36;
const WINDOW_MONTHS = 3;
const LEASE_MONTHS = 24;
const MIN_LIST_SAMPLE = 2;
const LIST_LIMIT = 10;
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: RegionJeonse }>();
const inflight = new Map<string, Promise<RegionJeonse>>();

function monthIndex(ym: string): number {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1;
}

function ymFromIndex(idx: number): string {
  return `${Math.floor(idx / 12)}${String((idx % 12) + 1).padStart(2, "0")}`;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;
const round2 = (v: number) => Math.round(v * 100) / 100;

type PairData = {
  complexId: string;
  aptName: string;
  dong: string;
  area: number;
  trade: Map<number, number[]>;
  jeonse: Map<number, number[]>;
};

function windowValues(byMonth: Map<number, number[]>, end: number): number[] {
  const out: number[] = [];
  for (let m = end - WINDOW_MONTHS + 1; m <= end; m++) {
    const v = byMonth.get(m);
    if (v) out.push(...v);
  }
  return out;
}

function parseAmounts(raw: unknown): number[] {
  return String(raw ?? "")
    .split(",")
    .map(Number)
    .filter((v) => Number.isFinite(v) && v > 0);
}

/** 동 범위: 동 단지 거래만 인덱스로 읽는다. 열·집계는 구 쿼리와 같다. */
const DONG_JEONSE_SQL = `SELECT m.complex_id AS c, MAX(m.apt_name) AS apt_name, MAX(m.legal_dong_name) AS dong,
                 ROUND(CAST(t.exclusive_area AS REAL), 0) AS ar,
                 MAX(CAST(t.exclusive_area AS REAL)) AS ea,
                 t.year_month AS ym, t.deal_type AS k,
                 GROUP_CONCAT(CAST(t.deal_amount AS REAL)) AS v
          FROM ${DONG_TX_FROM}
          WHERE ${DONG_TX_WHERE}
            AND CAST(t.deal_amount AS REAL) > 0 AND CAST(t.exclusive_area AS REAL) > 0
            AND (t.deal_type = 'trade'
              OR (t.deal_type = 'rent' AND COALESCE(CAST(t.monthly_rent AS REAL), 0) = 0))
          GROUP BY m.complex_id, ar, t.year_month, t.deal_type`;

export async function computeRegionJeonse(
  db: RankingReader,
  lawdCd: string,
  dong?: string | null,
): Promise<RegionJeonse> {
  const maxSeriesMonths = dong ? DONG_SERIES_MONTHS : MAX_SERIES_MONTHS;
  const currentIdx = monthIndex(seoulToday().slice(0, 7).replace("-", ""));
  // 시계열 첫 달의 3개월 창까지 담는다(24개월 전 비교 창은 그 안에 들어간다).
  const fromYm = ymFromIndex(currentIdx - (maxSeriesMonths + WINDOW_MONTHS));
  const result = await db.execute(dong ? { sql: DONG_JEONSE_SQL, args: [lawdCd, dong, fromYm] } : {
    sql: `SELECT m.complex_id AS c, MAX(m.apt_name) AS apt_name, MAX(m.legal_dong_name) AS dong,
                 ROUND(CAST(t.exclusive_area AS REAL), 0) AS ar,
                 MAX(CAST(t.exclusive_area AS REAL)) AS ea,
                 t.year_month AS ym, t.deal_type AS k,
                 GROUP_CONCAT(CAST(t.deal_amount AS REAL)) AS v
          FROM transactions t
          JOIN apt_complex_master m
            ON m.lawd_cd = t.lawd_cd AND m.apt_name_norm = t.apt_name_norm
           AND m.legal_dong_name = t.dong
          WHERE t.lawd_cd = ? AND t.year_month >= ?
            AND CAST(t.deal_amount AS REAL) > 0 AND CAST(t.exclusive_area AS REAL) > 0
            AND (t.deal_type = 'trade'
              OR (t.deal_type = 'rent' AND COALESCE(CAST(t.monthly_rent AS REAL), 0) = 0))
          GROUP BY m.complex_id, ar, t.year_month, t.deal_type`,
    args: [lawdCd, fromYm],
  });

  const pairs = new Map<string, PairData>();
  let asOfIdx = -1;
  let tradeFromIdx = Infinity;
  let jeonseFromIdx = Infinity;
  for (const row of result.rows) {
    const complexId = String(row.c);
    const ar = Number(row.ar);
    const key = `${complexId}|${ar}`;
    let p = pairs.get(key);
    if (!p) {
      p = {
        complexId,
        aptName: String(row.apt_name ?? ""),
        dong: String(row.dong ?? ""),
        area: Number(row.ea),
        trade: new Map(),
        jeonse: new Map(),
      };
      pairs.set(key, p);
    }
    const ym = monthIndex(String(row.ym));
    const amounts = parseAmounts(row.v);
    if (!amounts.length) continue;
    if (String(row.k) === "trade") {
      p.trade.set(ym, amounts);
      if (ym > asOfIdx) asOfIdx = ym;
      if (ym < tradeFromIdx) tradeFromIdx = ym;
    } else {
      p.jeonse.set(ym, amounts);
      if (ym < jeonseFromIdx) jeonseFromIdx = ym;
    }
  }
  asOfIdx = asOfIdx < 0 ? currentIdx - 1 : Math.min(asOfIdx, currentIdx - 1);

  const coveredFromIdx = Math.max(tradeFromIdx, jeonseFromIdx) + WINDOW_MONTHS - 1;
  const seriesFromIdx = Math.max(
    asOfIdx - maxSeriesMonths + 1,
    Math.min(coveredFromIdx, asOfIdx),
  );
  const series: RegionJeonsePoint[] = [];
  for (let m = seriesFromIdx; m <= asOfIdx; m++) {
    const ratios: number[] = [];
    if (m >= coveredFromIdx) {
      for (const p of pairs.values()) {
        const t = median(windowValues(p.trade, m));
        const j = median(windowValues(p.jeonse, m));
        if (t != null && j != null) ratios.push(j / t);
      }
    }
    const r = median(ratios);
    series.push({
      yearMonth: ymFromIndex(m),
      jeonseRatio: r == null ? null : round4(r),
      pairCount: ratios.length,
    });
  }

  const listed: RegionJeonsePair[] = [];
  const drops: RegionJeonseDrop[] = [];
  let eligible = 0;
  for (const p of pairs.values()) {
    const base = {
      complexId: p.complexId,
      aptName: p.aptName,
      dong: p.dong,
      exclusiveArea: round2(p.area),
    };
    const tradeNow = windowValues(p.trade, asOfIdx);
    const jeonseNow = windowValues(p.jeonse, asOfIdx);
    if (tradeNow.length >= MIN_LIST_SAMPLE && jeonseNow.length >= MIN_LIST_SAMPLE) {
      const t = median(tradeNow)!;
      const j = median(jeonseNow)!;
      listed.push({
        ...base,
        tradeMedian: Math.round(t),
        jeonseMedian: Math.round(j),
        jeonseRatio: round4(j / t),
        gap: Math.round(t - j),
      });
    }
    const jeonsePrev = windowValues(p.jeonse, asOfIdx - LEASE_MONTHS);
    if (jeonseNow.length >= MIN_LIST_SAMPLE && jeonsePrev.length >= MIN_LIST_SAMPLE) {
      eligible += 1;
      const now = median(jeonseNow)!;
      const prev = median(jeonsePrev)!;
      if (now < prev) {
        drops.push({
          ...base,
          jeonseNow: Math.round(now),
          jeonse2yAgo: Math.round(prev),
          change: Math.round(now - prev),
          changePct: round2(((now - prev) / prev) * 100),
        });
      }
    }
  }

  const last = series[series.length - 1];
  const yearAgo = series[series.length - 13];
  const change1yPp =
    last?.jeonseRatio != null && yearAgo?.jeonseRatio != null
      ? round2((last.jeonseRatio - yearAgo.jeonseRatio) * 100)
      : null;

  return {
    status: "ok",
    lawdCd,
    ...(dong ? { dong } : {}),
    asOfMonth: ymFromIndex(asOfIdx),
    series,
    latest: {
      jeonseRatio: last?.jeonseRatio ?? null,
      pairCount: last?.pairCount ?? 0,
      change1yPp,
    },
    lowGap: [...listed].sort((a, b) => a.gap - b.gap).slice(0, LIST_LIMIT),
    highRatio: [...listed].sort((a, b) => b.jeonseRatio - a.jeonseRatio).slice(0, LIST_LIMIT),
    jeonseBelow2yAgo: {
      count: drops.length,
      eligible,
      share: eligible ? round4(drops.length / eligible) : null,
      items: drops.sort((a, b) => a.change - b.change).slice(0, LIST_LIMIT),
    },
  };
}

export function regionJeonseSnapshot(value: RegionJeonse): Snapshot {
  const { asOfMonth, latest, lowGap, highRatio, jeonseBelow2yAgo } = value;
  return { asOfMonth, latest, lowGap, highRatio, jeonseBelow2yAgo };
}

async function readMaterialized(db: RankingReader, lawdCd: string): Promise<RegionJeonse | null> {
  let seriesRows;
  let snapRows;
  try {
    [seriesRows, snapRows] = await Promise.all([
      db.execute({
        sql: `SELECT year_month, jeonse_ratio, pair_count
              FROM ${REGION_JEONSE_INDEX_TABLE}
              WHERE method_version = ? AND lawd_cd = ?
              ORDER BY year_month`,
        args: [REGION_JEONSE_METHOD, lawdCd],
      }),
      db.execute({
        sql: `SELECT payload_json FROM ${REGION_JEONSE_SNAPSHOT_TABLE}
              WHERE method_version = ? AND lawd_cd = ?`,
        args: [REGION_JEONSE_METHOD, lawdCd],
      }),
    ]);
  } catch {
    return null;
  }
  const raw = snapRows.rows[0]?.payload_json;
  if (!seriesRows.rows.length || raw == null) return null;
  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(String(raw)) as Snapshot;
  } catch {
    return null;
  }
  const series = seriesRows.rows.slice(-MAX_SERIES_MONTHS).map((r) => ({
    yearMonth: String(r.year_month),
    jeonseRatio: r.jeonse_ratio == null ? null : Number(r.jeonse_ratio),
    pairCount: Number(r.pair_count ?? 0),
  }));
  return { status: "ok", lawdCd, series, ...snapshot };
}

/** 구는 적재본 우선, 동(`dong`)은 적재본이 없어 최근 3년을 바로 계산한다. */
export async function readRegionJeonse(
  db: RankingReader,
  lawdCd: string,
  dong?: string | null,
): Promise<RegionJeonse> {
  const key = regionScopeKey({ lawdCd, dong });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = (dong ? computeRegionJeonse(db, lawdCd, dong) : readMaterialized(db, lawdCd)
    .then((stored) => stored ?? computeRegionJeonse(db, lawdCd)))
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
