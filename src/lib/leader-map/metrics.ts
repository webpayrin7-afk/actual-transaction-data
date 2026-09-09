import { toPyeong } from "@/lib/utils/format";
import {
  areaTypeKey,
  previousTypeDealAmount,
  vsPreviousTypeDeal,
} from "@/lib/region/market-insight";
import type { LeaderChange, LeaderDeal, LeaderSampleQuality } from "./types";

export const LEADER_WINDOW_MONTHS = 12;
export const NORMALIZED_AREA_SQM = 84;
export const SAMPLE_GOOD_MIN = 5;
export const SAMPLE_FALLBACK_MIN = 3;

export type LeaderTrade = {
  dealDate: string;
  dealAmount: number;
  exclusiveArea: number;
  floor: number;
};

export type ComplexLeaderStats = {
  complexKey: string;
  lawdCd: string;
  gu: string;
  dong: string;
  aptName: string;
  aptNameNorm: string;
  tradeCount12m: number;
  medianPpsqm: number;
  medianPyeongPrice: number;
  normalized84Price: number;
  latestDeal: LeaderDeal;
  previousDeal: LeaderDeal | null;
  latestChange: LeaderChange | null;
  sampleQuality: LeaderSampleQuality;
};

/** 만원 / ㎡. 비정상 금액·면적은 제외. */
export function pricePerM2(
  dealAmount: number,
  exclusiveArea: number,
): number | null {
  if (!(dealAmount > 0) || !(exclusiveArea > 0)) return null;
  return dealAmount / exclusiveArea;
}

export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function normalized84Price(medianPpsqm: number): number {
  return Math.round(medianPpsqm * NORMALIZED_AREA_SQM);
}

export function medianPyeongPriceManwon(trades: LeaderTrade[]): number | null {
  const prices: number[] = [];
  for (const trade of trades) {
    if (!(trade.dealAmount > 0) || !(trade.exclusiveArea > 0)) continue;
    const pyeong = toPyeong(trade.exclusiveArea);
    if (!(pyeong > 0)) continue;
    prices.push(trade.dealAmount / pyeong);
  }
  const med = medianOf(prices);
  return med == null ? null : Math.round(med);
}

export function sampleQualityForCount(count: number): LeaderSampleQuality {
  return count >= SAMPLE_GOOD_MIN ? "GOOD" : "LOW";
}

/**
 * 지역 안 단지 trade counts를 보고 최소 표본 임계값을 고른다.
 * 5건 이상 단지가 있으면 5, 없으면 3, 그마저 없으면 1.
 */
export function minSampleThreshold(complexCounts: number[]): number {
  if (complexCounts.some((c) => c >= SAMPLE_GOOD_MIN)) return SAMPLE_GOOD_MIN;
  if (complexCounts.some((c) => c >= SAMPLE_FALLBACK_MIN)) {
    return SAMPLE_FALLBACK_MIN;
  }
  if (complexCounts.some((c) => c >= 1)) return 1;
  return 0;
}

export function compareLeaderStats(
  a: Pick<
    ComplexLeaderStats,
    "normalized84Price" | "latestDeal" | "tradeCount12m"
  >,
  b: Pick<
    ComplexLeaderStats,
    "normalized84Price" | "latestDeal" | "tradeCount12m"
  >,
): number {
  if (a.normalized84Price !== b.normalized84Price) {
    return b.normalized84Price - a.normalized84Price;
  }
  const dateCmp = b.latestDeal.dealDate.localeCompare(a.latestDeal.dealDate);
  if (dateCmp !== 0) return dateCmp;
  return b.tradeCount12m - a.tradeCount12m;
}

export function pickLeader<T extends ComplexLeaderStats>(
  candidates: T[],
): T | null {
  const threshold = minSampleThreshold(candidates.map((c) => c.tradeCount12m));
  if (threshold === 0) return null;
  const eligible = candidates.filter((c) => c.tradeCount12m >= threshold);
  eligible.sort(compareLeaderStats);
  return eligible[0] ?? null;
}

function latestTradeOf(trades: LeaderTrade[]): LeaderTrade | null {
  let best: LeaderTrade | null = null;
  for (const trade of trades) {
    const day = trade.dealDate.slice(0, 10);
    if (!best) {
      best = trade;
      continue;
    }
    const bestDay = best.dealDate.slice(0, 10);
    if (day > bestDay) best = trade;
    else if (day === bestDay && trade.dealAmount > best.dealAmount) best = trade;
  }
  return best;
}

