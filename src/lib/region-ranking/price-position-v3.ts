/**
 * Price Position V3 candidate (audit/proposal only).
 * Not wired to public read. V2.3.2 remains the live pointer.
 *
 * Product: 지역 대표 평당가
 * = median of equal-weight complex monthly means, each complex using its
 *   latest usable mapped trade month (≤ as-of) within the regional decade cohort.
 *
 * Does not change regional trend / sample-confidence-v2.
 */
export const PRICE_POSITION_V3_VERSION = "price-position-v3";
export const PRICE_POSITION_V3_AS_OF = "2026-09-17";

export const REGION_PRICE_DEFINITION_V3 =
  "median_of_canonical_complex_latest_active_month_means_equal_weight" as const;

export const METHODOLOGY_FINGERPRINT_V3 =
  "v3|P2-median-complex-means|latest-active|equal-complex-weight|canonical-cohort|complex-exact-endpoint-s1|region-trailing-6m-pooled-mean-UNCHANGED|horizons-6M-1Y-2Y-5Y-UNCHANGED" as const;

/** Soft-stale metadata thresholds (policy B). Hard exclusion is not the default. */
export const V3_SOFT_STALE = {
  /** Flag cell when share of contributors older than 12M ≥ this. */
  shareGt12: 0.25,
  /** Flag cell when share of contributors older than 24M ≥ this. */
  shareGt24: 0.15,
  /** Flag cell when contributor age median ≥ this many months. */
  medianAgeMonths: 6,
} as const;

/** Optional hard cap candidate (policy C). Not the default recommendation. */
export const V3_HARD_MAX_AGE_MONTHS = 24;

export function pricePositionV3SnapshotId(asOf: string = PRICE_POSITION_V3_AS_OF): string {
  return `${PRICE_POSITION_V3_VERSION}|${asOf}`;
}
