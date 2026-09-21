/**
 * Sample confidence v2 — UI copy and status names only.
 * Scoring lives in CORE. This module does not grade samples.
 */
export const SAMPLE_CONFIDENCE_VERSION = "sample-confidence-v2";

export type SampleStatusV2 =
  | "SAMPLE_ADEQUATE"
  | "SAMPLE_LIMITED"
  | "SAMPLE_SEVERELY_LIMITED"
  | "HORIZON_UNAVAILABLE";

/** UI copy. ADEQUATE and unavailable render no sample chip. */
export const SAMPLE_STATUS_COPY_V2: Record<SampleStatusV2, string | null> = {
  SAMPLE_ADEQUATE: null,
  SAMPLE_LIMITED: "표본 제한",
  SAMPLE_SEVERELY_LIMITED: "참고용",
  HORIZON_UNAVAILABLE: null,
};

export function isSampleStatusV2(value: unknown): value is SampleStatusV2 {
  return (
    value === "SAMPLE_ADEQUATE" ||
    value === "SAMPLE_LIMITED" ||
    value === "SAMPLE_SEVERELY_LIMITED" ||
    value === "HORIZON_UNAVAILABLE"
  );
}
