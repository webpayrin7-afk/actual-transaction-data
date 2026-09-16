/**
 * Pilot-only K-apt residential-exclusive 원/㎡ fixtures.
 * No runtime web fetch. No production crawl / DB write.
 * Phase 2.4 verified rates for 잠실엘스 (A13822004) only.
 */

export type KaptAreaBasis = "residential_exclusive";

export type KaptAreaFeeMonth = {
  /** YYYYMM */
  month: string;
  commonPerM2: number | null;
  individualPerM2: number | null;
  reservePerM2: number | null;
  totalPerM2: number;
};

export type KaptVerifiedPeriodAverage = {
  id: string;
  kind: "winter" | "summer" | "trailing_average";
  /** Months covered by this verified average (documentation / UI). */
  months: string[];
  avgTotalPerM2: number;
  monthCount: number;
  endMonth?: string;
};

export type KaptAreaFeeFixture = {
  source: "K-apt";
  kaptCode: string;
  complexName: string;
  /** Match keys (normalized name / complex_id). */
  matchAptNameNorms: string[];
  matchComplexIds: string[];
  areaBasis: KaptAreaBasis;
  areaBasisLabelKo: string;
  verifiedAt: string;
  sourceNote: string;
  months: KaptAreaFeeMonth[];
  /**
   * Verified period averages when full month-by-month rates are not stored.
   * Do not invent missing monthly rows to back into these averages.
   */
  verifiedPeriodAverages: KaptVerifiedPeriodAverage[];
};

/** 잠실엘스 — Phase 2.4 verified residential-exclusive 원/㎡. */
export const JAMSIL_ELS_AREA_FEE_FIXTURE: KaptAreaFeeFixture = {
  source: "K-apt",
  kaptCode: "A13822004",
  complexName: "잠실엘스",
  matchAptNameNorms: ["잠실엘스", "잠실엘스아파트"],
  matchComplexIds: ["cx_4c63d9a100973c60"],
  areaBasis: "residential_exclusive",
  areaBasisLabelKo: "주거전용면적",
  verifiedAt: "2026-09-14",
  sourceNote:
    "Phase 2.4 verified K-apt 주거전용면적 기준 원/㎡. Pilot fixture only — commercial redisplay / auto-collection still HOLD.",
  months: [
    {
      month: "202607",
      commonPerM2: 1469.07,
      individualPerM2: 2063.08,
      reservePerM2: 473.73,
      totalPerM2: 4005.88,
    },
    {
      month: "202606",
      // Component rates not separately verified for this month in Phase 2.4 brief.
      commonPerM2: null,
      individualPerM2: null,
      reservePerM2: null,
      totalPerM2: 3569.35,
    },
  ],
  verifiedPeriodAverages: [
    {
      id: "winter_2026",
      kind: "winter",
      months: ["202512", "202601", "202602"],
      avgTotalPerM2: 5483.72,
      monthCount: 3,
    },
    {
      id: "trailing_12_ending_202607",
      kind: "trailing_average",
      months: [],
      endMonth: "202607",
      monthCount: 12,
      avgTotalPerM2: 4258.28,
    },
  ],
};

const PILOT_FIXTURES: KaptAreaFeeFixture[] = [JAMSIL_ELS_AREA_FEE_FIXTURE];

function normName(name: string | null | undefined): string {
  return (name ?? "").replace(/\s+/g, "").trim();
}

/** Resolve pilot fixture by kapt code, complex id, or apt name. */
export function findKaptAreaFeeFixture(params: {
  kaptCode?: string | null;
  complexId?: string | null;
  aptName?: string | null;
}): KaptAreaFeeFixture | null {
  const kapt = params.kaptCode?.trim();
  if (kapt) {
    const byKapt = PILOT_FIXTURES.find((f) => f.kaptCode === kapt);
    if (byKapt) return byKapt;
  }
  const cid = params.complexId?.trim();
  if (cid) {
    const byId = PILOT_FIXTURES.find((f) => f.matchComplexIds.includes(cid));
    if (byId) return byId;
  }
  const name = normName(params.aptName);
  if (name) {
    const byName = PILOT_FIXTURES.find((f) =>
      f.matchAptNameNorms.some((n) => n === name || name.startsWith(n)),
    );
    if (byName) return byName;
  }
  return null;
}
