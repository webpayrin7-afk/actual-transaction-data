/**
 * Price Position V3 — 지역 대표 평당가.
 *
 * Regional price level:
 *   LATEST_ACTIVE + equal-complex-weight + median-of-complex-means + soft-stale metadata
 *
 * Regional trend / sample-confidence-v2: unchanged from V2.3.2.
 * V2.3 / V2.3.1 / V2.3.2 rows stay stored; public pointer moves here after publish.
 */
import {
  buildPricePositionV21,
  type ContributorAuditRow,
  type FreshnessStatusV3,
  type PricePositionBodyV21,
} from "./price-position-v21";
import type { ComplexIdentityV2, SupplySalePoint } from "./price-position-v2";
import { DECADE_COHORTS_V22, type DecadeCohortV22 } from "./price-position-v22";
import { REGION_TREND_DEFINITION_V231 } from "./price-position-v23";

export const PRICE_POSITION_V3_VERSION = "price-position-v3";
export const PRICE_POSITION_V3_AS_OF = "2026-09-17";

export const REGION_PRICE_DEFINITION_V3 =
  "median_of_canonical_complex_latest_active_month_means_equal_weight" as const;

export const PRICE_COPY_V3 =
  "같은 지역·평형대 단지들의 최근 실거래를 바탕으로 계산한 대표 평당가입니다.";

export const METHODOLOGY_FINGERPRINT_V3 =
  "v3|latest-active|equal-complex-weight|median-of-complex-means|soft-stale|canonical-cohort|complex-exact-endpoint-s1|region-trailing-6m-pooled-mean-UNCHANGED|horizons-6M-1Y-2Y-5Y-UNCHANGED" as const;

/** Soft-stale metadata thresholds (display only; does not exclude contributors). */
export const V3_SOFT_STALE = {
  shareGt12: 0.25,
  shareGt24: 0.15,
  medianAgeMonths: 6,
} as const;

export function pricePositionV3SnapshotId(asOf: string = PRICE_POSITION_V3_AS_OF): string {
  return `${PRICE_POSITION_V3_VERSION}|${asOf}`;
}

export function classifySoftStaleV3(input: {
  shareOver12Months: number | null | undefined;
  shareOver24Months: number | null | undefined;
  medianAgeMonths: number | null | undefined;
}): FreshnessStatusV3 {
  const share12 = input.shareOver12Months ?? 0;
  const share24 = input.shareOver24Months ?? 0;
  const medianAge = input.medianAgeMonths ?? 0;
  if (share24 >= V3_SOFT_STALE.shareGt24 || (share12 >= V3_SOFT_STALE.shareGt12 && medianAge >= V3_SOFT_STALE.medianAgeMonths)) {
    return "STALE_HEAVY";
  }
  if (share12 >= V3_SOFT_STALE.shareGt12 || medianAge >= V3_SOFT_STALE.medianAgeMonths) {
    return "STALE_MIXED";
  }
  return "FRESH";
}

export function buildPricePositionV3(params: {
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
    version: PRICE_POSITION_V3_VERSION,
    methodologyFingerprint: METHODOLOGY_FINGERPRINT_V3,
    regionEndpoint: "TRAILING_6M",
    regionTrendDefinition: REGION_TREND_DEFINITION_V231,
    cohortUniverse: params.cohortUniverse,
    enforceTrendMinimum: false,
    canonicalContributorsOnly: true,
    regionPriceMode: "LATEST_ACTIVE",
    priceLevelDefinition: REGION_PRICE_DEFINITION_V3,
    priceCopy: PRICE_COPY_V3,
    contributorAudit: params.contributorAudit,
  });
}

export type { FreshnessStatusV3 };
export { DECADE_COHORTS_V22 };
