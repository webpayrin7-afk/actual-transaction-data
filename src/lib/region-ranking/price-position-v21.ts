/**
 * Complex-region price position V2.1.
 * Frozen from audit: region price = P2 (median of complex-month means),
 * region trend = T0 (median of matched-complex changes), horizons 6M/1Y/2Y/5Y,
 * trend sparse S1 with previous-month tie-break. V2 rows stay historical.
 */
import { median } from "./objective-rank";
import { AREA_BAND_VERSION, type RegionalAreaBandId } from "./area-band";
import {
  BAND_TO_SUPPLY_COHORT,
  exactSupplyPyeong,
  inSupplyCohort,
  roundToV2,
  shiftYearMonthV2,
  type ComplexIdentityV2,
  type SupplySalePoint,
} from "./price-position-v2";
import {
  baselineMonthForHorizon,
  buildComplexMonthValues,
  complexMonthStat,
  HORIZON_SHIFT_MONTHS_V21,
  mean,
  monthsBetweenInclusive,
  resolveComplexMonth,
  TREND_HORIZONS_V21,
  type TrendHorizonV21,
} from "./price-position-v21-audit";
import {
  dataCoverageStatusV2,
  SAMPLE_CONFIDENCE_VERSION,
  sampleStatusV2,
  type DataCoverageStatusV2,
  type SampleStatusV2,
} from "./sample-confidence-v2";
import {
  pooledWindowMean,
  resolveRegionWindowV23,
  type WindowStatusV23,
} from "./region-trend-window";

export const PRICE_POSITION_V21_VERSION = "price-position-v2.1";
export const PRICE_POSITION_V21_AS_OF = "2026-09-17";
export const HISTORY_FLOOR_MONTH_V21 = "2021-07";
export const CHANGE_UNIT_V21 = "percentage_points" as const;
export const AREA_BASIS_V21 = "SUPPLY_PYEONG_LABEL" as const;
export const PYEONG_LABEL_VERSION_V21 = "canonical-supply-pyeong-round-v1";

export const PRICE_LEVEL_DEFINITION_V21 =
  "median_of_complex_reference_month_mean_deal_per_market_pyeong_label" as const;
export const COMPLEX_PRICE_DEFINITION_V21 =
  "selected_market_pyeong_label_reference_month_mean_deal_per_label" as const;
export const REGION_TREND_DEFINITION_V21 = "median_of_matched_complex_changes_same_cohort_s1" as const;

export const PRICE_COPY_V21 =
  "선택한 평형대의 단지별 실거래 가격을 기준으로 지역 가격 수준을 비교합니다.";
export const TREND_COPY_V21 =
  "동일한 단지의 현재와 과거 실거래 가격을 비교해 지역 가격 변화를 계산합니다.";

export const METHODOLOGY_FINGERPRINT_V21 =
  "v2.1|P2-median-complex-means|T0-matched-median-change|S1-prefer-previous|cohort-supply-pyeong-decade|complex-exact-market-label|horizons-6M-1Y-2Y-5Y";

export const PRICE_SCOPES_V21 = ["COMPLEX", "DONG", "GU", "SEOUL"] as const;
export type PriceScopeV21 = (typeof PRICE_SCOPES_V21)[number];

export const PRICE_MIN_COMPLEXES_V21: Record<PriceScopeV21, number> = {
  COMPLEX: 1,
  DONG: 3,
  GU: 5,
  SEOUL: 10,
};

export const TREND_MIN_COMPLEXES_V21: Record<PriceScopeV21, number> = {
  COMPLEX: 1,
  DONG: 3,
  GU: 5,
  SEOUL: 10,
};

export { TREND_HORIZONS_V21, HORIZON_SHIFT_MONTHS_V21, type TrendHorizonV21 };

export type FreshnessStatusV3 = "FRESH" | "STALE_MIXED" | "STALE_HEAVY";

export type PriceLevelCellV21 = {
  scope: PriceScopeV21;
  label: string;
  meanPricePerSupplyPyeong: number | null;
  tradeCount: number | null;
  sampleCount: number | null;
  contributingComplexCount: number | null;
  referenceMonth: string | null;
  status: "ok" | "INSUFFICIENT_SAMPLE";
  /** V3 regional freshness. Absent on V2.x rows. */
  canonicalCount?: number | null;
  historyUsableCount?: number | null;
  medianAgeMonths?: number | null;
  p75AgeMonths?: number | null;
  p90AgeMonths?: number | null;
  shareOver12Months?: number | null;
  shareOver24Months?: number | null;
  freshnessStatus?: FreshnessStatusV3 | null;
  /** Calculation as-of month for latest-active regional cells (not a shared trade month). */
  asOfMonth?: string | null;
};

export type TrendCellV21 = {
  scope: PriceScopeV21;
  label: string;
  changePercent: number | null;
  currentMean: number | null;
  baselineMean: number | null;
  currentTradeCount: number | null;
  baselineTradeCount: number | null;
  matchedComplexCount: number | null;
  currentMonth: string;
  baselineMonth: string;
  actualCurrentMonth: string | null;
  actualBaselineMonth: string | null;
  status: "ok" | "INSUFFICIENT_SAMPLE";
  /** V2.3 regional diagnostics. Absent on V2.1/V2.2 rows. */
  cohortUniverseCount?: number | null;
  /** Traded complexes in the region, including complexes outside the canonical supply set. */
  historyAvailableCount?: number | null;
  /** Legacy ratio: median membership / cohort universe. Not the confidence denominator. */
  matchedCoverageRatio?: number | null;
  /** Canonical supply complexes that have usable mapped history. Confidence denominator B. */
  canonicalHistoryAvailableCount?: number | null;
  /** C / B. Confidence coverage. Null when B is 0 or the window does not exist. */
  sampleCoverageRatio?: number | null;
  /** C / A. Diagnostic only. */
  supplyCoverageRatio?: number | null;
  /** B / A. Diagnostic only. Same value as historyDataCoverageRatio. */
  historyCoverageRatio?: number | null;
  historyDataCoverageRatio?: number | null;
  dataCoverageStatus?: DataCoverageStatusV2 | null;
  currentWindow?: string | null;
  baselineWindow?: string | null;
  windowStatus?: WindowStatusV23 | null;
  sampleStatus?: SampleStatusV2 | null;
  sampleConfidenceVersion?: typeof SAMPLE_CONFIDENCE_VERSION | null;
  windowStatistic?: "pooled_trade_mean" | null;
};

