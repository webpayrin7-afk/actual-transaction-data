/**
 * 구(또는 법정동) 단위 아파트 요약 (read-only).
 * - 단지 수: apt_complex_master
 * - 세대수: apt_complex_profile.household_count, 없으면 평형별 세대수 합
 * - 평균 연차: 2024년 이후 실거래의 건축년도 (단지별 최댓값)
 * - 대표 평형: 평형별 세대수의 공급평 10평대 구간 중 최다 비중
 */
import type { RankingReader } from "@/lib/region-ranking/query";
import { marketPyeongLabelInteger } from "@/lib/unit-type/supply-label";
import { seoulToday } from "@/lib/market/time";
import {
  DONG_TX_FROM,
  DONG_TX_WHERE,
  lawdInSql,
  regionScopeKey,
  scopeLawdCodes,
} from "@/lib/region/region-scope";

export type RegionAptSummary = {
  status: "ok";
  lawdCd: string;
  /** 동 범위일 때만 존재. */
  dong?: string;
  complexCount: number;
  householdTotal: number | null;
  householdComplexCount: number;
  averageAgeYears: number | null;
  ageComplexCount: number;
  representativeDecade: { label: string; sharePct: number } | null;
  asOfMonth: string;
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const BUILD_YEAR_SINCE = "202401";
const cache = new Map<string, { at: number; value: RegionAptSummary }>();

function decadeLabel(decade: number): string {
  if (decade >= 100) return "100평대+";
  if (decade < 10) return "10평 미만";
  return `${decade}평대`;
}

/** 동 범위 build_year 쿼리: 동 단지만 인덱스(lawd_cd, apt_name_norm, year_month)로 읽는다. */
function dongAgesQuery(lawdCd: string, dong: string, currentYear: number) {
  return {
    sql: `SELECT MAX(CAST(t.build_year AS INTEGER)) AS y
          FROM ${DONG_TX_FROM}
          WHERE ${DONG_TX_WHERE}
            AND t.build_year IS NOT NULL AND t.build_year <> ''
          GROUP BY m.complex_id
          HAVING y BETWEEN 1950 AND ?`,
    args: [lawdCd, dong, BUILD_YEAR_SINCE, currentYear],
  };
}

/**
 * 구(또는 그 안 법정동) 아파트 요약. `dong`을 주면 같은 계산을
 * `apt_complex_master.legal_dong_name = dong` 단지로 좁힌다.
 */
export async function readRegionAptSummary(
  db: RankingReader,
  lawdCd: string,
  dong?: string | null,
): Promise<RegionAptSummary> {
  const key = regionScopeKey({ lawdCd, dong });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const today = seoulToday();
  const currentYear = Number(today.slice(0, 4));
  const dongSql = dong ? " AND m.legal_dong_name = ?" : "";
  const dongArgs = dong ? [dong] : [];
  // 여러 구로 나뉜 시는 모든 구를 함께 센다(동 범위는 구 하나).
  const masterLawd = lawdInSql("m.lawd_cd", lawdCd);
  const lawdArgs = scopeLawdCodes(lawdCd);

  const [households, ages, units] = await Promise.all([
    db.execute({
      sql: `WITH u AS (
              SELECT u.complex_id, SUM(u.household_count) AS hh
              FROM unit_type_household_counts u
              JOIN apt_complex_master m ON m.complex_id = u.complex_id
              WHERE ${masterLawd}${dongSql} AND u.household_count IS NOT NULL
              GROUP BY u.complex_id
            )
            SELECT COUNT(*) AS n,
                   SUM(CASE WHEN COALESCE(p.household_count, u.hh) IS NOT NULL THEN 1 ELSE 0 END) AS n_hh,
                   SUM(COALESCE(p.household_count, u.hh)) AS hh
            FROM apt_complex_master m
            LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
            LEFT JOIN u ON u.complex_id = m.complex_id
            WHERE ${masterLawd}${dongSql}`,
      args: [...lawdArgs, ...dongArgs, ...lawdArgs, ...dongArgs],
    }),
    db.execute(
      dong
        ? dongAgesQuery(lawdCd, dong, currentYear)
        : {
            sql: `WITH by AS (
              SELECT lawd_cd, apt_name_norm, dong, MAX(CAST(build_year AS INTEGER)) AS y
              FROM transactions
              WHERE ${lawdInSql("lawd_cd", lawdCd)} AND year_month >= ?
                AND build_year IS NOT NULL AND build_year <> ''
              GROUP BY lawd_cd, apt_name_norm, dong
            )
            SELECT b.y AS y
            FROM apt_complex_master m
            JOIN by b ON b.lawd_cd = m.lawd_cd AND b.apt_name_norm = m.apt_name_norm
             AND b.dong = m.legal_dong_name
            WHERE ${masterLawd} AND b.y BETWEEN 1950 AND ?`,
            args: [...lawdArgs, BUILD_YEAR_SINCE, ...lawdArgs, currentYear],
          },
    ),
    db.execute({
      sql: `SELECT u.supply_cents AS supply_cents, u.household_count AS hh
            FROM unit_type_household_counts u
            JOIN apt_complex_master m ON m.complex_id = u.complex_id
            WHERE ${masterLawd}${dongSql} AND u.ui_safe = 1
              AND u.household_count IS NOT NULL AND u.supply_cents > 0`,
      args: [...lawdArgs, ...dongArgs],
    }),
  ]);

  const hhRow = households.rows[0] ?? {};
  const complexCount = Number(hhRow.n ?? 0);
  const householdComplexCount = Number(hhRow.n_hh ?? 0);
  const householdTotal =
    hhRow.hh == null ? null : Math.round(Number(hhRow.hh));

  const years = ages.rows
    .map((row) => Number(row.y))
    .filter((y) => Number.isFinite(y));
  const averageAgeYears = years.length
    ? Math.round(
        (years.reduce((sum, y) => sum + (currentYear - y), 0) / years.length) *
          10,
      ) / 10
    : null;

  const byDecade = new Map<number, number>();
  let unitTotal = 0;
  for (const row of units.rows) {
    const label = marketPyeongLabelInteger(Number(row.supply_cents) / 100);
    const hh = Number(row.hh);
    if (label == null || !Number.isFinite(hh) || hh <= 0) continue;
    const decade = Math.min(100, Math.floor(label / 10) * 10);
    byDecade.set(decade, (byDecade.get(decade) ?? 0) + hh);
    unitTotal += hh;
  }
  let representativeDecade: RegionAptSummary["representativeDecade"] = null;
  if (unitTotal > 0) {
    const [decade, hh] = [...byDecade.entries()].sort((a, b) => b[1] - a[1])[0]!;
    representativeDecade = {
      label: decadeLabel(decade),
      sharePct: Math.round((hh / unitTotal) * 100),
    };
  }

  const value: RegionAptSummary = {
    status: "ok",
    lawdCd,
    ...(dong ? { dong } : {}),
    complexCount,
    householdTotal,
    householdComplexCount,
    averageAgeYears,
    ageComplexCount: years.length,
    representativeDecade,
    asOfMonth: today.slice(0, 7),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}
