/**
 * Price position V2.3.
 * Price level stays P2. Complex trend stays the exact-label S1 endpoint.
 * Dong/Gu/Seoul trend is the median of matched-complex changes over a trailing 6-month window.
 * V2, V2.1, and V2.2 rows stay stored and are not fallbacks.
 */
import {
  buildPricePositionV21,
  HISTORY_FLOOR_MONTH_V21,
  PRICE_POSITION_V21_AS_OF,
  type ContributorAuditRow,
  type PricePositionBodyV21,
} from "./price-position-v21";
import type { ComplexIdentityV2, SupplySalePoint } from "./price-position-v2";
import { DECADE_COHORTS_V22, type DecadeCohortV22 } from "./price-position-v22";

export const PRICE_POSITION_V23_VERSION = "price-position-v2.3";
export const PRICE_POSITION_V23_AS_OF = PRICE_POSITION_V21_AS_OF;
export const HISTORY_FLOOR_MONTH_V23 = HISTORY_FLOOR_MONTH_V21;

export const REGION_TREND_DEFINITION_V23 =
  "median_of_matched_complex_changes_trailing_6m_pooled_mean" as const;

export const METHODOLOGY_FINGERPRINT_V23 =
  "v2.3|P2-median-complex-means|T0-matched-median-change|complex-exact-endpoint-s1|region-trailing-6m-pooled-mean|symmetric-history-floor|region-all-decade-cohorts|horizons-6M-1Y-2Y-5Y";

/** Same price method as V2.3. Regional median membership is the canonical cohort only. */
export const PRICE_POSITION_V231_VERSION = "price-position-v2.3.1";
export const REGION_TREND_DEFINITION_V231 =
  "median_of_canonical_matched_complex_changes_trailing_6m_pooled_mean" as const;
export const METHODOLOGY_FINGERPRINT_V231 =
  `${METHODOLOGY_FINGERPRINT_V23}|canonical-cohort-contributors` as const;

export function pricePositionV23SnapshotId(asOf: string = PRICE_POSITION_V23_AS_OF): string {
  return `${PRICE_POSITION_V23_VERSION}|${asOf}`;
}

export function pricePositionV231SnapshotId(asOf: string = PRICE_POSITION_V23_AS_OF): string {
  return `${PRICE_POSITION_V231_VERSION}|${asOf}`;
}

/**
 * Freshness patch of V2.3.1. Same SAME_MONTH + median-of-complex-means methodology.
 * New snapshot identity only — does not change regional contributor or trend rules.
 */
export const PRICE_POSITION_V232_VERSION = "price-position-v2.3.2";
export const REGION_TREND_DEFINITION_V232 = REGION_TREND_DEFINITION_V231;
export const METHODOLOGY_FINGERPRINT_V232 =
  `${METHODOLOGY_FINGERPRINT_V231}|freshness-patch` as const;

export function pricePositionV232SnapshotId(asOf: string = PRICE_POSITION_V23_AS_OF): string {
  return `${PRICE_POSITION_V232_VERSION}|${asOf}`;
}

export function buildPricePositionV23(params: {
  cohort: DecadeCohortV22;
  points: readonly SupplySalePoint[];
  identities: ReadonlyMap<string, ComplexIdentityV2>;
  cohortUniverse?: ReadonlySet<string>;
  transactionAsOf?: string;
  contributorAudit?: ContributorAuditRow[];
}): { bodies: PricePositionBodyV21[]; ambiguousExcluded: number; exactMapped: number } {
  return buildPricePositionV21({
    areaBand: params.cohort.key,
    points: params.points,
    identities: params.identities,
    transactionAsOf: params.transactionAsOf,
    cohort: params.cohort,
    version: PRICE_POSITION_V23_VERSION,
    methodologyFingerprint: METHODOLOGY_FINGERPRINT_V23,
    regionEndpoint: "TRAILING_6M",
    regionTrendDefinition: REGION_TREND_DEFINITION_V23,
    cohortUniverse: params.cohortUniverse,
    enforceTrendMinimum: false,
    contributorAudit: params.contributorAudit,
  });
}

export function buildPricePositionV231(params: {
  cohort: DecadeCohortV22;
  points: readonly SupplySalePoint[];
  identities: ReadonlyMap<string, ComplexIdentityV2>;
  cohortUniverse?: ReadonlySet<string>;
  transactionAsOf?: string;
  contributorAudit?: ContributorAuditRow[];
}): { bodies: PricePositionBodyV21[]; ambiguousExcluded: number; exactMapped: number } {
  return buildPricePositionV21({
    areaBand: params.cohort.key,
    points: params.points,
    identities: params.identities,
    transactionAsOf: params.transactionAsOf,
    cohort: params.cohort,
    version: PRICE_POSITION_V231_VERSION,
    methodologyFingerprint: METHODOLOGY_FINGERPRINT_V231,
    regionEndpoint: "TRAILING_6M",
    regionTrendDefinition: REGION_TREND_DEFINITION_V231,
    cohortUniverse: params.cohortUniverse,
    enforceTrendMinimum: false,
    canonicalContributorsOnly: true,
    contributorAudit: params.contributorAudit,
  });
}

/**
 * Freshness patch over V2.3.1. Identical price/trend methodology and canonical
 * contributor rules; new snapshot identity only. Does not introduce latest-active
 * or equal-complex-mean aggregation.
 */
export function buildPricePositionV232(params: {
  cohort: DecadeCohortV22;
  points: readonly SupplySalePoint[];
  identities: ReadonlyMap<string, ComplexIdentityV2>;
  cohortUniverse?: ReadonlySet<string>;
  transactionAsOf?: string;
  contributorAudit?: ContributorAuditRow[];
}): { bodies: PricePositionBodyV21[]; ambiguousExcluded: number; exactMapped: number } {
  return buildPricePositionV21({
    areaBand: params.cohort.key,
    points: params.points,
    identities: params.identities,
    transactionAsOf: params.transactionAsOf,
    cohort: params.cohort,
    version: PRICE_POSITION_V232_VERSION,
    methodologyFingerprint: METHODOLOGY_FINGERPRINT_V232,
    regionEndpoint: "TRAILING_6M",
    regionTrendDefinition: REGION_TREND_DEFINITION_V232,
    cohortUniverse: params.cohortUniverse,
    enforceTrendMinimum: false,
    canonicalContributorsOnly: true,
    contributorAudit: params.contributorAudit,
  });
}

export type { ContributorAuditRow };

export { DECADE_COHORTS_V22 };