export type ComplexExactLabelSliceV21 = {
  marketPyeongLabel: number;
  referenceMonth: string;
  priceLevel: PriceLevelCellV21;
  trends: Record<TrendHorizonV21, TrendCellV21>;
};

export type PricePositionBodyV21 = {
  status: "ok" | "INSUFFICIENT_SAMPLE" | "unavailable";
  version: string;
  complexId: string;
  aptName: string | null;
  areaBand: string;
  supplyPyeongCohort: string;
  regionPyeongDecade: string;
  cohortKey: string;
  areaBandVersion: string;
  transactionAsOf: string;
  referenceMonth: string | null;
  snapshotId?: string;
  /** Set at read when exclusive_area / market_pyeong_label selects an exact complex series. */
  selectedMarketPyeongLabel: number | null;
  /** How COMPLEX scope was produced for this response. */
  complexScopeBasis: "decade_cohort" | "exact_market_pyeong_label" | "ambiguous" | "unavailable";
  changeUnit: typeof CHANGE_UNIT_V21;
  priceLevelDefinition: string;
  complexPriceDefinition: typeof COMPLEX_PRICE_DEFINITION_V21;
  complexTrendDefinition: "calendar_month_mean_deal_per_market_pyeong_label";
  regionTrendDefinition: string;
  areaBasis: typeof AREA_BASIS_V21;
  pyeongLabelVersion: typeof PYEONG_LABEL_VERSION_V21;
  methodologyFingerprint: string;
  methodologyCopy: { price: string; trend: string };
  priceLevel: PriceLevelCellV21[];
  trends: Record<TrendHorizonV21, TrendCellV21[]>;
  /** Exact-label complex slices inside this decade cohort. Region scopes stay decade. */
  complexExactByMarketLabel: Record<string, ComplexExactLabelSliceV21>;
  /** Present on V2.3 bodies after sample-confidence-v2. Price fingerprint stays v2.3. */
  sampleConfidenceVersion?: typeof SAMPLE_CONFIDENCE_VERSION;
  maxAvailableValue: {
    priceLevel: number | null;
    trends: Record<TrendHorizonV21, number | null>;
  };
  coverage: {
    exactMappedTrades: number;
    ambiguousExcluded: number;
  };
};

export type ContributorAuditRow = {
  cohortKey: string;
  cacheKey: string;
  referenceMonth: string;
  horizon: TrendHorizonV21;
  legacyContributors: number;
  canonicalContributors: number;
  nonCanonicalContributors: number;
  legacyMedian: number | null;
  canonicalMedian: number | null;
  publishedMedian: number | null;
  publishedContributors: number;
  nonCanonicalIds: string[];
};

export function pricePositionV21SnapshotId(asOf: string = PRICE_POSITION_V21_AS_OF): string {
  return `${PRICE_POSITION_V21_VERSION}|${asOf}`;
}

function changePercent(current: number, baseline: number): number | null {
  if (!(baseline > 0) || !Number.isFinite(current)) return null;
  return roundToV2((current / baseline - 1) * 100, 2);
}

function dongKey(lawdCd: string, bjdongCd: string): string {
  return `${lawdCd}${bjdongCd}`;
}

/**
 * Build V2.1 payloads for one supply-pyeong cohort.
 * Region price = median of exact-month complex means (P2).
 * Region trend = median of matched-complex changes with S1 endpoints (T0).
 */
