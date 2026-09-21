/**
 * Ranking V3 constants and decade helpers.
 * Region decade cohorts match price-position V2.2 supply labels.
 */
import { DECADE_COHORTS_V22, decadeCohortForLabel, type DecadeCohortV22 } from "./price-position-v22";

export const RANKING_V3_VERSION = "seoul-ranking-v3";
export const FEATURE_VERSION_V3 = "region-feature-v3";
export const AREA_BAND_VERSION_V3 = "SUPPLY_PYEONG_DECADE_V1";
export const RANKING_V3_AS_OF = "2026-09-17";
export const RANKING_V3_PERIOD = "12M";

export const METHODOLOGY_FINGERPRINT_V3 =
  "v3|canonical-universe|no-activity-hard-exclude|decade-supply-cohort|normalized-overall-mean|interest-inactive|missing-aware-price|12M-activity";

export const DECADE_COHORTS_V3 = DECADE_COHORTS_V22;
export type DecadeCohortV3 = DecadeCohortV22;
export type DecadeKeyV3 = DecadeCohortV3["key"];

export const LEGACY_BAND_TO_DECADE_V3: Record<string, DecadeKeyV3> = {
  "59": "20",
  "84": "30",
  "114": "40",
};

export { decadeCohortForLabel };

export function decadeKeyFromRankingBand(areaBand: string): DecadeKeyV3 | "ALL" | null {
  if (areaBand === "ALL") return "ALL";
  return LEGACY_BAND_TO_DECADE_V3[areaBand] ?? (DECADE_COHORTS_V3.find((row) => row.key === areaBand)?.key ?? null);
}

export type HardExcludeReasonV3 =
  | "AMBIGUOUS_IDENTITY"
  | "MISSING_BJDONG"
  | "CORRUPT_MASTER_IDENTITY";

export type ComponentAvailabilityV3 = "AVAILABLE" | "STALE_BUT_USABLE" | "MISSING";

export type CoverageStatusV3 =
  | "FULL"
  | "PARTIAL"
  | "SPARSE"
  | "IDENTITY_ONLY";
