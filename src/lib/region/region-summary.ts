/**
 * 구 단위 아파트 요약 (read-only).
 * - 단지 수: apt_complex_master
 * - 세대수: apt_complex_profile.household_count, 없으면 평형별 세대수 합
 * - 평균 연차: 2024년 이후 실거래의 건축년도 (단지별 최댓값)
 * - 대표 평형: 평형별 세대수의 공급평 10평대 구간 중 최다 비중
 */
import type { RankingReader } from "@/lib/region-ranking/query";
import { marketPyeongLabelInteger } from "@/lib/unit-type/supply-label";
import { seoulToday } from "@/lib/market/time";

export type RegionAptSummary = {
  status: "ok";
  lawdCd: string;
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

export async function readRegionAptSummary(
  db: RankingReader,
  lawdCd: string,
): Promise<RegionAptSummary> {
  const hit = cache.get(lawdCd);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const today = seoulToday();
  const currentYear = Number(today.slice(0, 4));

  const [households, ages, units] = await Promise.all([
    db.execute({
      sql: `WITH u AS (
              SELECT u.complex_id, SUM(u.household_count) AS hh
              FROM unit_type_household_counts u
              JOIN apt_complex_master m ON m.complex_id = u.complex_id
              WHERE m.lawd_cd = ? AND u.household_count IS NOT NULL
              GROUP BY u.complex_id
            )
            SELECT COUNT(*) AS n,
                   SUM(CASE WHEN COALESCE(p.household_count, u.hh) IS NOT NULL THEN 1 ELSE 0 END) AS n_hh,
                   SUM(COALESCE(p.household_count, u.hh)) AS hh
            FROM apt_complex_master m
            LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
            LEFT JOIN u ON u.complex_id = m.complex_id
            WHERE m.lawd_cd = ?`,
      args: [lawdCd, lawdCd],
    }),
    db.execute({
      sql: `WITH by AS (
              SELECT apt_name_norm, dong, MAX(CAST(build_year AS INTEGER)) AS y
              FROM transactions
              WHERE lawd_cd = ? AND year_month >= ?
                AND build_year IS NOT NULL AND build_year <> ''
              GROUP BY apt_name_norm, dong
            )
            SELECT b.y AS y
            FROM apt_complex_master m
            JOIN by b ON b.apt_name_norm = m.apt_name_norm AND b.dong = m.legal_dong_name
            WHERE m.lawd_cd = ? AND b.y BETWEEN 1950 AND ?`,
      args: [lawdCd, BUILD_YEAR_SINCE, lawdCd, currentYear],
    }),
    db.execute({
      sql: `SELECT u.supply_cents AS supply_cents, u.household_count AS hh
            FROM unit_type_household_counts u
            JOIN apt_complex_master m ON m.complex_id = u.complex_id
            WHERE m.lawd_cd = ? AND u.ui_safe = 1
              AND u.household_count IS NOT NULL AND u.supply_cents > 0`,
      args: [lawdCd],
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
    complexCount,
    householdTotal,
    householdComplexCount,
    averageAgeYears,
    ageComplexCount: years.length,
    representativeDecade,
    asOfMonth: today.slice(0, 7),
  };
  cache.set(lawdCd, { at: Date.now(), value });
  return value;
}
