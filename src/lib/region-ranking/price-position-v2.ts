/**
 * Complex-region price position V2.
 * Frozen methodology: supply-pyeong price level (mean), calendar-month complex trends,
 * matched-complex median region trends within a supply-pyeong cohort.
 * V1 (exclusive ㎡ median) remains historical and is never used as fallback.
 */
import { median } from "./objective-rank";
import { AREA_BAND_VERSION, type RegionalAreaBandId } from "./area-band";

export const PRICE_POSITION_V2_VERSION = "price-position-v2";
export const PRICE_POSITION_V2_AS_OF = "2026-09-17";
export const HISTORY_FLOOR_MONTH_V2 = "2023-07";
export const SUPPLY_PYEONG_FACTOR_V2 = 3.305785;
export const CHANGE_UNIT_V2 = "percentage_points" as const;
export const PRICE_LEVEL_MIN_SAMPLE_V2 = 1;
export const PRICE_LEVEL_DEFINITION_V2 = "reference_month_mean_deal_per_market_pyeong_label" as const;
export const AREA_BASIS_V2 = "SUPPLY_PYEONG_LABEL" as const;
export const PYEONG_LABEL_VERSION_V2 = "canonical-supply-pyeong-round-v1";

export const PRICE_SCOPES_V2 = ["COMPLEX", "DONG", "GU", "SEOUL"] as const;
export type PriceScopeV2 = (typeof PRICE_SCOPES_V2)[number];

export const TREND_HORIZONS_V2 = ["3M", "6M", "1Y", "3Y"] as const;
export type TrendHorizonV2 = (typeof TREND_HORIZONS_V2)[number];

export const HORIZON_SHIFT_MONTHS_V2: Record<TrendHorizonV2, number> = {
  "3M": 3,
  "6M": 6,
  "1Y": 12,
  "3Y": 36,
};

export const TREND_MIN_SAMPLE_V2: Record<PriceScopeV2, number> = {
  COMPLEX: 1,
  DONG: 1,
  GU: 1,
  SEOUL: 1,
};

/** Exclusive area_band → supply-pyeong cohort for V2 (URL area_band stays backward compatible). */
export const BAND_TO_SUPPLY_COHORT: Record<RegionalAreaBandId, { min: number; max: number; label: string }> = {
  "59": { min: 20, max: 30, label: "20평대" },
  "84": { min: 30, max: 40, label: "30평대" },
  "114": { min: 40, max: 50, label: "40평대" },
};

export type SupplySalePoint = {
  complexId: string;
  lawdCd: string;
  bjdongCd: string;
  yearMonth: string;
  /** 만원 / 공급평 (decimal). Kept for audit. User-facing 평당가 uses pricePerMarketPyeong. */
  pricePerSupplyPyeong: number;
  /** 만원 / 평형 integer label. Null when the label is not deterministic. */
  pricePerMarketPyeong: number | null;
  marketPyeongLabel: number | null;
  /** deal_amount in 만원 (mean trend uses this for complex) */
  dealAmount: number;
  exclusiveArea: number;
  supplyArea: number;
  supplyPyeong: number;
};

export type ComplexIdentityV2 = {
  complexId: string;
  lawdCd: string;
  bjdongCd: string;
  aptName: string;
  legalDongName: string;
};

export type PriceLevelCellV2 = {
  scope: PriceScopeV2;
  label: string;
  /** Mean 만원 / 공급평 in reference month */
  meanPricePerSupplyPyeong: number | null;
  tradeCount: number | null;
  sampleCount: number | null;
  referenceMonth: string | null;
  status: "ok" | "INSUFFICIENT_SAMPLE";
};

export type TrendCellV2 = {
  scope: PriceScopeV2;
  label: string;
  changePercent: number | null;
  currentMean: number | null;
  baselineMean: number | null;
  currentTradeCount: number | null;
  baselineTradeCount: number | null;
  matchedComplexCount: number | null;
  currentMonth: string;
  baselineMonth: string;
  status: "ok" | "INSUFFICIENT_SAMPLE";
};

