/**
 * V3 feature extraction.
 * Decade features use deterministic market_pyeong_label cohorts.
 * Missing 12M price may fall back to a longer lookback (STALE_BUT_USABLE), never invented.
 */
import { inWindow, type RankingWindows } from "./snapshot";
import type { ProfileInput } from "./features";
import type { ComponentAvailabilityV3, DecadeCohortV3 } from "./ranking-v3";

export type LabeledDeal = {
  dealDate: string;
  exclusiveArea: number;
  dealAmount: number;
  marketPyeongLabel: number;
};

export type FeatureInputsV3 = {
  tradeCount: number;
  medianDealAmount: number | null;
  /** 만원 / market pyeong label. Null when no usable price. */
  medianPricePerMarketPyeong: number | null;
  priceAvailability: ComponentAvailabilityV3;
  householdCount: number | null;
  householdAvailability: ComponentAvailabilityV3;
  turnover: number | null;
  turnoverAvailability: ComponentAvailabilityV3;
  activeMonthCount: number;
  latestDealDate: string | null;
  recent3mTradeCount: number;
  previous3mTradeCount: number;
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

function shiftMonths(isoDate: string, months: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error(`bad date ${isoDate}`);
  const dt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
}

function summarizePrice(deals: readonly LabeledDeal[]) {
  const amounts = deals.map((row) => row.dealAmount);
  const perLabel = deals
    .filter((row) => row.marketPyeongLabel > 0)
    .map((row) => row.dealAmount / row.marketPyeongLabel);
  return {
    tradeCount: deals.length,
    medianDealAmount: median(amounts),
    medianPricePerMarketPyeong: median(perLabel),
  };
}

function filterCohort(deals: readonly LabeledDeal[], cohort: DecadeCohortV3 | null): LabeledDeal[] {
  if (!cohort) return [...deals];
  return deals.filter((row) => row.marketPyeongLabel >= cohort.min && row.marketPyeongLabel < cohort.max);
}

export function extractFeaturesV3(params: {
  deals: readonly LabeledDeal[];
  cohort: DecadeCohortV3 | null;
  windows: RankingWindows;
  profile: ProfileInput;
  priceLookbackMonths: number;
}): FeatureInputsV3 {
  const scoped = filterCohort(params.deals, params.cohort);
  const baseDeals = scoped.filter((row) => inWindow(row.dealDate, params.windows.base12m));
  const recent = summarizePrice(baseDeals.filter((row) => inWindow(row.dealDate, params.windows.recent3m)));
  const previous = summarizePrice(baseDeals.filter((row) => inWindow(row.dealDate, params.windows.previous3m)));
  const base = summarizePrice(baseDeals);
  const months = new Set(baseDeals.map((row) => monthKey(row.dealDate)));
  const latest = baseDeals.reduce<string | null>((max, row) => {
    const day = row.dealDate.slice(0, 10);
    return max == null || day > max ? day : max;
  }, null);

  let price = base.medianPricePerMarketPyeong;
  let priceAvailability: ComponentAvailabilityV3 = price != null ? "AVAILABLE" : "MISSING";
  if (price == null && params.priceLookbackMonths > 12) {
    const lookbackStart = shiftMonths(params.windows.transactionAsOf, -params.priceLookbackMonths);
    const older = scoped.filter((row) => {
      const day = row.dealDate.slice(0, 10);
      return day > lookbackStart && day <= params.windows.transactionAsOf;
    });
    const stale = summarizePrice(older);
    if (stale.medianPricePerMarketPyeong != null) {
      price = stale.medianPricePerMarketPyeong;
      priceAvailability = "STALE_BUT_USABLE";
    }
  }

  const household = params.profile.householdCount;
  const householdAvailability: ComponentAvailabilityV3 =
    household != null && household > 0 ? "AVAILABLE" : "MISSING";
  const turnover =
    householdAvailability === "AVAILABLE" && household != null && household > 0
      ? base.tradeCount / household
      : null;
  const turnoverAvailability: ComponentAvailabilityV3 =
    turnover != null ? "AVAILABLE" : householdAvailability === "MISSING" ? "MISSING" : "AVAILABLE";

  return {
    tradeCount: base.tradeCount,
    medianDealAmount: base.medianDealAmount,
    medianPricePerMarketPyeong: price,
    priceAvailability,
    householdCount: householdAvailability === "AVAILABLE" ? household : null,
    householdAvailability,
    turnover,
    turnoverAvailability,
    activeMonthCount: months.size,
    latestDealDate: latest,
    recent3mTradeCount: recent.tradeCount,
    previous3mTradeCount: previous.tradeCount,
    profile: params.profile,
  };
}
