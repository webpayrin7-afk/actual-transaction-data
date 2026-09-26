import { getRegion, type RegionDef } from "@/lib/constants/regions";
import type { MetroType, RegType } from "@/lib/loan/calc";

/**
 * Complex-derived loan conditions for the complex-detail calculator.
 *
 * Metro: region registry (서울·경기·인천 → 수도권).
 * Regulated: same FSC designation snapshot referenced by LoanLimitCalculator
 * (policy geography as of 2026-07). No ad-hoc inventing of new policy geography.
 */

/** User-facing policy basis for regulated-area geography (not a DB refresh label). */
export const LOAN_PROPERTY_CONDITION_SOURCE =
  "2026년 7월 금융 규제 기준";

/** Fully regulated Gyeonggi city slugs (entire city under snapshot). */
const REGULATED_FULL_SLUGS = new Set([
  "gyeonggi-gwacheon",
  "gyeonggi-gwangmyeong",
  "gyeonggi-guri",
  "gyeonggi-hanam",
  "gyeonggi-uiwang",
  "gyeonggi-seongnam", // 분당·수정·중원
]);

/**
 * Partial-city regulation by LAWD (시군구 5자리).
 * Snapshot: 수원 장안·팔달·영통 / 안양 동안 / 용인 기흥·수지 / 화성 동탄
 */
const REGULATED_LAWD_CODES = new Set([
  "41111", // 수원 장안
  "41115", // 수원 팔달
  "41117", // 수원 영통
  "41173", // 안양 동안
  "41463", // 용인 기흥
  "41465", // 용인 수지
  "41597", // 화성 동탄
]);

const PARTIAL_REGULATED_SLUGS = new Set([
  "gyeonggi-suwon",
  "gyeonggi-anyang",
  "gyeonggi-yongin",
  "gyeonggi-hwaseong",
]);

export type LoanPropertyConditions = {
  metro: MetroType;
  regulated: RegType;
  /** e.g. 서울특별시 송파구 */
  regionLabel: string;
  metroLabel: string;
  regulatedLabel: string;
  /** true when partial-city regulation lacked a LAWD and was left conservative */
  regulatedUnresolved: boolean;
  sourceNote: string;
  regionSlug: string | null;
};

function isCapitalMetro(metro: RegionDef["metro"] | undefined): boolean {
  return metro === "seoul" || metro === "gyeonggi" || metro === "incheon";
}

function resolveRegulated(
  region: RegionDef | undefined,
  lawdCd: string | null | undefined,
): { regulated: RegType; unresolved: boolean } {
  if (!region) {
    return { regulated: "unregulated", unresolved: true };
  }

  // Seoul — all districts regulated under the shared snapshot.
  if (region.metro === "seoul" || REGULATED_FULL_SLUGS.has(region.slug)) {
    return { regulated: "regulated", unresolved: false };
  }

  if (PARTIAL_REGULATED_SLUGS.has(region.slug)) {
    const code = (lawdCd ?? "").trim().slice(0, 5);
    if (code && /^\d{5}$/.test(code)) {
      return {
        regulated: REGULATED_LAWD_CODES.has(code)
          ? "regulated"
          : "unregulated",
        unresolved: false,
      };
    }
    // Do not invent “비규제” when the city is only partially listed.
    return { regulated: "regulated", unresolved: true };
  }

  if (lawdCd) {
    const code = lawdCd.trim().slice(0, 5);
    if (REGULATED_LAWD_CODES.has(code)) {
      return { regulated: "regulated", unresolved: false };
    }
  }

  return { regulated: "unregulated", unresolved: false };
}

export function resolveLoanPropertyConditions(input: {
  regionSlug?: string | null;
  lawdCd?: string | null;
  locationLabel?: string | null;
}): LoanPropertyConditions {
  const slug = input.regionSlug?.trim() || null;
  const region = slug ? getRegion(slug) : undefined;
  const capital = isCapitalMetro(region?.metro);
  const { regulated, unresolved } = resolveRegulated(region, input.lawdCd);

  const regionLabel =
    input.locationLabel?.trim() ||
    region?.fullName ||
    (slug ? slug : "지역 정보 없음");

  return {
    metro: capital ? "capital" : "local",
    regulated,
    regionLabel,
    metroLabel: capital ? "수도권" : "지방",
    regulatedLabel: regulated === "regulated" ? "규제지역" : "비규제지역",
    regulatedUnresolved: unresolved,
    sourceNote: LOAN_PROPERTY_CONDITION_SOURCE,
    regionSlug: slug,
  };
}
