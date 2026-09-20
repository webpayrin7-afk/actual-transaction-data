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
  resolveComplexMonth,
  TREND_HORIZONS_V21,
  type TrendHorizonV21,
} from "./price-position-v21-audit";

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

export type PriceLevelCellV21 = {
  scope: PriceScopeV21;
  label: string;
  meanPricePerSupplyPyeong: number | null;
  tradeCount: number | null;
  sampleCount: number | null;
  contributingComplexCount: number | null;
  referenceMonth: string | null;
  status: "ok" | "INSUFFICIENT_SAMPLE";
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
};

export type ComplexExactLabelSliceV21 = {
  marketPyeongLabel: number;
  referenceMonth: string;
  priceLevel: PriceLevelCellV21;
  trends: Record<TrendHorizonV21, TrendCellV21>;
};

export type PricePositionBodyV21 = {
  status: "ok" | "INSUFFICIENT_SAMPLE" | "unavailable";
  version: typeof PRICE_POSITION_V21_VERSION;
  complexId: string;
  aptName: string | null;
  areaBand: RegionalAreaBandId;
  supplyPyeongCohort: string;
  areaBandVersion: string;
  transactionAsOf: string;
  referenceMonth: string | null;
  /** Set at read when exclusive_area / market_pyeong_label selects an exact complex series. */
  selectedMarketPyeongLabel: number | null;
  /** How COMPLEX scope was produced for this response. */
  complexScopeBasis: "decade_cohort" | "exact_market_pyeong_label" | "ambiguous" | "unavailable";
  changeUnit: typeof CHANGE_UNIT_V21;
  priceLevelDefinition: typeof PRICE_LEVEL_DEFINITION_V21;
  complexPriceDefinition: typeof COMPLEX_PRICE_DEFINITION_V21;
  complexTrendDefinition: "calendar_month_mean_deal_per_market_pyeong_label";
  regionTrendDefinition: typeof REGION_TREND_DEFINITION_V21;
  areaBasis: typeof AREA_BASIS_V21;
  pyeongLabelVersion: typeof PYEONG_LABEL_VERSION_V21;
  methodologyFingerprint: typeof METHODOLOGY_FINGERPRINT_V21;
  methodologyCopy: { price: string; trend: string };
  priceLevel: PriceLevelCellV21[];
  trends: Record<TrendHorizonV21, TrendCellV21[]>;
  /** Exact-label complex slices inside this decade cohort. Region scopes stay decade. */
  complexExactByMarketLabel: Record<string, ComplexExactLabelSliceV21>;
  maxAvailableValue: {
    priceLevel: number | null;
    trends: Record<TrendHorizonV21, number | null>;
  };
  coverage: {
    exactMappedTrades: number;
    ambiguousExcluded: number;
  };
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
  areaBand: RegionalAreaBandId;
  points: readonly SupplySalePoint[];
  identities: ReadonlyMap<string, ComplexIdentityV2>;
  transactionAsOf?: string;
}): { bodies: PricePositionBodyV21[]; ambiguousExcluded: number; exactMapped: number } {
  const cohort = BAND_TO_SUPPLY_COHORT[params.areaBand];
  const asOf = params.transactionAsOf ?? PRICE_POSITION_V21_AS_OF;
  const asOfMonth = asOf.slice(0, 7);

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
        : inSupplyCohort(point.supplyPyeong, params.areaBand);
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

  const bodies: PricePositionBodyV21[] = [];
  for (const [complexId, referenceMonth] of identityRef) {
    const id = params.identities.get(complexId);
    if (!id) continue;
    const key = dongKey(id.lawdCd, id.bjdongCd);
    const scopeComplexes: Record<PriceScopeV21, string[]> = {
      COMPLEX: [complexId],
      DONG: [...identityRef.keys()].filter((cid) => {
        const other = params.identities.get(cid);
        return other != null && dongKey(other.lawdCd, other.bjdongCd) === key;
      }),
      GU: [...identityRef.keys()].filter((cid) => params.identities.get(cid)?.lawdCd === id.lawdCd),
      SEOUL: [...identityRef.keys()],
    };
    const labels: Record<PriceScopeV21, string> = {
      COMPLEX: "이 단지",
      DONG: id.legalDongName || "동",
      GU: id.lawdCd,
      SEOUL: "서울",
    };

    // Exact-label complex slices (COMPLEX only). Region stays decade.
    const labelPoints = new Map<number, typeof dealPoints>();
    for (const point of dealPoints) {
      if (point.complexId !== complexId) continue;
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
      const values: number[] = [];
      let trades = 0;
      for (const cid of scopeComplexes[scope]) {
        const cell = tables.get(cid)?.get(referenceMonth);
        if (!cell || cell.tradeCount < 1) continue;
        values.push(complexMonthStat(cell, "C1_MEAN"));
        trades += cell.tradeCount;
      }
      const med = median(values);
      const ok = med != null && values.length >= PRICE_MIN_COMPLEXES_V21[scope];
      return {
        scope,
        label: labels[scope],
        meanPricePerSupplyPyeong: ok ? roundToV2(med!, 4) : null,
        tradeCount: values.length ? trades : null,
        sampleCount: values.length || null,
        contributingComplexCount: values.length || null,
        referenceMonth,
        status: ok ? "ok" : "INSUFFICIENT_SAMPLE",
      };
    });

    const trends = {} as Record<TrendHorizonV21, TrendCellV21[]>;
    for (const horizon of TREND_HORIZONS_V21) {
      const baselineTarget = baselineMonthForHorizon(referenceMonth, horizon);
      trends[horizon] = PRICE_SCOPES_V21.map((scope) => {
        if (scope === "COMPLEX") {
          return complexTrendCell(tables.get(complexId) ?? new Map(), referenceMonth, baselineTarget, labels.COMPLEX);
        }

        const changes: number[] = [];
        let matched = 0;
        const actualCurrent = new Set<string>();
        const actualBaseline = new Set<string>();
        for (const cid of scopeComplexes[scope]) {
          const cells = tables.get(cid);
          if (!cells) continue;
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
        const med = median(changes);
        const ok = med != null && matched >= TREND_MIN_COMPLEXES_V21[scope];
        return {
          scope,
          label: labels[scope],
          changePercent: ok ? roundToV2(med!, 2) : null,
          currentMean: null,
          baselineMean: null,
          currentTradeCount: null,
          baselineTradeCount: null,
          matchedComplexCount: matched || null,
          currentMonth: referenceMonth,
          baselineMonth: baselineTarget,
          actualCurrentMonth: actualCurrent.size ? [...actualCurrent].sort().join(",") : null,
          actualBaselineMonth: actualBaseline.size ? [...actualBaseline].sort().join(",") : null,
          status: ok ? "ok" : "INSUFFICIENT_SAMPLE",
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
      version: PRICE_POSITION_V21_VERSION,
      complexId,
      aptName: id.aptName || null,
      areaBand: params.areaBand,
      supplyPyeongCohort: cohort.label,
      areaBandVersion: AREA_BAND_VERSION,
      transactionAsOf: asOf,
      referenceMonth,
      selectedMarketPyeongLabel: null,
      complexScopeBasis: "decade_cohort",
      changeUnit: CHANGE_UNIT_V21,
      priceLevelDefinition: PRICE_LEVEL_DEFINITION_V21,
      complexPriceDefinition: COMPLEX_PRICE_DEFINITION_V21,
      complexTrendDefinition: "calendar_month_mean_deal_per_market_pyeong_label",
      regionTrendDefinition: REGION_TREND_DEFINITION_V21,
      areaBasis: AREA_BASIS_V21,
      pyeongLabelVersion: PYEONG_LABEL_VERSION_V21,
      methodologyFingerprint: METHODOLOGY_FINGERPRINT_V21,
      methodologyCopy: { price: PRICE_COPY_V21, trend: TREND_COPY_V21 },
      priceLevel,
      trends,
      complexExactByMarketLabel,
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
