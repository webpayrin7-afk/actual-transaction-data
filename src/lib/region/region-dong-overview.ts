/**
 * 법정동 개요 (read-only): 단지 목록 · 지도 좌표 · 최근 거래.
 *
 * 구 페이지에는 없는 동 전용 데이터라 한 번의 요청으로 묶는다.
 * - 단지: apt_complex_master(lawd_cd + 법정동) + 프로필 세대수(없으면 평형별 세대수 합)
 *         + 좌표(complex_map_anchor 우선, 없으면 마스터 좌표)
 * - 거래: 최근 12개월 동 단지 거래를 `idx_tx_lawd_apt_ym`으로 읽는다(DONG_TX_FROM).
 *         단지별 최근 1년 매매 건수 · 최근 매매, 그리고 최근 거래 목록을 만든다.
 */
import type { RankingReader } from "@/lib/region-ranking/query";
import { seoulToday } from "@/lib/market/time";
import { DONG_TX_FROM, DONG_TX_WHERE, regionScopeKey } from "@/lib/region/region-scope";

export type RegionDongComplex = {
  complexId: string;
  aptName: string;
  householdCount: number | null;
  /** 사용승인 연도, 없으면 실거래 건축년도. */
  buildYear: number | null;
  lat: number | null;
  lng: number | null;
  /** 최근 12개월 매매 건수. */
  trades12m: number;
  latestTrade: { dealDate: string; dealAmount: number; exclusiveArea: number } | null;
};

export type RegionDongDealKind = "trade" | "jeonse" | "monthly";

export type RegionDongDeal = {
  id: string;
  complexId: string;
  aptName: string;
  kind: RegionDongDealKind;
  dealDate: string;
  /** 매매가 또는 보증금 (만원). */
  dealAmount: number;
  /** 월세 (만원). 매매·전세는 0. */
  monthlyRent: number;
  exclusiveArea: number;
  floor: number | null;
};

export type RegionDongOverview = {
  status: "ok";
  lawdCd: string;
  dong: string;
  bjdongCd: string | null;
  sigungu: string | null;
  complexes: RegionDongComplex[];
  recentDeals: { trade: RegionDongDeal[]; rent: RegionDongDeal[] };
  /** 최근 거래·단지별 매매 건수 집계 창 (YYYYMM). */
  windowFrom: string;
};

const WINDOW_MONTHS = 12;
const RECENT_LIMIT = 30;
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; value: RegionDongOverview }>();
const inflight = new Map<string, Promise<RegionDongOverview>>();

