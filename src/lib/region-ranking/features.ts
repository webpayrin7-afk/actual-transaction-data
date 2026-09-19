/**
 * Generic feature extraction. No weights, gates, or rank output.
 * building_count is intentionally absent.
 */

import { inAreaBand, type AreaBandDef } from "./area-band";
import { inWindow, type RankingWindows } from "./snapshot";

export type DealRow = {
  dealDate: string;
  exclusiveArea: number;
  dealAmount: number;
};

export type ProfileInput = {
  householdCount: number | null;
  source: string | null;
  sourceKey: string | null;
  sourceAsOf: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING";
};

export type FeatureInputs = {
  tradeCount: number;
  medianDealAmount: number | null;
  medianPricePerSqm: number | null;
  householdCount: number | null;
  turnover: number | null;
  activeMonthCount: number;
  latestDealDate: string | null;
  monthlyTradeCounts: number[];
  recent3mTradeCount: number;
  previous3mTradeCount: number;
  recent3mMedianDealAmount: number | null;
  previous3mMedianDealAmount: number | null;
  recent3mMedianPricePerSqm: number | null;
  previous3mMedianPricePerSqm: number | null;
  profile: ProfileInput;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function monthKey(dealDate: string): string {
  return dealDate.slice(0, 7);
}

function summarize(deals: DealRow[]) {
  const amounts = deals.map((row) => row.dealAmount);
  const ppsqm = deals
    .filter((row) => row.exclusiveArea > 0)
    .map((row) => row.dealAmount / row.exclusiveArea);
  return {
    tradeCount: deals.length,
    medianDealAmount: median(amounts),
    medianPricePerSqm: median(ppsqm),
  };
}

export function extractFeatures(params: {
  deals: readonly DealRow[];
  band: AreaBandDef;
  windows: RankingWindows;
  profile: ProfileInput;
}): FeatureInputs {
  const bandDeals = params.deals.filter(
    (row) =>
      inWindow(row.dealDate, params.windows.base12m) &&
      inAreaBand(row.exclusiveArea, params.band),
  );
  const base = summarize(bandDeals);
  const recent = summarize(
    bandDeals.filter((row) => inWindow(row.dealDate, params.windows.recent3m)),
  );
  const previous = summarize(
    bandDeals.filter((row) => inWindow(row.dealDate, params.windows.previous3m)),
  );
  const months = new Map<string, number>();
  for (const row of bandDeals) {
    const key = monthKey(row.dealDate);
    months.set(key, (months.get(key) ?? 0) + 1);
  }
  const household = params.profile.householdCount;
  const turnover =
    household != null && household > 0 ? base.tradeCount / household : null;
  const latest = bandDeals.reduce<string | null>((max, row) => {
    const day = row.dealDate.slice(0, 10);
    return max == null || day > max ? day : max;
  }, null);
  return {
    tradeCount: base.tradeCount,
    medianDealAmount: base.medianDealAmount,
    medianPricePerSqm: base.medianPricePerSqm,
    householdCount: household,
    turnover,
    activeMonthCount: months.size,
    latestDealDate: latest,
    monthlyTradeCounts: [...months.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, count]) => count),
    recent3mTradeCount: recent.tradeCount,
    previous3mTradeCount: previous.tradeCount,
    recent3mMedianDealAmount: recent.medianDealAmount,
    previous3mMedianDealAmount: previous.medianDealAmount,
    recent3mMedianPricePerSqm: recent.medianPricePerSqm,
    previous3mMedianPricePerSqm: previous.medianPricePerSqm,
    profile: params.profile,
  };
}
