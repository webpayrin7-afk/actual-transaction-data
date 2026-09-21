/**
 * Sample confidence v2 for price-position V2.3.
 * Does not change price level, complex S1, or the regional median.
 * B is the canonical supply set intersected with usable trade history.
 */
export const SAMPLE_CONFIDENCE_VERSION = "sample-confidence-v2";

export type SampleStatusV2 =
  | "SAMPLE_ADEQUATE"
  | "SAMPLE_LIMITED"
  | "SAMPLE_SEVERELY_LIMITED"
  | "HORIZON_UNAVAILABLE";

export type DataCoverageStatusV2 =
  | "DATA_COVERAGE_LOW"
  | "DATA_COVERAGE_LIMITED"
  | "DATA_COVERAGE_ADEQUATE";

/** UI copy. ADEQUATE and unavailable render no sample chip. */
export const SAMPLE_STATUS_COPY_V2: Record<SampleStatusV2, string | null> = {
  SAMPLE_ADEQUATE: null,
  SAMPLE_LIMITED: "표본 제한",
  SAMPLE_SEVERELY_LIMITED: "참고용",
  HORIZON_UNAVAILABLE: null,
};

/**
 * Window availability is decided before the sample grade.
 * A null comparison window is never a sample warning.
 * Severe: C < 5 or C/B < 10%.
 * Adequate: (C >= 10 and C/B >= 20%) or (C >= 8 and C/B >= 80%).
 * Everything else with a window is limited.
 */
export function sampleStatusV2(params: {
  windowAvailable: boolean;
  matched: number;
  canonicalHistory: number;
}): SampleStatusV2 {
  if (!params.windowAvailable) return "HORIZON_UNAVAILABLE";
  const matched = params.matched;
  const history = params.canonicalHistory;
  const ratio = history > 0 ? matched / history : 0;
  if (matched < 5 || ratio < 0.1) return "SAMPLE_SEVERELY_LIMITED";
  if ((matched >= 10 && ratio >= 0.2) || (matched >= 8 && ratio >= 0.8)) return "SAMPLE_ADEQUATE";
  return "SAMPLE_LIMITED";
}

/** B/A diagnostic. Does not affect sampleStatus. Null when the supply universe is empty. */
export function dataCoverageStatusV2(canonicalHistory: number, cohortUniverse: number): DataCoverageStatusV2 | null {
  if (!(cohortUniverse > 0)) return null;
  const ratio = canonicalHistory / cohortUniverse;
  if (ratio < 0.15) return "DATA_COVERAGE_LOW";
  if (ratio < 0.3) return "DATA_COVERAGE_LIMITED";
  return "DATA_COVERAGE_ADEQUATE";
}