export function buildPricePositionV21(params: {
  areaBand: RegionalAreaBandId | string;
  points: readonly SupplySalePoint[];
  identities: ReadonlyMap<string, ComplexIdentityV2>;
  transactionAsOf?: string;
  /** Overrides the legacy exclusive-band cohort. Label bounds only. */
  cohort?: { key: string; min: number; max: number; label: string };
  version?: string;
  methodologyFingerprint?: string;
  /** Default S1 keeps V2.1/V2.2 region trends unchanged. */
  regionEndpoint?: "S1" | "TRAILING_6M";
  regionTrendDefinition?: string;
  /** Canonical supply complexes. Coverage denominator. V2.3.1 also uses this set as the regional median population. */
  cohortUniverse?: ReadonlySet<string>;
  /** When false, a matched median is returned even below the legacy minimum. */
  enforceTrendMinimum?: boolean;
  /** V2.3.1. Regional median uses canonical cohort members only. */
  canonicalContributorsOnly?: boolean;
  /**
   * Regional price membership month policy.
   * SAME_MONTH (default): exact calendar referenceMonth.
   * LATEST_ACTIVE (V3): each complex's latest usable month ≤ as-of.
   */
  regionPriceMode?: "SAME_MONTH" | "LATEST_ACTIVE";
  /** Override published price-level definition string (V3). */
  priceLevelDefinition?: string;
  /** Override price methodology copy (V3). */
  priceCopy?: string;
  /** Read-only. Does not change the published median. */
  contributorAudit?: ContributorAuditRow[];
}): { bodies: PricePositionBodyV21[]; ambiguousExcluded: number; exactMapped: number } {
  const cohort = params.cohort ?? BAND_TO_SUPPLY_COHORT[params.areaBand as RegionalAreaBandId];
  const version = params.version ?? PRICE_POSITION_V21_VERSION;
  const fingerprint = params.methodologyFingerprint ?? METHODOLOGY_FINGERPRINT_V21;
  const asOf = params.transactionAsOf ?? PRICE_POSITION_V21_AS_OF;
  const asOfMonth = asOf.slice(0, 7);
  const regionEndpoint = params.regionEndpoint ?? "S1";
  const regionTrendDefinition = params.regionTrendDefinition ?? REGION_TREND_DEFINITION_V21;
  const enforceTrendMinimum = params.enforceTrendMinimum ?? true;
  const canonicalContributorsOnly = params.canonicalContributorsOnly === true;
  const regionPriceMode = params.regionPriceMode ?? "SAME_MONTH";
  const priceLevelDefinition = params.priceLevelDefinition ?? PRICE_LEVEL_DEFINITION_V21;
  const priceCopy = params.priceCopy ?? PRICE_COPY_V21;

  const dealPoints: Array<{
    complexId: string;
    lawdCd: string;
    bjdongCd: string;
    yearMonth: string;
    pricePerMarketPyeong: number;
    dealAmount: number;
    marketPyeongLabel: number;
  }> = [];
  let exactMapped = 0;
  for (const point of params.points) {
    const inCohort =
      point.marketPyeongLabel != null
        ? point.marketPyeongLabel >= cohort.min && point.marketPyeongLabel < cohort.max
        : params.cohort
          ? false
          : inSupplyCohort(point.supplyPyeong, params.areaBand as RegionalAreaBandId);
    if (!inCohort) continue;
    if (point.yearMonth < HISTORY_FLOOR_MONTH_V21) continue;
    if (point.yearMonth > asOfMonth) continue;
    if (point.pricePerMarketPyeong == null || !Number.isFinite(point.pricePerMarketPyeong)) continue;
    if (point.marketPyeongLabel == null) continue;
    exactMapped += 1;
    dealPoints.push({
      complexId: point.complexId,
      lawdCd: point.lawdCd,
      bjdongCd: point.bjdongCd,
      yearMonth: point.yearMonth,
      pricePerMarketPyeong: point.pricePerMarketPyeong,
      dealAmount: point.dealAmount,
      marketPyeongLabel: point.marketPyeongLabel,
    });
  }

  const tables = buildComplexMonthValues(dealPoints);
  const identityRef = new Map<string, string>();
  for (const [complexId, months] of tables) {
    let latest = "";
    for (const month of months.keys()) {
      if (month <= asOfMonth && month > latest) latest = month;
    }
    if (latest) identityRef.set(complexId, latest);
  }

  function complexTrendCell(
    cells: Map<string, import("./price-position-v21-audit").ComplexMonthValue>,
    referenceMonth: string,
    baselineTarget: string,
    label: string,
  ): TrendCellV21 {
    const cur = resolveComplexMonth({
      cells,
      targetMonth: referenceMonth,
      asOfMonth,
      sparse: "S1",
      minTrades: 1,
    });
    const base = resolveComplexMonth({
      cells,
      targetMonth: baselineTarget,
      asOfMonth,
      sparse: "S1",
      minTrades: 1,
    });
    const ch =
      cur && base ? changePercent(complexMonthStat(cur.cell, "C1_MEAN"), complexMonthStat(base.cell, "C1_MEAN")) : null;
    const ok = ch != null;
    return {
      scope: "COMPLEX",
      label,
      changePercent: ok ? ch : null,
      currentMean: cur ? roundToV2(complexMonthStat(cur.cell, "C1_MEAN"), 4) : null,
      baselineMean: base ? roundToV2(complexMonthStat(base.cell, "C1_MEAN"), 4) : null,
      currentTradeCount: cur?.cell.tradeCount ?? null,
      baselineTradeCount: base?.cell.tradeCount ?? null,
      matchedComplexCount: ok ? 1 : null,
      currentMonth: referenceMonth,
      baselineMonth: baselineTarget,
      actualCurrentMonth: cur?.month ?? null,
      actualBaselineMonth: base?.month ?? null,
      status: ok ? "ok" : "INSUFFICIENT_SAMPLE",
    };
  }

  // Group once. Regional medians depend only on scope membership and the
  // subject complex's reference month, so later cells are cached. The cached
  // value is the same P2 / T0 calculation, not a different formula.
  const pointsByComplex = new Map<string, typeof dealPoints>();
  for (const point of dealPoints) {
    const list = pointsByComplex.get(point.complexId);
    if (list) list.push(point);
    else pointsByComplex.set(point.complexId, [point]);
  }
  const byDong = new Map<string, string[]>();
  const byGu = new Map<string, string[]>();
  for (const cid of identityRef.keys()) {
    const ident = params.identities.get(cid);
    if (!ident) continue;
    const dk = dongKey(ident.lawdCd, ident.bjdongCd);
    const dongList = byDong.get(dk);
    if (dongList) dongList.push(cid);
    else byDong.set(dk, [cid]);
    const guList = byGu.get(ident.lawdCd);
    if (guList) guList.push(cid);
    else byGu.set(ident.lawdCd, [cid]);
  }
  const seoulIds = [...identityRef.keys()];
  const universeDong = new Map<string, number>();
  const universeGu = new Map<string, number>();
  let universeSeoul = 0;
  const canonicalDong = new Map<string, Set<string>>();
  const canonicalGu = new Map<string, Set<string>>();
  const canonicalSeoul = new Set<string>();
  if (params.cohortUniverse) {
    for (const cid of params.cohortUniverse) {
      const ident = params.identities.get(cid);
      if (!ident) continue;
      universeSeoul += 1;
      canonicalSeoul.add(cid);
      universeGu.set(ident.lawdCd, (universeGu.get(ident.lawdCd) ?? 0) + 1);
      const guSet = canonicalGu.get(ident.lawdCd) ?? new Set<string>();
      guSet.add(cid);
      canonicalGu.set(ident.lawdCd, guSet);
      const dk = dongKey(ident.lawdCd, ident.bjdongCd);
      universeDong.set(dk, (universeDong.get(dk) ?? 0) + 1);
      const dongSet = canonicalDong.get(dk) ?? new Set<string>();
      dongSet.add(cid);
      canonicalDong.set(dk, dongSet);
    }
  }

  function regionCanonical(scope: PriceScopeV21, dong: string, lawd: string): ReadonlySet<string> | null {
    if (!params.cohortUniverse || scope === "COMPLEX") return null;
    if (scope === "DONG") return canonicalDong.get(dong) ?? new Set();
    if (scope === "GU") return canonicalGu.get(lawd) ?? new Set();
    return canonicalSeoul;
  }

  function scopeUniverse(scope: PriceScopeV21, dong: string, lawd: string, traded: number): number {
    if (!params.cohortUniverse || scope === "COMPLEX") return traded;
    if (scope === "DONG") return universeDong.get(dong) ?? 0;
    if (scope === "GU") return universeGu.get(lawd) ?? 0;
    return universeSeoul;
  }

  type RegionPrice = {
    meanPricePerSupplyPyeong: number | null;
    tradeCount: number | null;
    sampleCount: number | null;
    contributingComplexCount: number | null;
    status: "ok" | "INSUFFICIENT_SAMPLE";
    canonicalCount: number | null;
    historyUsableCount: number | null;
    medianAgeMonths: number | null;
    p75AgeMonths: number | null;
    p90AgeMonths: number | null;
    shareOver12Months: number | null;
    shareOver24Months: number | null;
    freshnessStatus: FreshnessStatusV3 | null;
  };
  const regionPriceCache = new Map<string, RegionPrice>();

  function agePercentile(sorted: number[], p: number): number | null {
    if (!sorted.length) return null;
    return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  }

  function classifyFreshness(share12: number, share24: number, medianAge: number | null): FreshnessStatusV3 {
    const med = medianAge ?? 0;
    if (share24 >= 0.15 || (share12 >= 0.25 && med >= 6)) return "STALE_HEAVY";
    if (share12 >= 0.25 || med >= 6) return "STALE_MIXED";
    return "FRESH";
  }

  function regionPrice(
    cacheKey: string,
    ids: readonly string[],
    referenceMonth: string,
    minComplexes: number,
    canonicalSet: ReadonlySet<string> | null,
  ): RegionPrice {
    const cached = regionPriceCache.get(cacheKey);
    if (cached) return cached;
    const values: number[] = [];
    const ages: number[] = [];
    let trades = 0;
    // Canonical filter for regional price applies to V3 latest-active only.
    // SAME_MONTH (V2.3.x) keeps prior traded-scope membership.
    const useCanonical = regionPriceMode === "LATEST_ACTIVE" && canonicalContributorsOnly && canonicalSet != null;
    let historyUsable = 0;
    for (const cid of ids) {
      if (useCanonical && !canonicalSet!.has(cid)) continue;
      const months = tables.get(cid);
      if (!months || months.size < 1) continue;
      historyUsable += 1;
      if (regionPriceMode === "LATEST_ACTIVE") {
        const latest = identityRef.get(cid);
        if (!latest) continue;
        const cell = months.get(latest);
        if (!cell || cell.tradeCount < 1) continue;
        values.push(complexMonthStat(cell, "C1_MEAN"));
        trades += cell.tradeCount;
        ages.push(monthsBetweenInclusive(latest, asOfMonth));
      } else {
        const cell = months.get(referenceMonth);
        if (!cell || cell.tradeCount < 1) continue;
        values.push(complexMonthStat(cell, "C1_MEAN"));
        trades += cell.tradeCount;
        ages.push(0);
      }
    }
    // Also count canonical complexes with history that may be missing from traded scope ids
    let canonicalCount: number | null = null;
    if (canonicalSet) {
      canonicalCount = canonicalSet.size;
      if (regionPriceMode === "LATEST_ACTIVE") {
        historyUsable = 0;
        for (const cid of canonicalSet) {
          if ((tables.get(cid)?.size ?? 0) > 0) historyUsable += 1;
        }
      }
    }
    const med = median(values);
    const ok = med != null && values.length >= minComplexes;
    const sortedAges = [...ages].sort((a, b) => a - b);
    const medianAge = agePercentile(sortedAges, 0.5);
    const gt12 = ages.filter((a) => a > 12).length;
    const gt24 = ages.filter((a) => a > 24).length;
    const share12 = ages.length ? gt12 / ages.length : 0;
    const share24 = ages.length ? gt24 / ages.length : 0;
    const freshness =
      regionPriceMode === "LATEST_ACTIVE" && ages.length
        ? classifyFreshness(share12, share24, medianAge)
        : null;
    const computed: RegionPrice = {
      meanPricePerSupplyPyeong: ok ? roundToV2(med!, 4) : null,
      tradeCount: values.length ? trades : null,
      sampleCount: values.length || null,
      contributingComplexCount: values.length || null,
      status: ok ? "ok" : "INSUFFICIENT_SAMPLE",
      canonicalCount,
      historyUsableCount: canonicalSet ? historyUsable : null,
      medianAgeMonths: regionPriceMode === "LATEST_ACTIVE" ? medianAge : null,
      p75AgeMonths: regionPriceMode === "LATEST_ACTIVE" ? agePercentile(sortedAges, 0.75) : null,
      p90AgeMonths: regionPriceMode === "LATEST_ACTIVE" ? agePercentile(sortedAges, 0.9) : null,
      shareOver12Months: regionPriceMode === "LATEST_ACTIVE" && ages.length ? roundToV2(share12, 4) : null,
      shareOver24Months: regionPriceMode === "LATEST_ACTIVE" && ages.length ? roundToV2(share24, 4) : null,
      freshnessStatus: freshness,
    };
    regionPriceCache.set(cacheKey, computed);
    return computed;
  }

  type RegionTrend = {
    changePercent: number | null;
    matchedComplexCount: number | null;
    actualCurrentMonth: string | null;
    actualBaselineMonth: string | null;
    status: "ok" | "INSUFFICIENT_SAMPLE";
    cohortUniverseCount: number | null;
    historyAvailableCount: number | null;
    matchedCoverageRatio: number | null;
    canonicalHistoryAvailableCount: number | null;
    canonicalMatchedComplexCount: number | null;
    sampleCoverageRatio: number | null;
    supplyCoverageRatio: number | null;
    historyCoverageRatio: number | null;
    historyDataCoverageRatio: number | null;
    dataCoverageStatus: DataCoverageStatusV2 | null;
    currentWindow: string | null;
    baselineWindow: string | null;
    windowStatus: WindowStatusV23 | null;
    sampleStatus: SampleStatusV2 | null;
    windowStatistic: "pooled_trade_mean" | null;
  };
  const regionTrendCache = new Map<string, RegionTrend>();
  function regionTrend(
    cacheKey: string,
    ids: readonly string[],
    referenceMonth: string,
    baselineTarget: string,
    minComplexes: number,
    horizon: TrendHorizonV21,
    universeCount: number,
    canonicalSet: ReadonlySet<string> | null,
  ): RegionTrend {
    const cached = regionTrendCache.get(cacheKey);
    if (cached) return cached;
    const changes: number[] = [];
    const canonicalChanges: number[] = [];
    const nonCanonicalIds: string[] = [];
    let matched = 0;
    let canonicalMatched = 0;
    const actualCurrent = new Set<string>();
    const actualBaseline = new Set<string>();
    const canonicalCurrent = new Set<string>();
    const canonicalBaseline = new Set<string>();
    let historyAvailable = 0;
    let canonicalHistory = 0;
    const window =
      regionEndpoint === "TRAILING_6M"
        ? resolveRegionWindowV23({
            referenceMonth,
            horizonShift: HORIZON_SHIFT_MONTHS_V21[horizon],
            historyFloor: HISTORY_FLOOR_MONTH_V21,
          })
        : null;
    const useCanonical = canonicalContributorsOnly && canonicalSet != null;
    for (const cid of ids) {
      const cells = tables.get(cid);
      if (!cells) continue;
      historyAvailable += 1;
      const inCanonical = canonicalSet ? canonicalSet.has(cid) : true;
      if (inCanonical) canonicalHistory += 1;
      if (regionEndpoint === "TRAILING_6M") {
        if (!window) continue;
        const cur = pooledWindowMean(cells, window.currentStart, window.currentEnd, asOfMonth);
        const base = pooledWindowMean(cells, window.baselineStart, window.baselineEnd, asOfMonth);
        if (!cur || !base) continue;
        const ch = changePercent(cur.mean, base.mean);
        if (ch == null) continue;
        changes.push(ch);
        matched += 1;
        if (inCanonical) {
          canonicalChanges.push(ch);
          canonicalMatched += 1;
          for (const month of cur.months) canonicalCurrent.add(month);
          for (const month of base.months) canonicalBaseline.add(month);
        } else nonCanonicalIds.push(cid);
        if (!useCanonical) {
          for (const month of cur.months) actualCurrent.add(month);
          for (const month of base.months) actualBaseline.add(month);
        }
        continue;
      }
      const cur = resolveComplexMonth({
        cells,
        targetMonth: referenceMonth,
        asOfMonth,
        sparse: "S1",
        minTrades: 1,
      });
      const base = resolveComplexMonth({
        cells,
        targetMonth: baselineTarget,
        asOfMonth,
        sparse: "S1",
        minTrades: 1,
      });
      if (!cur || !base) continue;
      const ch = changePercent(complexMonthStat(cur.cell, "C1_MEAN"), complexMonthStat(base.cell, "C1_MEAN"));
      if (ch == null) continue;
      changes.push(ch);
      matched += 1;
      actualCurrent.add(cur.month);
      actualBaseline.add(base.month);
    }
    const minimum = enforceTrendMinimum ? minComplexes : 1;
    const legacyMed = median(changes);
    const legacyOk = legacyMed != null && matched >= minimum;
    const publishedChanges = useCanonical ? canonicalChanges : changes;
    const publishedCount = useCanonical ? canonicalMatched : matched;
    const med = median(publishedChanges);
    const ok = med != null && publishedCount >= minimum;
    const publishedCurrent = useCanonical ? canonicalCurrent : actualCurrent;
    const publishedBaseline = useCanonical ? canonicalBaseline : actualBaseline;
    const computed: RegionTrend = {
      changePercent: ok ? roundToV2(med!, 2) : null,
      matchedComplexCount: publishedCount || null,
      actualCurrentMonth: publishedCurrent.size ? [...publishedCurrent].sort().join(",") : null,
      actualBaselineMonth: publishedBaseline.size ? [...publishedBaseline].sort().join(",") : null,
      status: ok ? "ok" : "INSUFFICIENT_SAMPLE",
      cohortUniverseCount: null,
      historyAvailableCount: null,
      matchedCoverageRatio: null,
      canonicalHistoryAvailableCount: null,
      canonicalMatchedComplexCount: null,
      sampleCoverageRatio: null,
      supplyCoverageRatio: null,
      historyCoverageRatio: null,
      historyDataCoverageRatio: null,
      dataCoverageStatus: null,
      currentWindow: null,
      baselineWindow: null,
      windowStatus: null,
      sampleStatus: null,
      windowStatistic: null,
    };
    if (regionEndpoint === "TRAILING_6M") {
      const coverageUniverse = universeCount > 0 ? universeCount : ids.length;
      const confidenceMatched = canonicalSet ? canonicalMatched : matched;
      const confidenceHistory = canonicalSet ? canonicalHistory : historyAvailable;
      const confidenceUniverse = canonicalSet ? canonicalSet.size : coverageUniverse;
      computed.cohortUniverseCount = confidenceUniverse;
      computed.historyAvailableCount = historyAvailable;
      const membership = useCanonical ? canonicalMatched : matched;
      computed.matchedCoverageRatio = coverageUniverse > 0 ? roundToV2(membership / coverageUniverse, 4) : null;
      computed.canonicalHistoryAvailableCount = confidenceHistory;
      computed.canonicalMatchedComplexCount = confidenceMatched;
      computed.matchedComplexCount = confidenceMatched || null;
      computed.sampleCoverageRatio =
        window && confidenceHistory > 0 ? roundToV2(confidenceMatched / confidenceHistory, 4) : null;
      computed.supplyCoverageRatio =
        window && confidenceUniverse > 0 ? roundToV2(confidenceMatched / confidenceUniverse, 4) : null;
      computed.historyCoverageRatio = confidenceUniverse > 0 ? roundToV2(confidenceHistory / confidenceUniverse, 4) : null;
      computed.historyDataCoverageRatio = computed.historyCoverageRatio;
      computed.dataCoverageStatus = dataCoverageStatusV2(confidenceHistory, confidenceUniverse);
      computed.currentWindow = window ? `${window.currentStart}..${window.currentEnd}` : null;
      computed.baselineWindow = window ? `${window.baselineStart}..${window.baselineEnd}` : null;
      computed.windowStatus = window?.status ?? null;
      computed.sampleStatus = sampleStatusV2({
        windowAvailable: window != null,
        matched: confidenceMatched,
        canonicalHistory: confidenceHistory,
      });
      computed.windowStatistic = "pooled_trade_mean";
      if (params.contributorAudit) {
        const canonicalMed = median(canonicalChanges);
        const canonicalOk = canonicalMed != null && canonicalMatched >= minimum;
        params.contributorAudit.push({
          cohortKey: params.cohort?.key ?? String(params.areaBand),
          cacheKey,
          referenceMonth,
          horizon,
          legacyContributors: matched,
          canonicalContributors: canonicalMatched,
          nonCanonicalContributors: matched - canonicalMatched,
          legacyMedian: legacyOk ? roundToV2(legacyMed!, 2) : null,
          canonicalMedian: canonicalOk ? roundToV2(canonicalMed!, 2) : null,
          publishedMedian: computed.changePercent,
          publishedContributors: publishedCount,
          nonCanonicalIds,
        });
      }
    }
    regionTrendCache.set(cacheKey, computed);
    return computed;
  }

  const bodies: PricePositionBodyV21[] = [];
  for (const [complexId, referenceMonth] of identityRef) {
    const id = params.identities.get(complexId);
    if (!id) continue;
    const key = dongKey(id.lawdCd, id.bjdongCd);
    const scopeComplexes: Record<PriceScopeV21, readonly string[]> = {
      COMPLEX: [complexId],
      DONG: byDong.get(key) ?? [],
      GU: byGu.get(id.lawdCd) ?? [],
      SEOUL: seoulIds,
    };
    const labels: Record<PriceScopeV21, string> = {
      COMPLEX: "이 단지",
      DONG: id.legalDongName || "동",
      GU: id.lawdCd,
      SEOUL: "서울",
    };

    // Exact-label complex slices (COMPLEX only). Region stays decade.
    const labelPoints = new Map<number, typeof dealPoints>();
    for (const point of pointsByComplex.get(complexId) ?? []) {
      const list = labelPoints.get(point.marketPyeongLabel) ?? [];
      list.push(point);
      labelPoints.set(point.marketPyeongLabel, list);
    }
    const complexExactByMarketLabel: Record<string, ComplexExactLabelSliceV21> = {};
    for (const [marketLabel, pointsForLabel] of labelPoints) {
      const labelTables = buildComplexMonthValues(pointsForLabel);
      const labelCells = labelTables.get(complexId);
      if (!labelCells) continue;
      let labelRef = "";
      for (const month of labelCells.keys()) {
        if (month <= asOfMonth && month > labelRef) labelRef = month;
      }
      if (!labelRef) continue;
      const priceCell: PriceLevelCellV21 = (() => {
        const cell = labelCells.get(labelRef);
        const ok = cell != null && cell.tradeCount >= 1;
        return {
          scope: "COMPLEX",
          label: labels.COMPLEX,
          meanPricePerSupplyPyeong: ok ? roundToV2(cell!.meanPrice, 4) : null,
          tradeCount: ok ? cell!.tradeCount : null,
          sampleCount: ok ? cell!.tradeCount : null,
          contributingComplexCount: ok ? 1 : null,
          referenceMonth: labelRef,
          status: ok ? "ok" : "INSUFFICIENT_SAMPLE",
        };
      })();
      const labelTrends = {} as Record<TrendHorizonV21, TrendCellV21>;
      for (const horizon of TREND_HORIZONS_V21) {
        const baselineTarget = baselineMonthForHorizon(labelRef, horizon);
        labelTrends[horizon] = complexTrendCell(labelCells, labelRef, baselineTarget, labels.COMPLEX);
      }
      complexExactByMarketLabel[String(marketLabel)] = {
        marketPyeongLabel: marketLabel,
        referenceMonth: labelRef,
        priceLevel: priceCell,
        trends: labelTrends,
      };
    }

    const priceLevel: PriceLevelCellV21[] = PRICE_SCOPES_V21.map((scope) => {
      if (scope === "COMPLEX") {
        const cell = tables.get(complexId)?.get(referenceMonth);
        const ok = cell != null && cell.tradeCount >= 1;
        return {
          scope,
          label: labels[scope],
          meanPricePerSupplyPyeong: ok ? roundToV2(cell!.meanPrice, 4) : null,
          tradeCount: ok ? cell!.tradeCount : null,
          sampleCount: ok ? cell!.tradeCount : null,
          contributingComplexCount: ok ? 1 : null,
          referenceMonth,
          status: ok ? "ok" : "INSUFFICIENT_SAMPLE",
        };
      }
      const regionKey = scope === "DONG" ? key : scope === "GU" ? id.lawdCd : "SEOUL";
      const canon = regionCanonical(scope, key, id.lawdCd);
      const priceCacheKey =
        regionPriceMode === "LATEST_ACTIVE"
          ? `${scope}|${regionKey}|LATEST_ACTIVE|${asOfMonth}`
          : `${scope}|${regionKey}|${referenceMonth}`;
      const cached = regionPrice(
        priceCacheKey,
        scopeComplexes[scope],
        referenceMonth,
        PRICE_MIN_COMPLEXES_V21[scope],
        canon,
      );
      return {
        scope,
        label: labels[scope],
        meanPricePerSupplyPyeong: cached.meanPricePerSupplyPyeong,
        tradeCount: cached.tradeCount,
        sampleCount: cached.sampleCount,
        contributingComplexCount: cached.contributingComplexCount,
        // Latest-active regional price is not a shared calendar trade month.
        referenceMonth: regionPriceMode === "LATEST_ACTIVE" ? null : referenceMonth,
        status: cached.status,
        ...(regionPriceMode === "LATEST_ACTIVE"
          ? {
              canonicalCount: cached.canonicalCount,
              historyUsableCount: cached.historyUsableCount,
              medianAgeMonths: cached.medianAgeMonths,
              p75AgeMonths: cached.p75AgeMonths,
              p90AgeMonths: cached.p90AgeMonths,
              shareOver12Months: cached.shareOver12Months,
              shareOver24Months: cached.shareOver24Months,
              freshnessStatus: cached.freshnessStatus,
              asOfMonth,
            }
          : {}),
      };
    });

    const trends = {} as Record<TrendHorizonV21, TrendCellV21[]>;
    for (const horizon of TREND_HORIZONS_V21) {
      const baselineTarget = baselineMonthForHorizon(referenceMonth, horizon);
      trends[horizon] = PRICE_SCOPES_V21.map((scope) => {
        if (scope === "COMPLEX") {
          return complexTrendCell(tables.get(complexId) ?? new Map(), referenceMonth, baselineTarget, labels.COMPLEX);
        }
        const cached = regionTrend(
          `${scope}|${scope === "DONG" ? key : scope === "GU" ? id.lawdCd : "SEOUL"}|${referenceMonth}|${horizon}|${regionEndpoint}`,
          scopeComplexes[scope],
          referenceMonth,
          baselineTarget,
          TREND_MIN_COMPLEXES_V21[scope],
          horizon,
          scopeUniverse(scope, key, id.lawdCd, scopeComplexes[scope].length),
          regionCanonical(scope, key, id.lawdCd),
        );
        return {
          scope,
          label: labels[scope],
          changePercent: cached.changePercent,
          currentMean: null,
          baselineMean: null,
          currentTradeCount: null,
          baselineTradeCount: null,
          matchedComplexCount: cached.matchedComplexCount,
          currentMonth: referenceMonth,
          baselineMonth: baselineTarget,
          actualCurrentMonth: cached.actualCurrentMonth,
          actualBaselineMonth: cached.actualBaselineMonth,
          status: cached.status,
          ...(cached.windowStatistic
            ? {
                cohortUniverseCount: cached.cohortUniverseCount,
                historyAvailableCount: cached.historyAvailableCount,
                matchedCoverageRatio: cached.matchedCoverageRatio,
                canonicalHistoryAvailableCount: cached.canonicalHistoryAvailableCount,
                sampleCoverageRatio: cached.sampleCoverageRatio,
                supplyCoverageRatio: cached.supplyCoverageRatio,
                historyCoverageRatio: cached.historyCoverageRatio,
                historyDataCoverageRatio: cached.historyDataCoverageRatio,
                dataCoverageStatus: cached.dataCoverageStatus,
                currentWindow: cached.currentWindow,
                baselineWindow: cached.baselineWindow,
                windowStatus: cached.windowStatus,
                sampleStatus: cached.sampleStatus,
                sampleConfidenceVersion: SAMPLE_CONFIDENCE_VERSION,
                windowStatistic: cached.windowStatistic,
              }
            : {}),
        };
      });
    }

    const complexLevel = priceLevel.find((cell) => cell.scope === "COMPLEX");
    const maxTrends = {} as Record<TrendHorizonV21, number | null>;
    for (const horizon of TREND_HORIZONS_V21) {
      maxTrends[horizon] = trends[horizon].find((cell) => cell.scope === "COMPLEX")?.changePercent ?? null;
    }

    bodies.push({
      status: complexLevel?.status === "ok" ? "ok" : "INSUFFICIENT_SAMPLE",
      version,
      complexId,
      aptName: id.aptName || null,
      areaBand: params.cohort ? params.cohort.key : params.areaBand,
      supplyPyeongCohort: cohort.label,
      regionPyeongDecade: cohort.label,
      cohortKey: params.cohort?.key ?? cohort.label.replace("평대", "").replace("+", ""),
      areaBandVersion: AREA_BAND_VERSION,
      transactionAsOf: asOf,
      referenceMonth,
      selectedMarketPyeongLabel: null,
      complexScopeBasis: "decade_cohort",
      changeUnit: CHANGE_UNIT_V21,
      priceLevelDefinition,
      complexPriceDefinition: COMPLEX_PRICE_DEFINITION_V21,
      complexTrendDefinition: "calendar_month_mean_deal_per_market_pyeong_label",
      regionTrendDefinition,
      areaBasis: AREA_BASIS_V21,
      pyeongLabelVersion: PYEONG_LABEL_VERSION_V21,
      methodologyFingerprint: fingerprint,
      methodologyCopy: { price: priceCopy, trend: TREND_COPY_V21 },
      priceLevel,
      trends,
      complexExactByMarketLabel,
      ...(regionEndpoint === "TRAILING_6M" ? { sampleConfidenceVersion: SAMPLE_CONFIDENCE_VERSION } : {}),
      maxAvailableValue: {
        priceLevel: complexLevel?.meanPricePerSupplyPyeong ?? null,
        trends: maxTrends,
      },
      coverage: { exactMappedTrades: exactMapped, ambiguousExcluded: 0 },
    });
  }

  return { bodies, ambiguousExcluded: 0, exactMapped };
}

