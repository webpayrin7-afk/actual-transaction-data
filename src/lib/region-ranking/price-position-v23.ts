/**
 * Price position V2.3 / V2.3.1 public read pointers.
 * Does not score, materialize, or change P2 / S1 / window policy.
 * Public UI reads V2.3.1 only. V2.3 stays stored and is never a fallback.
 */
export const PRICE_POSITION_V23_VERSION = "price-position-v2.3";
export const PRICE_POSITION_V231_VERSION = "price-position-v2.3.1";
export const PRICE_POSITION_V23_AS_OF = "2026-09-17";

export const REGION_TREND_DEFINITION_V23 =
  "median_of_matched_complex_changes_trailing_6m_pooled_mean" as const;

export const REGION_TREND_DEFINITION_V231 =
  "median_of_canonical_matched_complex_changes_trailing_6m_pooled_mean" as const;

export const METHODOLOGY_FINGERPRINT_V23 =
  "v2.3|P2-median-complex-means|T0-matched-median-change|complex-exact-endpoint-s1|region-trailing-6m-pooled-mean|symmetric-history-floor|region-all-decade-cohorts|horizons-6M-1Y-2Y-5Y";

export const METHODOLOGY_FINGERPRINT_V231 =
  `${METHODOLOGY_FINGERPRINT_V23}|canonical-cohort-contributors` as const;

export function pricePositionV23SnapshotId(asOf: string = PRICE_POSITION_V23_AS_OF): string {
  return `${PRICE_POSITION_V23_VERSION}|${asOf}`;
}

export function pricePositionV231SnapshotId(asOf: string = PRICE_POSITION_V23_AS_OF): string {
  return `${PRICE_POSITION_V231_VERSION}|${asOf}`;
}

const LEGACY_BAND_TO_DECADE: Record<string, string> = {
  "59": "20",
  "84": "30",
  "114": "40",
};

/** V2.3 / V2.3.1 rows are stored under decade keys. Legacy 59/84/114 map only for read. */
export function pricePositionStorageBand(areaBand: string): string {
  return LEGACY_BAND_TO_DECADE[areaBand] ?? areaBand;
}
