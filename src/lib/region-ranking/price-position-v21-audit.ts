/**
 * Isolated audit helpers for proposed price-position-v2.1 region metrics.
 * Not wired to the public read path. Does not mutate V2 rows.
 */
import { median } from "./objective-rank";
import { shiftYearMonthV2 } from "./price-position-v2";

export const TREND_HORIZONS_V21 = ["6M", "1Y", "2Y", "5Y"] as const;
export type TrendHorizonV21 = (typeof TREND_HORIZONS_V21)[number];

export const HORIZON_SHIFT_MONTHS_V21: Record<TrendHorizonV21, number> = {
  "6M": 6,
  "1Y": 12,
  "2Y": 24,
  "5Y": 60,
};

export const PRICE_CANDIDATES_V21 = ["P0", "P1", "P2", "P3", "P4", "P5", "P6"] as const;
export type PriceCandidateV21 = (typeof PRICE_CANDIDATES_V21)[number];

export const TREND_CANDIDATES_V21 = ["T0", "T1", "T2", "T3", "T4"] as const;
export type TrendCandidateV21 = (typeof TREND_CANDIDATES_V21)[number];

export const SPARSE_POLICIES_V21 = ["S0", "S1", "S2"] as const;
export type SparsePolicyV21 = (typeof SPARSE_POLICIES_V21)[number];

export type ComplexMonthStat = "C1_MEAN" | "C2_MEDIAN";

export type DealPoint = {
  complexId: string;
  lawdCd: string;
  bjdongCd: string;
  yearMonth: string;
  /** 만원 / integer market pyeong label */
  pricePerMarketPyeong: number;
  dealAmount: number;
};

export type ComplexMonthValue = {
  complexId: string;
  yearMonth: string;
  meanPrice: number;
  medianPrice: number;
  tradeCount: number;
};

