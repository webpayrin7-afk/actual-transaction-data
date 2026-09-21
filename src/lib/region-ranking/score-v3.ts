/**
 * Ranking V3 scorer.
 * No activity hard gates. Missing price is not scored as zero.
 * Interest weight must stay inactive (0).
 */
import { rankingRunId } from "./run-identity";
import { percentileRank, priceGateMode, SMALL_DONG_COHORT_MAX } from "./score";
import type { RankingPrivateConfigV3 } from "./private-config-v3";
import type { FeatureInputsV3 } from "./features-v3";
import type { ComponentAvailabilityV3, CoverageStatusV3 } from "./ranking-v3";

export { SMALL_DONG_COHORT_MAX };

export type FeatureSnapshotRowV3 = {
  complexId: string;
  lawdCd: string;
  bjdongCd: string;
  areaBand: string;
  areaBandVersion: string;
  period: string;
  transactionAsOf: string;
  sourceWindowStart: string;
  sourceWindowEnd: string;
  recentWindowStart: string;
  recentWindowEnd: string;
  previousWindowStart: string;
  previousWindowEnd: string;
  medianPricePerMarketPyeong: number | null;
  priceAvailability: ComponentAvailabilityV3;
  medianDealAmount: number | null;
  tradeCount: number;
  householdCount: number | null;
  householdAvailability: ComponentAvailabilityV3;
  turnover: number | null;
  turnoverAvailability: ComponentAvailabilityV3;
  activeMonthCount: number;
  latestDealDate: string | null;
  recent3mTradeCount: number;
  previous3mTradeCount: number;
  featureVersion: string;
  profileSource: string | null;
  profileConfidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING";
  identityStatus: string | null;
  decadeCompetitiveness: number | null;
  decadeCompetitivenessAvailability: ComponentAvailabilityV3;
  decadeCount: number;
};

export type PublicDisplayMetricsV3 = {
  median_price_per_sqm: number | null;
  median_deal_amount: number | null;
  trade_count: number;
  latest_deal_date: string | null;
  price_availability?: ComponentAvailabilityV3;
  coverage_status?: CoverageStatusV3;
  available_weight_share?: number;
  region_pyeong_decade?: string | null;
};

export type PublicRankingRowV3 = {
  rankingRunId: string;
  featureRunId: string;
  regionScope: "gu" | "dong";
  regionCode: string;
  complexId: string;
  areaBand: string;
  period: string;
  rank: number | null;
  regionTotal: number;
  confidenceBucket: string;
  eligible: boolean;
  exclusionReason: string | null;
  rankingVersion: string;
  transactionAsOf: string;
  publicDisplayMetrics: PublicDisplayMetricsV3;
};

type Scored = {
  row: FeatureSnapshotRowV3;
  eligible: boolean;
  exclusionReason: string | null;
  score: number;
  priceSignal: number;
  topTierEligible: boolean;
  availableWeightShare: number;
  coverageStatus: CoverageStatusV3;
};

function reliabilityOf(
  config: RankingPrivateConfigV3,
  confidence: FeatureSnapshotRowV3["profileConfidence"],
): number {
  if (confidence === "HIGH") return config.reliability.high;
  if (confidence === "MEDIUM") return config.reliability.medium;
  if (confidence === "LOW") return config.reliability.low;
  return config.reliability.missing;
}

function coverageStatus(share: number, minShare: number): CoverageStatusV3 {
  if (share >= 0.85) return "FULL";
  if (share >= minShare) return "PARTIAL";
  if (share > 0) return "SPARSE";
  return "IDENTITY_ONLY";
}

/** Mid-rank percentile over available values only. Missing is not zero. */
export function availablePercentile(value: number | null, available: readonly number[]): number | null {
  if (value == null || !Number.isFinite(value) || available.length === 0) return null;
  return percentileRank(value, available);
}

export function compareRankV3(a: Scored, b: Scored): number {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1;
  if (a.availableWeightShare !== b.availableWeightShare) {
    return a.availableWeightShare > b.availableWeightShare ? -1 : 1;
  }
  if (a.priceSignal !== b.priceSignal) return a.priceSignal > b.priceSignal ? -1 : 1;
  if (a.row.tradeCount !== b.row.tradeCount) return a.row.tradeCount > b.row.tradeCount ? -1 : 1;
  return a.row.complexId.localeCompare(b.row.complexId);
}

