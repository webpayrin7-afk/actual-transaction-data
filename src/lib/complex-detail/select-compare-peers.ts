/**
 * Auto-select up to 2 nearby/similar complexes for detail compare.
 * Bounded catalog + transaction queries only — no full scans.
 */
import { getDb } from "@/lib/db/client";
import { normalizeAptName } from "@/lib/db/repository";
import {
  ALL_REGIONS,
  districtNameFromCode,
  type RegionDef,
} from "@/lib/constants/regions";
// regionFromGu mirrors molit/apt (not exported).

export type ComparePeerCandidate = {
  aptName: string;
  regionSlug: string;
  gu: string;
  dong: string;
  sameLegalDong: boolean;
  bestExclusiveArea: number | null;
  areaGap: number | null;
  buildYear: number | null;
  householdCount: number | null;
  latestDealDate: string;
  dealCount: number;
};

export type SelectComparePeersInput = {
  aptName: string;
  gu: string;
  dong: string;
  /** Target exclusive ㎡ center from current area selection */
  targetExclusiveCenter: number | null;
  buildYear: number | null;
  householdCount: number | null;
  limit?: number;
};

function regionFromGu(gu: string): RegionDef | undefined {
  return ALL_REGIONS.find((r) => {
    if (r.metro === "seoul") return gu.includes(r.name) || r.name === gu;
    return (
      gu.includes(r.name) ||
      r.districts.some((d) => gu.includes(d.name) || d.name === gu)
    );
  });
}

let lawdCodesByGu: Map<string, string[]> | null = null;

/**
 * transactions.gu 는 적재 시 districtNameFromCode(sggCd|lawdCd) 로만 채워진다.
 * 그 역(표시명 → 법정동코드)으로 lawd_cd 를 좁혀 idx_tx_trade_lawd_apt_ym 범위 검색을
 * 하게 한다. gu = ? 조건은 그대로 두므로 결과 행은 gu 만으로 거른 것과 같다.
 * (2026-09-26 전체 매매 5.09M 행 검증: gu 가 비어 있지 않은 행은 모두
 * gu = districtNameFromCode(lawd_cd).)
 */
function lawdCodesForGu(gu: string): string[] {
  if (!lawdCodesByGu) {
    const map = new Map<string, string[]>();
    for (const region of ALL_REGIONS) {
      for (const d of region.districts) {
        const name = districtNameFromCode(d.code);
        if (!name) continue;
        const list = map.get(name) ?? [];
        if (!list.includes(d.code)) list.push(d.code);
        map.set(name, list);
      }
    }
    lawdCodesByGu = map;
  }
  return lawdCodesByGu.get(gu) ?? [];
}

function asStr(v: unknown): string {
  return v == null ? "" : String(v);
}

function asNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type CatalogRow = {
  aptName: string;
  aptNameNorm: string;
  gu: string;
  dong: string;
  dealCount: number;
  latestDealDate: string;
  sameLegalDong: boolean;
};

/**
 * Deterministic peer pick: same legalDong > same sigungu,
 * then area / build-year / household proximity. Recent deals required.
 */
