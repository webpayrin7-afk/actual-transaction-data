/**
 * Regional trend windows for price-position V2.3.
 * Complex endpoints stay S1. Region endpoints are trailing matched windows.
 * One complex contributes one change. Window price is the pooled trade mean.
 */
import { shiftYearMonthV2 } from "./price-position-v2";
import { monthsBetweenInclusive, type ComplexMonthValue } from "./price-position-v21-audit";

export const REGION_WINDOW_MONTHS_V23 = 6;

export type WindowStatusV23 = "FULL_WINDOW" | "PARTIAL_HISTORY_WINDOW";
export type SampleStatusV23 = "ADEQUATE" | "THIN" | "VERY_THIN";

/**
 * Conservative coverage rule, fixed before publication.
 * VERY_THIN: matched < 5 or coverage < 15%
 * THIN: matched < 20 or coverage < 30%
 * else ADEQUATE
 */
export function sampleStatusV23(matched: number, universe: number): SampleStatusV23 {
  const ratio = universe > 0 ? matched / universe : 0;
  if (matched < 5 || ratio < 0.15) return "VERY_THIN";
  if (matched < 20 || ratio < 0.3) return "THIN";
  return "ADEQUATE";
}

export type RegionWindowV23 = {
  status: WindowStatusV23;
  length: number;
  currentStart: string;
  currentEnd: string;
  baselineStart: string;
  baselineEnd: string;
};

/**
 * Trailing `nominalMonths` ending on the reference month, and the same length
 * ending on the horizon baseline month.
 * If the baseline window would start before the history floor, both ends shrink
 * to the loaded overlap. A shortened baseline is never described as a full window.
 * Returns null when the baseline month itself is before the floor.
 */
export function resolveRegionWindowV23(params: {
  referenceMonth: string;
  horizonShift: number;
  historyFloor: string;
  nominalMonths?: number;
}): RegionWindowV23 | null {
  const nominal = params.nominalMonths ?? REGION_WINDOW_MONTHS_V23;
  const baselineEnd = shiftYearMonthV2(params.referenceMonth, -params.horizonShift);
  if (baselineEnd < params.historyFloor) return null;
  const nominalBaselineStart = shiftYearMonthV2(baselineEnd, -(nominal - 1));
  let length = nominal;
  let status: WindowStatusV23 = "FULL_WINDOW";
  if (nominalBaselineStart < params.historyFloor) {
    length = monthsBetweenInclusive(params.historyFloor, baselineEnd) + 1;
    status = "PARTIAL_HISTORY_WINDOW";
  }
  return {
    status,
    length,
    currentEnd: params.referenceMonth,
    currentStart: shiftYearMonthV2(params.referenceMonth, -(length - 1)),
    baselineEnd,
    baselineStart: shiftYearMonthV2(baselineEnd, -(length - 1)),
  };
}

export function windowsOverlap(left: RegionWindowV23): boolean {
  return left.currentStart <= left.baselineEnd && left.baselineStart <= left.currentEnd;
}

/** Pooled mean of deal-level price-per-market-pyeong. Months with more trades weigh more inside one complex. */
export function pooledWindowMean(
  cells: Map<string, ComplexMonthValue>,
  start: string,
  end: string,
  asOfMonth: string,
): { mean: number; trades: number; months: string[] } | null {
  let weighted = 0;
  let trades = 0;
  const months: string[] = [];
  let month = start;
  while (month <= end) {
    if (month <= asOfMonth) {
      const cell = cells.get(month);
      if (cell && cell.tradeCount > 0) {
        weighted += cell.meanPrice * cell.tradeCount;
        trades += cell.tradeCount;
        months.push(month);
      }
    }
    month = shiftYearMonthV2(month, 1);
  }
  if (trades === 0) return null;
  return { mean: weighted / trades, trades, months };
}

/** Equal-weight mean of monthly complex means. Audit-only. Not the published statistic. */
export function equalMonthWindowMean(
  cells: Map<string, ComplexMonthValue>,
  start: string,
  end: string,
  asOfMonth: string,
): { mean: number; months: number } | null {
  const means: number[] = [];
  let month = start;
  while (month <= end) {
    if (month <= asOfMonth) {
      const cell = cells.get(month);
      if (cell && cell.tradeCount > 0) means.push(cell.meanPrice);
    }
    month = shiftYearMonthV2(month, 1);
  }
  if (!means.length) return null;
  return { mean: means.reduce((sum, value) => sum + value, 0) / means.length, months: means.length };
}