export function mean(values: readonly number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function roundAudit(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** Calendar months earlier than reference. Exact contract-month semantics. */
export function baselineMonthForHorizon(referenceMonth: string, horizon: TrendHorizonV21): string {
  return shiftYearMonthV2(referenceMonth, -HORIZON_SHIFT_MONTHS_V21[horizon]);
}

export function monthsBetweenInclusive(earlier: string, later: string): number {
  const a = /^(\d{4})-(\d{2})$/.exec(earlier);
  const b = /^(\d{4})-(\d{2})$/.exec(later);
  if (!a || !b) throw new Error(`bad month ${earlier}/${later}`);
  return Number(b[1]) * 12 + Number(b[2]) - (Number(a[1]) * 12 + Number(a[2]));
}

/**
 * Aggregate deals into complex-month mean/median market-pyeong prices.
 * C1 = arithmetic mean, C2 = median.
 */
export function buildComplexMonthValues(points: readonly DealPoint[]): Map<string, Map<string, ComplexMonthValue>> {
  const buckets = new Map<string, Map<string, number[]>>();
  for (const point of points) {
    if (!(point.pricePerMarketPyeong > 0)) continue;
    let months = buckets.get(point.complexId);
    if (!months) {
      months = new Map();
      buckets.set(point.complexId, months);
    }
    const list = months.get(point.yearMonth) ?? [];
    list.push(point.pricePerMarketPyeong);
    months.set(point.yearMonth, list);
  }
  const out = new Map<string, Map<string, ComplexMonthValue>>();
  for (const [complexId, months] of buckets) {
    const cells = new Map<string, ComplexMonthValue>();
    for (const [yearMonth, prices] of months) {
      const meanPrice = mean(prices);
      const medianPrice = median(prices);
      if (meanPrice == null || medianPrice == null) continue;
      cells.set(yearMonth, {
        complexId,
        yearMonth,
        meanPrice,
        medianPrice,
        tradeCount: prices.length,
      });
    }
    out.set(complexId, cells);
  }
  return out;
}

export function complexMonthStat(cell: ComplexMonthValue, kind: ComplexMonthStat): number {
  return kind === "C1_MEAN" ? cell.meanPrice : cell.medianPrice;
}

/**
 * Resolve a complex value for a target month under sparse policy.
 * Returns the actual month used. Never uses months after asOfMonth.
 */
export function resolveComplexMonth(params: {
  cells: Map<string, ComplexMonthValue>;
  targetMonth: string;
  asOfMonth: string;
  sparse: SparsePolicyV21;
  minTrades: number;
}): { month: string; cell: ComplexMonthValue } | null {
  const { cells, targetMonth, asOfMonth, sparse, minTrades } = params;
  if (targetMonth > asOfMonth) return null;
  const window = sparse === "S0" ? 0 : sparse === "S1" ? 1 : 2;
  let best: { month: string; cell: ComplexMonthValue; distance: number } | null = null;
  for (let delta = -window; delta <= window; delta += 1) {
    const month = shiftYearMonthV2(targetMonth, delta);
    if (month > asOfMonth) continue;
    const cell = cells.get(month);
    if (!cell || cell.tradeCount < minTrades) continue;
    const distance = Math.abs(delta);
    if (!best || distance < best.distance || (distance === best.distance && month > best.month)) {
      best = { month, cell, distance };
    }
  }
  return best ? { month: best.month, cell: best.cell } : null;
}

export type RegionPriceResult = {
  candidate: PriceCandidateV21;
  value: number | null;
  complexCount: number;
  tradeCount: number;
  monthsUsed: string[];
};

function pickComplexValues(
  complexIds: readonly string[],
  tables: Map<string, Map<string, ComplexMonthValue>>,
  referenceMonth: string,
  asOfMonth: string,
  sparse: SparsePolicyV21,
  minComplexTrades: number,
  lookbackMonths: number,
  kind: ComplexMonthStat,
): Array<{ complexId: string; value: number; month: string; trades: number }> {
  const out: Array<{ complexId: string; value: number; month: string; trades: number }> = [];
  for (const complexId of complexIds) {
    const cells = tables.get(complexId);
    if (!cells) continue;
    if (lookbackMonths === 0) {
      const hit = resolveComplexMonth({ cells, targetMonth: referenceMonth, asOfMonth, sparse, minTrades: minComplexTrades });
      if (!hit) continue;
      out.push({
        complexId,
        value: complexMonthStat(hit.cell, kind),
        month: hit.month,
        trades: hit.cell.tradeCount,
      });
      continue;
    }
    // Latest valid month within lookbackMonths of reference (inclusive of reference).
    let latest: { month: string; cell: ComplexMonthValue } | null = null;
    for (let delta = 0; delta <= lookbackMonths; delta += 1) {
      const month = shiftYearMonthV2(referenceMonth, -delta);
      if (month > asOfMonth) continue;
      const cell = cells.get(month);
      if (!cell || cell.tradeCount < minComplexTrades) continue;
      if (!latest || month > latest.month) latest = { month, cell };
    }
    if (!latest) continue;
    out.push({
      complexId,
      value: complexMonthStat(latest.cell, kind),
      month: latest.month,
      trades: latest.cell.tradeCount,
    });
  }
  return out;
}

/**
 * Region price candidates.
 * P0 pools trades (caller supplies pooled trade prices for reference month).
 * P1–P6 are complex-first.
 */
export function regionPriceCandidate(params: {
  candidate: PriceCandidateV21;
  complexIds: readonly string[];
  tables: Map<string, Map<string, ComplexMonthValue>>;
  referenceMonth: string;
  asOfMonth: string;
  sparse: SparsePolicyV21;
  minComplexTrades: number;
  kind: ComplexMonthStat;
  /** Required for P0: all trade prices in the exact reference month for the scope. */
  pooledTradePrices?: readonly number[];
}): RegionPriceResult {
  const { candidate } = params;
  if (candidate === "P0") {
    const prices = [...(params.pooledTradePrices ?? [])].filter((n) => n > 0);
    return {
      candidate,
      value: prices.length ? roundAudit(mean(prices)!) : null,
      complexCount: 0,
      tradeCount: prices.length,
      monthsUsed: prices.length ? [params.referenceMonth] : [],
    };
  }
  const lookback =
    candidate === "P1" || candidate === "P2"
      ? 0
      : candidate === "P3" || candidate === "P4"
        ? 3
        : 6;
  const useMedian = candidate === "P2" || candidate === "P4" || candidate === "P6";
  const sparse = lookback === 0 ? params.sparse : "S0";
  const rows = pickComplexValues(
    params.complexIds,
    params.tables,
    params.referenceMonth,
    params.asOfMonth,
    sparse,
    params.minComplexTrades,
    lookback,
    params.kind,
  );
  const values = rows.map((row) => row.value);
  const agg = useMedian ? median(values) : mean(values);
  return {
    candidate,
    value: agg == null ? null : roundAudit(agg),
    complexCount: rows.length,
    tradeCount: rows.reduce((sum, row) => sum + row.trades, 0),
    monthsUsed: [...new Set(rows.map((row) => row.month))].sort(),
  };
}

export type RegionTrendResult = {
  candidate: TrendCandidateV21;
  changePercent: number | null;
  matchedComplexes: number;
  currentValue: number | null;
  baselineValue: number | null;
  currentMonths: string[];
  baselineMonths: string[];
};

function changePercent(current: number, baseline: number): number | null {
  if (!(baseline > 0) || !Number.isFinite(current)) return null;
  return roundAudit((current / baseline - 1) * 100, 2);
}

function geometricMeanRelative(relatives: readonly number[]): number | null {
  if (!relatives.length) return null;
  const logSum = relatives.reduce((sum, value) => sum + Math.log(value), 0);
  return Math.exp(logSum / relatives.length);
}

/**
 * Matched-complex region trends for one horizon.
 * Same complex population at both endpoints.
 */
export function regionTrendCandidate(params: {
  candidate: TrendCandidateV21;
  complexIds: readonly string[];
  tables: Map<string, Map<string, ComplexMonthValue>>;
  referenceMonth: string;
  horizon: TrendHorizonV21;
  asOfMonth: string;
  sparse: SparsePolicyV21;
  minComplexTrades: number;
  kind: ComplexMonthStat;
}): RegionTrendResult {
  const baselineTarget = baselineMonthForHorizon(params.referenceMonth, params.horizon);
  const pairs: Array<{ current: number; baseline: number; currentMonth: string; baselineMonth: string }> = [];
  for (const complexId of params.complexIds) {
    const cells = params.tables.get(complexId);
    if (!cells) continue;
    const cur = resolveComplexMonth({
      cells,
      targetMonth: params.referenceMonth,
      asOfMonth: params.asOfMonth,
      sparse: params.sparse,
      minTrades: params.minComplexTrades,
    });
    const base = resolveComplexMonth({
      cells,
      targetMonth: baselineTarget,
      asOfMonth: params.asOfMonth,
      sparse: params.sparse,
      minTrades: params.minComplexTrades,
    });
    if (!cur || !base) continue;
    pairs.push({
      current: complexMonthStat(cur.cell, params.kind),
      baseline: complexMonthStat(base.cell, params.kind),
      currentMonth: cur.month,
      baselineMonth: base.month,
    });
  }
  const matched = pairs.length;
  const currentMonths = [...new Set(pairs.map((row) => row.currentMonth))].sort();
  const baselineMonths = [...new Set(pairs.map((row) => row.baselineMonth))].sort();
  if (!matched) {
    return {
      candidate: params.candidate,
      changePercent: null,
      matchedComplexes: 0,
      currentValue: null,
      baselineValue: null,
      currentMonths,
      baselineMonths,
    };
  }

  if (params.candidate === "T0" || params.candidate === "T1" || params.candidate === "T2") {
    const changes: number[] = [];
    const relatives: number[] = [];
    for (const pair of pairs) {
      const ch = changePercent(pair.current, pair.baseline);
      if (ch == null) continue;
      changes.push(ch);
      relatives.push(pair.current / pair.baseline);
    }
    let value: number | null = null;
    if (params.candidate === "T0") value = median(changes);
    else if (params.candidate === "T1") value = mean(changes);
    else {
      const geo = geometricMeanRelative(relatives);
      value = geo == null ? null : roundAudit((geo - 1) * 100, 2);
    }
    return {
      candidate: params.candidate,
      changePercent: value == null ? null : roundAudit(value, 2),
      matchedComplexes: matched,
      currentValue: null,
      baselineValue: null,
      currentMonths,
      baselineMonths,
    };
  }

  const currentValues = pairs.map((pair) => pair.current);
  const baselineValues = pairs.map((pair) => pair.baseline);
  const currentAgg = params.candidate === "T3" ? mean(currentValues) : median(currentValues);
  const baselineAgg = params.candidate === "T3" ? mean(baselineValues) : median(baselineValues);
  const ch = currentAgg != null && baselineAgg != null ? changePercent(currentAgg, baselineAgg) : null;
  return {
    candidate: params.candidate,
    changePercent: ch,
    matchedComplexes: matched,
    currentValue: currentAgg == null ? null : roundAudit(currentAgg),
    baselineValue: baselineAgg == null ? null : roundAudit(baselineAgg),
    currentMonths,
    baselineMonths,
  };
}

export function stabilityStats(series: readonly Array<{ month: string; value: number | null; sample: number }>) {
  const usable = series.filter((row) => row.value != null) as Array<{ month: string; value: number; sample: number }>;
  const mom: number[] = [];
  for (let i = 1; i < usable.length; i += 1) {
    const prev = usable[i - 1]!;
    const cur = usable[i]!;
    if (prev.value > 0) mom.push(Math.abs((cur.value / prev.value - 1) * 100));
  }
  const samples = usable.map((row) => row.sample);
  const sampleDeltas: number[] = [];
  for (let i = 1; i < samples.length; i += 1) sampleDeltas.push(Math.abs(samples[i]! - samples[i - 1]!));
  return {
    months: usable.length,
    medianAbsMomPct: median(mom),
    maxAbsMomPct: mom.length ? Math.max(...mom) : null,
    maxSampleDelta: sampleDeltas.length ? Math.max(...sampleDeltas) : null,
    minSample: samples.length ? Math.min(...samples) : null,
    maxSample: samples.length ? Math.max(...samples) : null,
  };
}

/** Composition-bias probe: remove the highest-liquidity complex and measure price shift. */
export function compositionSensitivity(params: {
  withAll: number | null;
  withoutTopComplex: number | null;
}): number | null {
  if (params.withAll == null || params.withoutTopComplex == null || !(params.withAll > 0)) return null;
  return roundAudit(Math.abs((params.withoutTopComplex / params.withAll - 1) * 100), 2);
}