export type PricePositionBodyV2 = {
  status: "ok" | "INSUFFICIENT_SAMPLE" | "unavailable";
  version: typeof PRICE_POSITION_V2_VERSION;
  complexId: string;
  aptName: string | null;
  areaBand: RegionalAreaBandId;
  supplyPyeongCohort: string;
  areaBandVersion: string;
  transactionAsOf: string;
  referenceMonth: string | null;
  changeUnit: typeof CHANGE_UNIT_V2;
  priceLevelDefinition: typeof PRICE_LEVEL_DEFINITION_V2;
  complexTrendDefinition: "calendar_month_mean_deal_amount";
  regionTrendDefinition: "median_of_matched_complex_changes_same_cohort";
  areaBasis: typeof AREA_BASIS_V2;
  pyeongLabelVersion: typeof PYEONG_LABEL_VERSION_V2;
  priceLevel: PriceLevelCellV2[];
  trends: Record<TrendHorizonV2, TrendCellV2[]>;
  maxAvailableValue: {
    priceLevel: number | null;
    trends: Record<TrendHorizonV2, number | null>;
  };
  coverage: {
    exactMappedTrades: number;
    ambiguousExcluded: number;
  };
};

export function pricePositionV2SnapshotId(asOf: string = PRICE_POSITION_V2_AS_OF): string {
  return `${PRICE_POSITION_V2_VERSION}|${asOf}`;
}

export function supplyPyeongCohortLabel(supplyPyeong: number): string | null {
  if (!Number.isFinite(supplyPyeong) || supplyPyeong < 10) return null;
  const decade = Math.floor(supplyPyeong / 10) * 10;
  return `${decade}평대`;
}

export function inSupplyCohort(supplyPyeong: number, band: RegionalAreaBandId): boolean {
  const c = BAND_TO_SUPPLY_COHORT[band];
  return supplyPyeong >= c.min && supplyPyeong < c.max;
}

export function exactSupplyPyeong(supplyAreaSqm: number): number {
  return supplyAreaSqm / SUPPLY_PYEONG_FACTOR_V2;
}

export function pricePerSupplyPyeong(dealAmountManwon: number, supplyAreaSqm: number): number | null {
  if (!(dealAmountManwon > 0) || !(supplyAreaSqm > 0)) return null;
  const py = exactSupplyPyeong(supplyAreaSqm);
  if (!(py > 0)) return null;
  return dealAmountManwon / py;
}

export function dongScopeKeyV2(lawdCd: string, bjdongCd: string): string {
  return `${lawdCd}${bjdongCd}`;
}