function scoreOne(
  row: FeatureSnapshotRowV3,
  pools: {
    price: number[];
    liquidity: number[];
    turnover: number[];
    household: number[];
    stability: number[];
    momentum: number[];
    decade: number[];
  },
  config: RankingPrivateConfigV3,
  useDecadeCompetitiveness: boolean,
): Omit<Scored, "eligible" | "exclusionReason" | "topTierEligible"> {
  const w = config.weights;
  const active: Array<{ weight: number; value: number | null }> = [];
  if (useDecadeCompetitiveness) {
    active.push({
      weight: w.price,
      value: availablePercentile(row.decadeCompetitiveness, pools.decade),
    });
  } else {
    active.push({
      weight: w.price,
      value: availablePercentile(row.medianPricePerMarketPyeong, pools.price),
    });
  }
  // Liquidity always observes tradeCount, including zero — not a missing signal.
  active.push({ weight: w.liquidity, value: availablePercentile(row.tradeCount, pools.liquidity) });
  active.push({ weight: w.turnover, value: availablePercentile(row.turnover, pools.turnover) });
  active.push({ weight: w.householdScale, value: availablePercentile(row.householdCount, pools.household) });
  active.push({ weight: w.stability, value: availablePercentile(row.activeMonthCount, pools.stability) });
  active.push({
    weight: w.momentum,
    value: availablePercentile(row.recent3mTradeCount - row.previous3mTradeCount, pools.momentum),
  });
  // Interest weight is required to be 0 and is never scored.

  let weightSum = 0;
  let weighted = 0;
  for (const item of active) {
    if (item.weight <= 0 || item.value == null) continue;
    weightSum += item.weight;
    weighted += item.weight * item.value;
  }
  const availableWeightShare = weightSum;
  let score = weightSum > 0 ? weighted / weightSum : 0;
  if (availableWeightShare < config.minAvailableWeightShare) score *= availableWeightShare;
  score = Math.min(score * reliabilityOf(config, row.profileConfidence), config.normalizationCap);
  return {
    row,
    score,
    priceSignal: row.medianPricePerMarketPyeong ?? Number.NEGATIVE_INFINITY,
    availableWeightShare,
    coverageStatus: coverageStatus(availableWeightShare, config.minAvailableWeightShare),
  };
}

export type CohortScoreV3 =
  | { ok: false; code: "PRIVATE_CONFIG_ABSENT" }
  | {
      ok: true;
      featureRunId: string;
      rankingRunId: string;
      regionScope: "gu" | "dong";
      regionCode: string;
      cohortSize: number;
      rows: PublicRankingRowV3[];
      priceGate: "TOP5_CONSTRAINT" | "NOT_EVALUATED_FOR_SMALL_COHORT";
      baseEligible: number;
      baseExcluded: number;
      strengthByComplex: Record<string, number>;
    };

