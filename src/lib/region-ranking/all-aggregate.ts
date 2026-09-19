/**
 * Cross-band aggregation. Numeric reliability and coverage settings are injected.
 * This file does not define production values and does not read transactions.
 */

export type AllBandId = "59" | "84" | "114";

export type AllMethod = "reliability_weighted_mean" | "median" | "balanced_mean";

export type AllPrivateConfig = {
  rankingVersion: string;
  method: AllMethod;
  tradeReliabilityScale: number;
  monthReliabilityScale: number;
  /** Zero keeps coverage out of the score. */
  coverageAdjustment: number;
  topTierSignalFloor: number;
};

export type AllBandStrength = {
  band: AllBandId;
  score: number;
  tradeCount: number;
  activeMonthCount: number;
  pricePercentile: number;
};

export type AllAggregate = {
  score: number;
  topTier: boolean;
  coverage: 1 | 2 | 3;
  coverageClass: "BAND_COVERAGE_1" | "BAND_COVERAGE_2" | "BAND_COVERAGE_3";
  lowCoverage: boolean;
  bands: AllBandId[];
};

export function bandReliability(
  tradeCount: number,
  activeMonthCount: number,
  config: AllPrivateConfig,
): number {
  const tradeScale = config.tradeReliabilityScale;
  const monthScale = config.monthReliabilityScale;
  const trade = tradeScale <= 0 ? 1 : tradeCount / (tradeCount + tradeScale);
  const month = monthScale <= 0 ? 1 : activeMonthCount / (activeMonthCount + monthScale);
  return trade * month;
}

function coverageClass(count: number): AllAggregate["coverageClass"] {
  if (count >= 3) return "BAND_COVERAGE_3";
  if (count === 2) return "BAND_COVERAGE_2";
  return "BAND_COVERAGE_1";
}

/** Valid bands only. Missing a band is not a penalty by itself. */
export function aggregateAll(
  bands: readonly AllBandStrength[],
  config: AllPrivateConfig,
): AllAggregate | null {
  if (bands.length === 0) return null;
  const weights = bands.map((band) =>
    Math.max(bandReliability(band.tradeCount, band.activeMonthCount, config), 1e-9),
  );
  let score: number;
  if (config.method === "median") {
    const sorted = bands.map((band) => band.score).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    score = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  } else {
    const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
    const mean = bands.reduce((sum, band, index) => sum + weights[index]! * band.score, 0) / weightTotal;
    if (config.method === "balanced_mean" && config.coverageAdjustment !== 0) {
      score = mean * (1 + config.coverageAdjustment * ((bands.length - 1) / 2));
    } else {
      score = mean;
    }
  }
  const priceWeights = config.method === "median" ? bands.map(() => 1) : weights;
  const priceWeightTotal = priceWeights.reduce((sum, weight) => sum + weight, 0);
  const price = bands.reduce((sum, band, index) => sum + priceWeights[index]! * band.pricePercentile, 0) / priceWeightTotal;
  const coverage = bands.length as 1 | 2 | 3;
  return {
    score,
    topTier: price >= config.topTierSignalFloor,
    coverage,
    coverageClass: coverageClass(coverage),
    lowCoverage: coverage === 1,
    bands: bands.map((band) => band.band).sort(),
  };
}