function previousSameTypeDeal(
  trades: LeaderTrade[],
  latest: LeaderTrade,
): LeaderDeal | null {
  const history = trades.map((t) => ({
    exclusiveArea: t.exclusiveArea,
    dealDate: t.dealDate,
    dealAmount: t.dealAmount,
  }));
  const prevAmount = previousTypeDealAmount({
    exclusiveArea: latest.exclusiveArea,
    dealDate: latest.dealDate,
    history,
  });
  if (prevAmount == null) return null;
  const key = areaTypeKey(latest.exclusiveArea);
  const day = latest.dealDate.slice(0, 10);
  let bestDate = "";
  let best: LeaderTrade | null = null;
  for (const trade of trades) {
    if (areaTypeKey(trade.exclusiveArea) !== key) continue;
    const d = trade.dealDate.slice(0, 10);
    if (d >= day) continue;
    if (d >= bestDate) {
      bestDate = d;
      best = trade;
    }
  }
  if (!best) return null;
  return {
    dealDate: best.dealDate.slice(0, 10),
    dealAmount: best.dealAmount,
    exclusiveArea: best.exclusiveArea,
    floor: best.floor,
  };
}

export function buildComplexStats(params: {
  complexKey: string;
  lawdCd: string;
  gu: string;
  dong: string;
  aptName: string;
  aptNameNorm: string;
  trades: LeaderTrade[];
}): ComplexLeaderStats | null {
  const valid: LeaderTrade[] = [];
  const ppsqm: number[] = [];
  for (const trade of params.trades) {
    const unit = pricePerM2(trade.dealAmount, trade.exclusiveArea);
    if (unit == null) continue;
    valid.push({
      ...trade,
      dealDate: trade.dealDate.slice(0, 10),
    });
    ppsqm.push(unit);
  }
  if (valid.length === 0) return null;
  const medianPpsqm = medianOf(ppsqm);
  if (medianPpsqm == null) return null;
  const latest = latestTradeOf(valid);
  if (!latest) return null;
  const previous = previousSameTypeDeal(valid, latest);
  const vs = vsPreviousTypeDeal(latest.dealAmount, previous?.dealAmount ?? null);
  let latestChange: LeaderChange | null = null;
  if (vs && previous) {
    const pct =
      previous.dealAmount > 0
        ? Math.round(
            ((latest.dealAmount - previous.dealAmount) / previous.dealAmount) *
              1000,
          ) / 10
        : null;
    latestChange = {
      direction: vs.kind,
      amount: vs.kind === "same" ? 0 : vs.amount,
      pct,
    };
  }
  const pyeongMed = medianPyeongPriceManwon(valid);
  return {
    complexKey: params.complexKey,
    lawdCd: params.lawdCd,
    gu: params.gu,
    dong: params.dong,
    aptName: params.aptName,
    aptNameNorm: params.aptNameNorm,
    tradeCount12m: valid.length,
    medianPpsqm,
    medianPyeongPrice: pyeongMed ?? Math.round(medianPpsqm * 3.3058),
    normalized84Price: normalized84Price(medianPpsqm),
    latestDeal: {
      dealDate: latest.dealDate.slice(0, 10),
      dealAmount: latest.dealAmount,
      exclusiveArea: latest.exclusiveArea,
      floor: latest.floor,
    },
    previousDeal: previous,
    latestChange,
    sampleQuality: sampleQualityForCount(valid.length),
  };
}

export function rankEligible(
  complexes: ComplexLeaderStats[],
  minCount = SAMPLE_GOOD_MIN,
): ComplexLeaderStats[] {
  return complexes
    .filter((c) => c.tradeCount12m >= minCount)
    .sort(compareLeaderStats);
}

export function windowFromTo(toDay: string, months = LEADER_WINDOW_MONTHS): {
  from: string;
  to: string;
} {
  const d = new Date(`${toDay.slice(0, 10)}T00:00:00`);
  d.setMonth(d.getMonth() - months);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return { from: `${y}-${m}-${day}`, to: toDay.slice(0, 10) };
}

export function yearMonthsInclusive(fromDay: string, toDay: string): string[] {
  let y = Number(fromDay.slice(0, 4));
  let m = Number(fromDay.slice(5, 7));
  const ey = Number(toDay.slice(0, 4));
  const em = Number(toDay.slice(5, 7));
  const out: string[] = [];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 24) break;
  }
  return out;
}

export function complexKeyOf(
  lawdCd: string,
  dong: string,
  aptNameNorm: string,
): string {
  return `${lawdCd}|${dong}|${aptNameNorm}`;
}