/** Overlay COMPLEX scope with an exact market-pyeong label slice. Region scopes unchanged. */
export function applyExactComplexMarketLabel(
  body: PricePositionBodyV21,
  marketPyeongLabel: number | null,
  ambiguity: "exact" | "ambiguous" | "missing",
): PricePositionBodyV21 {
  const next: PricePositionBodyV21 = {
    ...body,
    priceLevel: body.priceLevel.map((cell) => ({ ...cell })),
    trends: Object.fromEntries(
      TREND_HORIZONS_V21.map((horizon) => [horizon, body.trends[horizon].map((cell) => ({ ...cell }))]),
    ) as Record<TrendHorizonV21, TrendCellV21[]>,
    complexExactByMarketLabel: body.complexExactByMarketLabel ?? {},
  };

  if (ambiguity === "ambiguous") {
    next.selectedMarketPyeongLabel = null;
    next.complexScopeBasis = "ambiguous";
    next.priceLevel = next.priceLevel.map((cell) =>
      cell.scope === "COMPLEX"
        ? {
            ...cell,
            meanPricePerSupplyPyeong: null,
            tradeCount: null,
            sampleCount: null,
            contributingComplexCount: null,
            status: "INSUFFICIENT_SAMPLE",
          }
        : cell,
    );
    for (const horizon of TREND_HORIZONS_V21) {
      next.trends[horizon] = next.trends[horizon].map((cell) =>
        cell.scope === "COMPLEX"
          ? {
              ...cell,
              changePercent: null,
              currentMean: null,
              baselineMean: null,
              currentTradeCount: null,
              baselineTradeCount: null,
              matchedComplexCount: null,
              actualCurrentMonth: null,
              actualBaselineMonth: null,
              status: "INSUFFICIENT_SAMPLE",
            }
          : cell,
      );
    }
    next.maxAvailableValue = {
      priceLevel: null,
      trends: Object.fromEntries(TREND_HORIZONS_V21.map((h) => [h, null])) as Record<TrendHorizonV21, number | null>,
    };
    next.status = "INSUFFICIENT_SAMPLE";
    return next;
  }

  if (ambiguity === "missing" || marketPyeongLabel == null) {
    next.selectedMarketPyeongLabel = null;
    next.complexScopeBasis = "unavailable";
    next.priceLevel = next.priceLevel.map((cell) =>
      cell.scope === "COMPLEX"
        ? {
            ...cell,
            meanPricePerSupplyPyeong: null,
            tradeCount: null,
            sampleCount: null,
            contributingComplexCount: null,
            status: "INSUFFICIENT_SAMPLE",
          }
        : cell,
    );
    for (const horizon of TREND_HORIZONS_V21) {
      next.trends[horizon] = next.trends[horizon].map((cell) =>
        cell.scope === "COMPLEX"
          ? {
              ...cell,
              changePercent: null,
              currentMean: null,
              baselineMean: null,
              currentTradeCount: null,
              baselineTradeCount: null,
              matchedComplexCount: null,
              actualCurrentMonth: null,
              actualBaselineMonth: null,
              status: "INSUFFICIENT_SAMPLE",
            }
          : cell,
      );
    }
    next.maxAvailableValue = {
      priceLevel: null,
      trends: Object.fromEntries(TREND_HORIZONS_V21.map((h) => [h, null])) as Record<TrendHorizonV21, number | null>,
    };
    next.status = "INSUFFICIENT_SAMPLE";
    return next;
  }

  const slice = next.complexExactByMarketLabel[String(marketPyeongLabel)];
  if (!slice) {
    return applyExactComplexMarketLabel(body, null, "missing");
  }

  next.selectedMarketPyeongLabel = marketPyeongLabel;
  next.complexScopeBasis = "exact_market_pyeong_label";
  next.referenceMonth = slice.referenceMonth;
  next.priceLevel = next.priceLevel.map((cell) => (cell.scope === "COMPLEX" ? { ...slice.priceLevel } : cell));
  for (const horizon of TREND_HORIZONS_V21) {
    next.trends[horizon] = next.trends[horizon].map((cell) =>
      cell.scope === "COMPLEX" ? { ...slice.trends[horizon] } : cell,
    );
  }
  next.maxAvailableValue = {
    priceLevel: slice.priceLevel.meanPricePerSupplyPyeong,
    trends: Object.fromEntries(
      TREND_HORIZONS_V21.map((horizon) => [horizon, slice.trends[horizon].changePercent]),
    ) as Record<TrendHorizonV21, number | null>,
  };
  next.status = slice.priceLevel.status === "ok" ? "ok" : "INSUFFICIENT_SAMPLE";
  return next;
}

export { exactSupplyPyeong, inSupplyCohort, mean, median, shiftYearMonthV2 };