function shiftYm(ym: string, months: number): string {
  const idx = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1 + months;
  return `${Math.floor(idx / 12)}${String((idx % 12) + 1).padStart(2, "0")}`;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function yearOf(value: unknown): number | null {
  const m = /^(\d{4})/.exec(String(value ?? "").trim());
  const y = m ? Number(m[1]) : null;
  return y != null && y >= 1950 && y <= 2100 ? y : null;
}

async function computeRegionDongOverview(
  db: RankingReader,
  lawdCd: string,
  dong: string,
): Promise<RegionDongOverview> {
  const currentYm = seoulToday().slice(0, 7).replace("-", "");
  const windowFrom = shiftYm(currentYm, -(WINDOW_MONTHS - 1));

  const [masterRows, txRows] = await Promise.all([
    db.execute({
      sql: `WITH u AS (
              SELECT u.complex_id, SUM(u.household_count) AS hh
              FROM unit_type_household_counts u
              JOIN apt_complex_master m ON m.complex_id = u.complex_id
              WHERE m.lawd_cd = ? AND m.legal_dong_name = ? AND u.household_count IS NOT NULL
              GROUP BY u.complex_id
            )
            SELECT m.complex_id, m.apt_name, m.bjdong_cd, m.sigungu,
                   COALESCE(a.lat, m.latitude) AS lat,
                   COALESCE(a.lng, m.longitude) AS lng,
                   COALESCE(p.household_count, u.hh) AS hh,
                   p.approval_date
            FROM apt_complex_master m
            LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
            LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id
            LEFT JOIN u ON u.complex_id = m.complex_id
            WHERE m.lawd_cd = ? AND m.legal_dong_name = ?`,
      args: [lawdCd, dong, lawdCd, dong],
    }),
    db.execute({
      sql: `SELECT m.complex_id AS c, t.id, t.apt_name, t.deal_type, t.deal_date,
                   CAST(t.deal_amount AS REAL) AS a,
                   CAST(t.monthly_rent AS REAL) AS r,
                   CAST(t.exclusive_area AS REAL) AS ea,
                   t.floor, t.build_year
            FROM ${DONG_TX_FROM}
            WHERE ${DONG_TX_WHERE} AND CAST(t.deal_amount AS REAL) > 0
            ORDER BY t.deal_date DESC, t.id DESC`,
      args: [lawdCd, dong, windowFrom],
    }),
  ]);

  type Stat = {
    name: string | null;
    trades: number;
    latest: RegionDongComplex["latestTrade"];
    buildYear: number | null;
  };
  const stats = new Map<string, Stat>();
  const trade: RegionDongDeal[] = [];
  const rent: RegionDongDeal[] = [];
  for (const row of txRows.rows) {
    const complexId = String(row.c);
    const s = stats.get(complexId) ?? { name: null, trades: 0, latest: null, buildYear: null };
    // 행은 최신 계약일 순: 첫 행의 표기 이름을 쓴다(마스터 이름은 정규화된 소문자일 수 있음).
    s.name ??= String(row.apt_name ?? "").trim() || null;
    s.buildYear ??= yearOf(row.build_year);
    const amount = num(row.a) ?? 0;
    const area = num(row.ea) ?? 0;
    const isTrade = String(row.deal_type) === "trade";
    if (isTrade) {
      s.trades += 1;
      s.latest ??= { dealDate: String(row.deal_date), dealAmount: amount, exclusiveArea: area };
    }
    stats.set(complexId, s);
    const list = isTrade ? trade : rent;
    if (list.length >= RECENT_LIMIT) continue;
    const monthly = num(row.r) ?? 0;
    list.push({
      id: String(row.id),
      complexId,
      aptName: String(row.apt_name ?? ""),
      kind: isTrade ? "trade" : monthly > 0 ? "monthly" : "jeonse",
      dealDate: String(row.deal_date),
      dealAmount: amount,
      monthlyRent: isTrade ? 0 : monthly,
      exclusiveArea: area,
      floor: num(row.floor),
    });
  }

  let bjdongCd: string | null = null;
  let sigungu: string | null = null;
  const complexes: RegionDongComplex[] = masterRows.rows.map((row) => {
    const complexId = String(row.complex_id);
    const s = stats.get(complexId);
    bjdongCd ??= row.bjdong_cd == null ? null : String(row.bjdong_cd);
    sigungu ??= row.sigungu == null ? null : String(row.sigungu);
    const hh = num(row.hh);
    return {
      complexId,
      aptName: s?.name ?? String(row.apt_name ?? ""),
      householdCount: hh != null && hh > 0 ? Math.round(hh) : null,
      buildYear: yearOf(row.approval_date) ?? s?.buildYear ?? null,
      lat: num(row.lat),
      lng: num(row.lng),
      trades12m: s?.trades ?? 0,
      latestTrade: s?.latest ?? null,
    };
  });
  complexes.sort(
    (a, b) =>
      (b.householdCount ?? 0) - (a.householdCount ?? 0) ||
      b.trades12m - a.trades12m ||
      a.aptName.localeCompare(b.aptName, "ko"),
  );

  return {
    status: "ok",
    lawdCd,
    dong,
    bjdongCd: bjdongCd && /^[0-9]{5}$/.test(bjdongCd) ? bjdongCd : null,
    sigungu,
    complexes,
    recentDeals: { trade, rent },
    windowFrom,
  };
}

export async function readRegionDongOverview(
  db: RankingReader,
  lawdCd: string,
  dong: string,
): Promise<RegionDongOverview> {
  const key = regionScopeKey({ lawdCd, dong });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = computeRegionDongOverview(db, lawdCd, dong)
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/**
 * 여러 구로 나뉜 시(수원시 등)에서 법정동이 속한 구 코드를 찾는다.
 * 단지 마스터의 (lawd_cd) 인덱스 범위만 읽는다.
 */
export async function resolveDongLawdCd(
  db: RankingReader,
  lawdCodes: readonly string[],
  dong: string,
): Promise<string | null> {
  const codes = lawdCodes.filter((c) => /^[0-9]{5}$/.test(c));
  if (!codes.length) return null;
  if (codes.length === 1) return codes[0]!;
  const result = await db.execute({
    sql: `SELECT lawd_cd FROM apt_complex_master
          WHERE lawd_cd IN (${codes.map(() => "?").join(",")}) AND legal_dong_name = ?
          GROUP BY lawd_cd ORDER BY COUNT(*) DESC LIMIT 1`,
    args: [...codes, dong],
  });
  const code = result.rows[0]?.lawd_cd;
  return code == null ? null : String(code);
}
