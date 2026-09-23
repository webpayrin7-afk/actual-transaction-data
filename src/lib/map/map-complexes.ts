/**
 * 지도로 찾기 — 화면 영역(bbox) 안 단지의 좌표 + 최근 매매 요약. 읽기 전용.
 * 좌표: apt_complex_master.latitude/longitude. 가격: transactions (lawd_cd, apt_name_norm, year_month) 인덱스.
 * 추정·보간 없음 — 기간 안 거래가 없으면 가격 없이 이름만 보낸다.
 */
import type { Client } from "@libsql/client";
import { LAWD_TO_REGION, districtNameFromCode } from "@/lib/constants/regions-registry";
import { slugFromLawd } from "@/lib/constants/nationwide-lawd";
import { aptDetailHref } from "@/lib/molit/apt-client";

export type MapAreaBand = "all" | "small" | "mid" | "large";

/** 전용면적 기준 구간 (㎡). 소형 <60, 중형 60~85, 대형 >85. */
export const MAP_AREA_BANDS: Record<MapAreaBand, { label: string; min: number; max: number }> = {
  all: { label: "전체", min: 0, max: 10_000 },
  small: { label: "소형", min: 0, max: 60 },
  mid: { label: "중형", min: 60, max: 85.99 },
  large: { label: "대형", min: 86, max: 10_000 },
};

export type MapBBox = { swLat: number; swLng: number; neLat: number; neLng: number };

export type MapComplex = {
  complexId: string;
  aptName: string;
  lat: number;
  lng: number;
  dong: string | null;
  householdCount: number | null;
  href: string;
  /** 최근 12개월 선택 구간 매매 중위가 (만원) */
  medianPriceMan: number | null;
  tradeCount12m: number;
  latestDealDate: string | null;
  latestPriceMan: number | null;
};

export const MAP_MAX_COMPLEXES = 400;
const WINDOW_MONTHS = 12;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function yearMonthMonthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function regionSlugFor(lawdCd: string): string {
  return LAWD_TO_REGION[lawdCd]?.slug ?? slugFromLawd("", lawdCd);
}

export async function readMapComplexes(
  db: Client,
  bbox: MapBBox,
  band: MapAreaBand,
): Promise<{ complexes: MapComplex[]; truncated: boolean }> {
  const master = await db.execute({
    // 영역에 단지가 많으면 세대수 큰 단지부터 (호갱노노처럼 주요 단지가 먼저 보이게).
    sql: `SELECT m.complex_id, m.apt_name, m.apt_name_norm, m.lawd_cd, m.legal_dong_name, m.sigungu,
                 m.latitude, m.longitude, p.household_count
          FROM apt_complex_master m
          LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
          WHERE m.latitude BETWEEN ? AND ? AND m.longitude BETWEEN ? AND ?
          ORDER BY COALESCE(p.household_count, 0) DESC
          LIMIT ?`,
    args: [bbox.swLat, bbox.neLat, bbox.swLng, bbox.neLng, MAP_MAX_COMPLEXES + 1],
  });
  const truncated = master.rows.length > MAP_MAX_COMPLEXES;
  const rows = master.rows.slice(0, MAP_MAX_COMPLEXES);
  if (rows.length === 0) return { complexes: [], truncated: false };

  const { min, max } = MAP_AREA_BANDS[band];
  const since = yearMonthMonthsAgo(WINDOW_MONTHS);
  const deals = new Map<string, Array<{ amount: number; date: string }>>();
  const keyOf = (lawd: unknown, norm: unknown) => `${String(lawd)}|${String(norm)}`;

  // lawd_cd별로 묶어 `lawd_cd = ? AND apt_name_norm IN (...)` — idx_tx_lawd_apt_ym 를 그대로 탄다.
  // (행 값 IN (VALUES …) 형태는 인덱스를 못 타 30초 넘게 걸렸다.)
  const wanted = new Set(rows.map((r) => keyOf(r.lawd_cd, r.apt_name_norm)));
  const byLawd = new Map<string, string[]>();
  for (const r of rows) {
    const list = byLawd.get(String(r.lawd_cd)) ?? [];
    list.push(String(r.apt_name_norm));
    byLawd.set(String(r.lawd_cd), list);
  }
  const jobs: Array<Promise<void>> = [];
  for (const [lawd, names] of byLawd) {
    for (let i = 0; i < names.length; i += 80) {
      const slice = names.slice(i, i + 80);
      jobs.push(
        db
          .execute({
            sql: `SELECT lawd_cd, apt_name_norm, deal_amount, deal_date
                  FROM transactions
                  WHERE lawd_cd = ? AND apt_name_norm IN (${slice.map(() => "?").join(",")})
                    AND year_month >= ? AND deal_type = 'trade'
                    AND exclusive_area >= ? AND exclusive_area <= ?`,
            args: [lawd, ...slice, since, min, max],
          })
          .then((res) => {
            for (const r of res.rows) {
              const k = keyOf(r.lawd_cd, r.apt_name_norm);
              if (!wanted.has(k)) continue;
              const list = deals.get(k) ?? [];
              list.push({ amount: Number(r.deal_amount), date: String(r.deal_date) });
              deals.set(k, list);
            }
          }),
      );
    }
  }
  await Promise.all(jobs);

  const complexes: MapComplex[] = rows.map((r) => {
    const lawd = String(r.lawd_cd);
    const list = (deals.get(keyOf(r.lawd_cd, r.apt_name_norm)) ?? []).filter((d) => d.amount > 0);
    const latest = list.reduce<{ amount: number; date: string } | null>(
      (acc, d) => (!acc || d.date > acc.date ? d : acc),
      null,
    );
    const gu = (r.sigungu ? String(r.sigungu).split(/\s+/).pop() : null) || districtNameFromCode(lawd);
    return {
      complexId: String(r.complex_id),
      aptName: String(r.apt_name),
      lat: Number(r.latitude),
      lng: Number(r.longitude),
      dong: r.legal_dong_name ? String(r.legal_dong_name) : null,
      householdCount: r.household_count == null ? null : Number(r.household_count),
      href: aptDetailHref(String(r.apt_name), regionSlugFor(lawd), gu || undefined),
      medianPriceMan: median(list.map((d) => d.amount)),
      tradeCount12m: list.length,
      latestDealDate: latest?.date ?? null,
      latestPriceMan: latest?.amount ?? null,
    };
  });

  return { complexes, truncated };
}