export function scoreCohortV3(params: {
  featureRunId: string;
  rows: readonly FeatureSnapshotRowV3[];
  regionScope: "gu" | "dong";
  regionCode: string;
  config: RankingPrivateConfigV3 | null;
  privateConfigFingerprint: string | null;
  rankingVersion: string;
  useDecadeCompetitiveness?: boolean;
  hardExcluded?: ReadonlyMap<string, string>;
}): CohortScoreV3 {
  if (!params.config || !params.privateConfigFingerprint) {
    return { ok: false, code: "PRIVATE_CONFIG_ABSENT" };
  }
  const config = params.config;
  const useDecade = params.useDecadeCompetitiveness === true;
  const cohort = params.rows.filter((row) =>
    params.regionScope === "gu" ? row.lawdCd === params.regionCode : row.bjdongCd === params.regionCode,
  );

  const pools = {
    price: cohort
      .map((row) => row.medianPricePerMarketPyeong)
      .filter((value): value is number => value != null && Number.isFinite(value)),
    liquidity: cohort.map((row) => row.tradeCount),
    turnover: cohort
      .map((row) => row.turnover)
      .filter((value): value is number => value != null && Number.isFinite(value)),
    household: cohort
      .map((row) => row.householdCount)
      .filter((value): value is number => value != null && value > 0),
    stability: cohort.map((row) => row.activeMonthCount),
    momentum: cohort.map((row) => row.recent3mTradeCount - row.previous3mTradeCount),
    decade: cohort
      .map((row) => row.decadeCompetitiveness)
      .filter((value): value is number => value != null && Number.isFinite(value)),
  };

  const scored: Scored[] = cohort.map((row) => {
    const hard = params.hardExcluded?.get(row.complexId);
    if (hard) {
      return {
        row,
        eligible: false,
        exclusionReason: hard,
        score: Number.NEGATIVE_INFINITY,
        priceSignal: Number.NEGATIVE_INFINITY,
        topTierEligible: false,
        availableWeightShare: 0,
        coverageStatus: "IDENTITY_ONLY",
      };
    }
    const body = scoreOne(row, pools, config, useDecade);
    const pricePct = availablePercentile(row.medianPricePerMarketPyeong, pools.price);
    return {
      ...body,
      eligible: true,
      exclusionReason: null,
      topTierEligible: pricePct != null && pricePct >= config.priceTopTierPercentileFloor,
    };
  });

  const mode = priceGateMode(params.regionScope, cohort.length);
  if (mode === "NOT_EVALUATED_FOR_SMALL_COHORT") {
    for (const item of scored) item.topTierEligible = false;
  }
  const eligible = scored.filter((item) => item.eligible).sort(compareRankV3);
  const constrained =
    mode === "NOT_EVALUATED_FOR_SMALL_COHORT"
      ? eligible
      : (() => {
          const head = eligible.filter((item) => item.topTierEligible).slice(0, 5);
          const headIds = new Set(head.map((item) => item.row.complexId));
          return [...head, ...eligible.filter((item) => !headIds.has(item.row.complexId))];
        })();
  const rankById = new Map(constrained.map((item, index) => [item.row.complexId, index + 1]));

  const runId = rankingRunId({
    featureRunId: params.featureRunId,
    rankingVersion: params.rankingVersion,
    privateConfigFingerprint: params.privateConfigFingerprint,
    regionScope: params.regionScope,
    regionCode: params.regionCode,
  });
  const regionTotal = constrained.length;
  const rows = scored
    .map((item): PublicRankingRowV3 => ({
      rankingRunId: runId,
      featureRunId: params.featureRunId,
      regionScope: params.regionScope,
      regionCode: params.regionCode,
      complexId: item.row.complexId,
      areaBand: item.row.areaBand,
      period: item.row.period,
      rank: item.eligible ? rankById.get(item.row.complexId) ?? null : null,
      regionTotal,
      confidenceBucket: item.row.profileConfidence,
      eligible: item.eligible,
      exclusionReason: item.exclusionReason,
      rankingVersion: params.rankingVersion,
      transactionAsOf: item.row.transactionAsOf,
      publicDisplayMetrics: {
        median_price_per_sqm: item.row.medianPricePerMarketPyeong,
        median_deal_amount: item.row.medianDealAmount,
        trade_count: item.row.tradeCount,
        latest_deal_date: item.row.latestDealDate,
        price_availability: item.row.priceAvailability,
        coverage_status: item.coverageStatus,
        available_weight_share: Number(item.availableWeightShare.toFixed(4)),
      },
    }))
    .sort((a, b) => a.complexId.localeCompare(b.complexId));

  return {
    ok: true,
    featureRunId: params.featureRunId,
    rankingRunId: runId,
    regionScope: params.regionScope,
    regionCode: params.regionCode,
    cohortSize: cohort.length,
    rows,
    priceGate: mode,
    baseEligible: constrained.length,
    baseExcluded: cohort.length - constrained.length,
    strengthByComplex: Object.fromEntries(
      scored.filter((item) => item.eligible).map((item) => [item.row.complexId, item.score]),
    ),
  };
}

export function featureInputsToSnapshotFields(features: FeatureInputsV3): Pick<
  FeatureSnapshotRowV3,
  | "medianPricePerMarketPyeong"
  | "priceAvailability"
  | "medianDealAmount"
  | "tradeCount"
  | "householdCount"
  | "householdAvailability"
  | "turnover"
  | "turnoverAvailability"
  | "activeMonthCount"
  | "latestDealDate"
  | "recent3mTradeCount"
  | "previous3mTradeCount"
  | "profileSource"
  | "profileConfidence"
> {
  return {
    medianPricePerMarketPyeong: features.medianPricePerMarketPyeong,
    priceAvailability: features.priceAvailability,
    medianDealAmount: features.medianDealAmount,
    tradeCount: features.tradeCount,
    householdCount: features.householdCount,
    householdAvailability: features.householdAvailability,
    turnover: features.turnover,
    turnoverAvailability: features.turnoverAvailability,
    activeMonthCount: features.activeMonthCount,
    latestDealDate: features.latestDealDate,
    recent3mTradeCount: features.recent3mTradeCount,
    previous3mTradeCount: features.previous3mTradeCount,
    profileSource: features.profile.source,
    profileConfidence: features.profile.confidence,
  };
}