export async function selectComparePeers(
  input: SelectComparePeersInput,
): Promise<ComparePeerCandidate[]> {
  const db = getDb();
  if (!db) return [];

  const aptName = input.aptName.trim();
  const gu = input.gu.trim();
  const dong = input.dong.trim();
  if (!aptName || !gu) return [];

  const selfNorm = normalizeAptName(aptName);
  const limit = Math.min(Math.max(input.limit ?? 2, 1), 2);
  const targetCenter = input.targetExclusiveCenter;

  // 1) Bounded catalog: legalDong first, then same gu.
  const dongRows =
    dong.length > 0
      ? (
          await db.execute({
            sql: `SELECT apt_name, apt_name_norm, gu, dong, deal_count, latest_deal_date
                  FROM apt_catalog
                  WHERE gu = ? AND dong = ? AND apt_name_norm != ?
                    AND deal_count > 0
                  ORDER BY latest_deal_date DESC
                  LIMIT 30`,
            args: [gu, dong, selfNorm],
          })
        ).rows
      : [];

  const needGu = dongRows.length < 12;
  const guRows = needGu
    ? (
        await db.execute({
          sql: `SELECT apt_name, apt_name_norm, gu, dong, deal_count, latest_deal_date
                FROM apt_catalog
                WHERE gu = ? AND apt_name_norm != ?
                  AND deal_count > 0
                ORDER BY latest_deal_date DESC
                LIMIT 24`,
          args: [gu, selfNorm],
        })
      ).rows
    : [];

  const byNorm = new Map<string, CatalogRow>();
  for (const row of dongRows) {
    const norm = asStr(row.apt_name_norm);
    if (!norm || byNorm.has(norm)) continue;
    byNorm.set(norm, {
      aptName: asStr(row.apt_name),
      aptNameNorm: norm,
      gu: asStr(row.gu),
      dong: asStr(row.dong),
      dealCount: asNum(row.deal_count) ?? 0,
      latestDealDate: asStr(row.latest_deal_date),
      sameLegalDong: true,
    });
  }
  for (const row of guRows) {
    const norm = asStr(row.apt_name_norm);
    if (!norm || byNorm.has(norm)) continue;
    const rowDong = asStr(row.dong);
    byNorm.set(norm, {
      aptName: asStr(row.apt_name),
      aptNameNorm: norm,
      gu: asStr(row.gu),
      dong: rowDong,
      dealCount: asNum(row.deal_count) ?? 0,
      latestDealDate: asStr(row.latest_deal_date),
      sameLegalDong: dong.length > 0 && rowDong === dong,
    });
  }

  const catalog = [...byNorm.values()];
  if (catalog.length === 0) return [];

  const norms = catalog.map((c) => c.aptNameNorm);
  const ph = norms.map(() => "?").join(",");

  // 2) Area + build year from recent trades of these candidates only (bounded IN list).
  // gu 만 주면 통계 없는 플래너가 deal_type 인덱스로 전국 매매를 훑는다(10~30초, 504).
  // gu 의 법정동코드로 (lawd_cd, apt_name_norm) 매매 부분 인덱스를 타게 한다 — 기간 제한
  // 없이 같은 행·같은 집계(비교 결과 동일). 코드를 모르는 gu 만 예전 쿼리로 둔다.
  const lawdCodes = lawdCodesForGu(gu);
  const areaRes = await db.execute(
    lawdCodes.length > 0
      ? {
          sql: `SELECT apt_name_norm, exclusive_area, build_year, COUNT(*) AS c
                FROM transactions INDEXED BY idx_tx_trade_lawd_apt_ym
                WHERE lawd_cd IN (${lawdCodes.map(() => "?").join(",")})
                  AND apt_name_norm IN (${ph}) AND deal_type = 'trade'
                  AND gu = ? AND exclusive_area > 0
                GROUP BY apt_name_norm, exclusive_area, build_year
                ORDER BY c DESC
                LIMIT 400`,
          args: [...lawdCodes, ...norms, gu],
        }
      : {
          sql: `SELECT apt_name_norm, exclusive_area, build_year, COUNT(*) AS c
                FROM transactions
                WHERE gu = ? AND apt_name_norm IN (${ph}) AND deal_type = 'trade'
                  AND exclusive_area > 0
                GROUP BY apt_name_norm, exclusive_area, build_year
                ORDER BY c DESC
                LIMIT 400`,
          args: [gu, ...norms],
        },
  );

  type AreaAgg = {
    bestArea: number | null;
    areaGap: number | null;
    buildYear: number | null;
  };
  const areaByNorm = new Map<string, AreaAgg>();
  for (const row of areaRes.rows) {
    const norm = asStr(row.apt_name_norm);
    const area = asNum(row.exclusive_area);
    const by = asNum(row.build_year);
    if (!norm || area == null) continue;
    const gap =
      targetCenter != null && Number.isFinite(targetCenter)
        ? Math.abs(area - targetCenter)
        : null;
    const prev = areaByNorm.get(norm);
    if (!prev) {
      areaByNorm.set(norm, { bestArea: area, areaGap: gap, buildYear: by });
      continue;
    }
    if (
      gap != null &&
      (prev.areaGap == null || gap < prev.areaGap - 0.0001)
    ) {
      areaByNorm.set(norm, {
        bestArea: area,
        areaGap: gap,
        buildYear: by ?? prev.buildYear,
      });
    } else if (prev.buildYear == null && by != null) {
      areaByNorm.set(norm, { ...prev, buildYear: by });
    }
  }

  // 3) Optional household counts from master/profile (same gu/dong scope).
  // Profile coverage is sparse — only attach when household_count > 0.
  // Missing values are omitted from UI and skipped in household-gap scoring.
  const householdByNorm = new Map<string, number>();
  try {
    const masterRes =
      dong.length > 0
        ? await db.execute({
            sql: `SELECT m.apt_name, p.household_count
                  FROM apt_complex_master m
                  LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
                  WHERE m.sigungu = ? AND m.legal_dong_name = ?
                    AND p.household_count IS NOT NULL AND p.household_count > 0
                  LIMIT 60`,
            args: [gu, dong],
          })
        : await db.execute({
            sql: `SELECT m.apt_name, p.household_count
                  FROM apt_complex_master m
                  LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
                  WHERE m.sigungu = ?
                    AND p.household_count IS NOT NULL AND p.household_count > 0
                  LIMIT 80`,
            args: [gu],
          });
    for (const row of masterRes.rows) {
      const norm = normalizeAptName(asStr(row.apt_name));
      const hh = asNum(row.household_count);
      if (norm && hh != null && hh > 0) householdByNorm.set(norm, hh);
    }
  } catch {
    // Master/profile may be unavailable — scoring continues without households.
  }

  const MAX_AREA_GAP = 18; // refuse silent 84↔114 style matches at selection time

  const scored = catalog
    .map((c) => {
      const agg = areaByNorm.get(c.aptNameNorm);
      const areaGap = agg?.areaGap ?? null;
      const bestArea = agg?.bestArea ?? null;
      const buildYear = agg?.buildYear ?? null;
      const householdCount = householdByNorm.get(c.aptNameNorm) ?? null;

      // Prefer candidates with a usable area match when target is known.
      if (
        targetCenter != null &&
        areaGap != null &&
        areaGap > MAX_AREA_GAP
      ) {
        return null;
      }
      // Soft-exclude when we have a target but no area signal at all.
      if (targetCenter != null && areaGap == null) {
        return null;
      }

      let score = 0;
      if (c.sameLegalDong) score += 1_000_000;
      score += Math.min(c.dealCount, 5_000); // recent-trade presence
      if (areaGap != null) score -= Math.round(areaGap * 1_000);
      if (
        input.buildYear != null &&
        buildYear != null &&
        input.buildYear > 0 &&
        buildYear > 0
      ) {
        score -= Math.abs(input.buildYear - buildYear) * 80;
      }
      if (
        input.householdCount != null &&
        householdCount != null &&
        input.householdCount > 0 &&
        householdCount > 0
      ) {
        const hhGap = Math.abs(input.householdCount - householdCount);
        score -= Math.min(hhGap, 8_000) * 0.05;
      }

      const region = regionFromGu(c.gu);
      if (!region) return null;

      return {
        peer: {
          aptName: c.aptName,
          regionSlug: region.slug,
          gu: c.gu,
          dong: c.dong,
          sameLegalDong: c.sameLegalDong,
          bestExclusiveArea: bestArea,
          areaGap,
          buildYear,
          householdCount,
          latestDealDate: c.latestDealDate,
          dealCount: c.dealCount,
        } satisfies ComparePeerCandidate,
        score,
        latestDealDate: c.latestDealDate,
      };
    })
    .filter(Boolean) as Array<{
    peer: ComparePeerCandidate;
    score: number;
    latestDealDate: string;
  }>;

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.latestDealDate.localeCompare(a.latestDealDate);
  });

  return scored.slice(0, limit).map((s) => s.peer);
}