export function shiftYearMonthV2(yearMonth: string, deltaMonths: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!match) throw new Error(`bad month ${yearMonth}`);
  const absolute = Number(match[1]) * 12 + (Number(match[2]) - 1) + deltaMonths;
  const year = Math.floor(absolute / 12);
  const month = absolute - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function roundToV2(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function changePercentV2(current: number, baseline: number): number | null {
  if (!(baseline > 0) || !Number.isFinite(current) || !Number.isFinite(baseline)) return null;
  return roundToV2((current / baseline - 1) * 100, 2);
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

type MonthAgg = { prices: number[]; deals: number[] };

function pushAgg(map: Map<string, Map<string, MonthAgg>>, key: string, month: string, price: number, deal: number) {
  let months = map.get(key);
  if (!months) {
    months = new Map();
    map.set(key, months);
  }
  const cell = months.get(month);
  if (cell) {
    cell.prices.push(price);
    cell.deals.push(deal);
  } else {
    months.set(month, { prices: [price], deals: [deal] });
  }
}

function monthMeanPrice(map: Map<string, Map<string, MonthAgg>>, key: string, month: string): { mean: number | null; n: number } {
  const cell = map.get(key)?.get(month);
  if (!cell) return { mean: null, n: 0 };
  return { mean: mean(cell.prices), n: cell.prices.length };
}

function monthMeanDeal(map: Map<string, Map<string, MonthAgg>>, key: string, month: string): { mean: number | null; n: number } {
  const cell = map.get(key)?.get(month);
  if (!cell) return { mean: null, n: 0 };
  return { mean: mean(cell.deals), n: cell.deals.length };
}

/**
 * Build V2 payloads for one area_band / supply cohort.
 * Region trends use matched complexes present in both months (median of complex deal-mean changes).
 */
export function buildPricePositionV2(params: {
  areaBand: RegionalAreaBandId;
  points: readonly SupplySalePoint[];
  identities: ReadonlyMap<string, ComplexIdentityV2>;
  transactionAsOf?: string;
}): { bodies: PricePositionBodyV2[]; ambiguousExcluded: number; exactMapped: number } {
  const cohort = BAND_TO_SUPPLY_COHORT[params.areaBand];
  const byComplex = new Map<string, Map<string, MonthAgg>>();
  const identityRef = new Map<string, string>(); // complex → latest month
  let exactMapped = 0;

  for (const p of params.points) {
    const cohort = BAND_TO_SUPPLY_COHORT[params.areaBand];
    const inCohort = p.marketPyeongLabel != null
      ? p.marketPyeongLabel >= cohort.min && p.marketPyeongLabel < cohort.max
      : inSupplyCohort(p.supplyPyeong, params.areaBand);
    if (!inCohort) continue;
    if (p.yearMonth < HISTORY_FLOOR_MONTH_V2) continue;
    exactMapped += 1;
    if (p.pricePerMarketPyeong != null && Number.isFinite(p.pricePerMarketPyeong)) {
      pushAgg(byComplex, p.complexId, p.yearMonth, p.pricePerMarketPyeong, p.dealAmount);
    } else {
      pushAgg(byComplex, p.complexId, p.yearMonth, Number.NaN, p.dealAmount);
    }
    const prev = identityRef.get(p.complexId);
    if (!prev || p.yearMonth > prev) identityRef.set(p.complexId, p.yearMonth);
  }

  // Precompute per-month complex deal means for region matching
  const complexMonthDeal = new Map<string, Map<string, number>>(); // complex → month → mean deal
  const complexMonthPrice = new Map<string, Map<string, number>>();
  for (const [cid, months] of byComplex) {
    const deals = new Map<string, number>();
    const prices = new Map<string, number>();
    for (const [ym, agg] of months) {
      const d = mean(agg.deals);
      const priced = agg.prices.filter((v) => Number.isFinite(v));
      const pr = mean(priced);
      if (d != null) deals.set(ym, d);
      if (pr != null) prices.set(ym, pr);
    }
    complexMonthDeal.set(cid, deals);
    complexMonthPrice.set(cid, prices);
  }

  const bodies: PricePositionBodyV2[] = [];
  for (const [complexId, referenceMonth] of identityRef) {
    const id = params.identities.get(complexId);
    if (!id) continue;
    const dongKey = dongScopeKeyV2(id.lawdCd, id.bjdongCd);

    // Scope membership: complexes sharing dong/gu/seoul
    const scopeComplexes: Record<PriceScopeV2, string[]> = {
      COMPLEX: [complexId],
      DONG: [...identityRef.keys()].filter((c) => {
        const o = params.identities.get(c);
        return o && dongScopeKeyV2(o.lawdCd, o.bjdongCd) === dongKey;
      }),
      GU: [...identityRef.keys()].filter((c) => params.identities.get(c)?.lawdCd === id.lawdCd),
      SEOUL: [...identityRef.keys()],
    };

    const labels: Record<PriceScopeV2, string> = {
      COMPLEX: "이 단지",
      DONG: id.legalDongName || "동",
      GU: id.lawdCd,
      SEOUL: "서울",
    };

    const priceLevel: PriceLevelCellV2[] = PRICE_SCOPES_V2.map((scope) => {
      const prices: number[] = [];
      for (const cid of scopeComplexes[scope]) {
        const m = monthMeanPrice(byComplex, cid, referenceMonth);
        if (m.mean != null) {
          // for dong/gu/seoul: pool all trades in month via reconstituting from aggs
        const cell = byComplex.get(cid)?.get(referenceMonth);
        if (cell) prices.push(...cell.prices.filter((v) => Number.isFinite(v)));
        }
      }
      const n = prices.length;
      const m = mean(prices);
      const ok = m != null && n >= PRICE_LEVEL_MIN_SAMPLE_V2;
      return {
        scope,
        label: labels[scope],
        meanPricePerSupplyPyeong: ok ? roundToV2(m!, 4) : null,
        tradeCount: n || null,
        sampleCount: n || null,
        referenceMonth,
        status: ok ? "ok" : "INSUFFICIENT_SAMPLE",
      };
    });

    const trends = {} as Record<TrendHorizonV2, TrendCellV2[]>;
    for (const horizon of TREND_HORIZONS_V2) {
      const baselineMonth = shiftYearMonthV2(referenceMonth, -HORIZON_SHIFT_MONTHS_V2[horizon]);
      const cells: TrendCellV2[] = PRICE_SCOPES_V2.map((scope) => {
        if (scope === "COMPLEX") {
          const cur = monthMeanDeal(byComplex, complexId, referenceMonth);
          const base = monthMeanDeal(byComplex, complexId, baselineMonth);
          const ch = cur.mean != null && base.mean != null ? changePercentV2(cur.mean, base.mean) : null;
          const ok = ch != null && cur.n >= TREND_MIN_SAMPLE_V2.COMPLEX && base.n >= TREND_MIN_SAMPLE_V2.COMPLEX;
          return {
            scope,
            label: labels[scope],
            changePercent: ok ? ch : null,
            currentMean: cur.mean != null ? roundToV2(cur.mean, 2) : null,
            baselineMean: base.mean != null ? roundToV2(base.mean, 2) : null,
            currentTradeCount: cur.n || null,
            baselineTradeCount: base.n || null,
            matchedComplexCount: ok ? 1 : null,
            currentMonth: referenceMonth,
            baselineMonth,
            status: ok ? "ok" : "INSUFFICIENT_SAMPLE",
          };
        }
        // Region: matched complexes with both months, median of complex deal-mean changes
        const changes: number[] = [];
        let matched = 0;
        for (const cid of scopeComplexes[scope]) {
          const deals = complexMonthDeal.get(cid);
          if (!deals) continue;
          const cur = deals.get(referenceMonth);
          const base = deals.get(baselineMonth);
          if (cur == null || base == null || !(base > 0)) continue;
          const ch = changePercentV2(cur, base);
          if (ch == null) continue;
          changes.push(ch);
          matched += 1;
        }
        const med = median(changes);
        const ok = med != null && matched >= TREND_MIN_SAMPLE_V2[scope];
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
          baselineMonth,
          status: ok ? "ok" : "INSUFFICIENT_SAMPLE",
        };
      });
      trends[horizon] = cells;
    }

    const complexLevel = priceLevel.find((c) => c.scope === "COMPLEX");
    const maxTrends = {} as Record<TrendHorizonV2, number | null>;
    for (const h of TREND_HORIZONS_V2) {
      maxTrends[h] = trends[h].find((c) => c.scope === "COMPLEX")?.changePercent ?? null;
    }

    bodies.push({
      status: complexLevel?.status === "ok" ? "ok" : "INSUFFICIENT_SAMPLE",
      version: PRICE_POSITION_V2_VERSION,
      complexId,
      aptName: id.aptName || null,
      areaBand: params.areaBand,
      supplyPyeongCohort: cohort.label,
      areaBandVersion: AREA_BAND_VERSION,
      transactionAsOf: params.transactionAsOf ?? PRICE_POSITION_V2_AS_OF,
      referenceMonth,
      changeUnit: CHANGE_UNIT_V2,
      priceLevelDefinition: PRICE_LEVEL_DEFINITION_V2,
      complexTrendDefinition: "calendar_month_mean_deal_amount",
      regionTrendDefinition: "median_of_matched_complex_changes_same_cohort",
      areaBasis: AREA_BASIS_V2,
      pyeongLabelVersion: PYEONG_LABEL_VERSION_V2,
      priceLevel,
      trends,
      maxAvailableValue: {
        priceLevel: complexLevel?.meanPricePerSupplyPyeong ?? null,
        trends: maxTrends,
      },
      coverage: { exactMappedTrades: exactMapped, ambiguousExcluded: 0 },
    });
  }

  return { bodies, ambiguousExcluded: 0, exactMapped };
}
