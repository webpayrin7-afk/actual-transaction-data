/**
 * Generic scorer. Weights and gates come only from an injected config.
 * Public rows omit component scores, percentiles, weights, and thresholds.
 */

import type { FeatureInputs } from "./features";
import { evaluateEligibility } from "./eligibility";
import type { RankingPrivateConfig } from "./private-config";
import { rankingRunId } from "./run-identity";

export type FeatureSnapshotRow = {
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
  medianPricePerSqm: number | null;
  medianDealAmount: number | null;
  tradeCount: number;
  householdCount: number | null;
  turnover: number | null;
  activeMonthCount: number;
  latestDealDate: string | null;
  recent3mTradeCount: number;
  previous3mTradeCount: number;
  recent3mMedianPricePerSqm: number | null;
  previous3mMedianPricePerSqm: number | null;
  featureVersion: string;
  profileSource: string | null;
  profileConfidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING";
  identityStatus: string | null;
};

export type PublicDisplayMetrics = {
  median_price_per_sqm: number | null;
  median_deal_amount: number | null;
  trade_count: number;
  latest_deal_date: string | null;
};

export type PublicRankingRow = {
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
  publicDisplayMetrics: PublicDisplayMetrics;
};

export type CohortScore =
  | { ok: false; code: "PRIVATE_CONFIG_ABSENT" }
  | {
      ok: true;
      featureRunId: string;
      rankingRunId: string;
      regionScope: "gu" | "dong";
      regionCode: string;
      cohortSize: number;
      rows: PublicRankingRow[];
      priceGate: "TOP5_CONSTRAINT" | "NOT_EVALUATED_FOR_SMALL_COHORT";
      baseEligible: number;
      baseExcluded: number;
      topTierEligible: number | null;
      rawOrder: Array<{ complexId: string; rank: number }>;
      constrainedOrder: Array<{ complexId: string; rank: number }>;
      /** In-memory only. Not a public metric and not stored. */
      strengthByComplex: Record<string, number>;
    };

const PUBLIC_METRIC_KEYS = [
  "median_price_per_sqm",
  "median_deal_amount",
  "trade_count",
  "latest_deal_date",
] as const;

export function publicDisplayMetrics(row: FeatureSnapshotRow): PublicDisplayMetrics {
  return {
    median_price_per_sqm: row.medianPricePerSqm,
    median_deal_amount: row.medianDealAmount,
    trade_count: row.tradeCount,
    latest_deal_date: row.latestDealDate,
  };
}

export function assertPublicMetricsOnly(metrics: PublicDisplayMetrics): void {
  const keys = Object.keys(metrics).sort();
  const expected = [...PUBLIC_METRIC_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    throw new Error("public metrics contain a non-public field");
  }
}

/** Mid-rank percentile in [0, 1]. A one-row cohort is 1. Ties share the mid rank. */
export function percentileRank(value: number, cohortValues: readonly number[]): number {
  const n = cohortValues.length;
  if (n <= 1) return 1;
  let below = 0;
  let equal = 0;
  for (const other of cohortValues) {
    if (other < value) below += 1;
    else if (other === value) equal += 1;
  }
  return (below + (equal - 1) / 2) / (n - 1);
}

function asFeatureInputs(row: FeatureSnapshotRow): FeatureInputs {
  return {
    tradeCount: row.tradeCount,
    medianDealAmount: row.medianDealAmount,
    medianPricePerSqm: row.medianPricePerSqm,
    householdCount: row.householdCount,
    turnover: row.turnover,
    activeMonthCount: row.activeMonthCount,
    latestDealDate: row.latestDealDate,
    monthlyTradeCounts: [],
    recent3mTradeCount: row.recent3mTradeCount,
    previous3mTradeCount: row.previous3mTradeCount,
    recent3mMedianDealAmount: null,
    previous3mMedianDealAmount: null,
    recent3mMedianPricePerSqm: row.recent3mMedianPricePerSqm,
    previous3mMedianPricePerSqm: row.previous3mMedianPricePerSqm,
    profile: {
      householdCount: row.householdCount,
      source: row.profileSource,
      sourceKey: null,
      sourceAsOf: null,
      confidence: row.profileConfidence,
    },
  };
}

type Scored = {
  row: FeatureSnapshotRow;
  eligible: boolean;
  exclusionReason: string | null;
  score: number;
  priceSignal: number;
  /** Internal. Not copied onto public rows. */
  topTierEligible: boolean;
};

/** Gu leader slots. Not a private threshold. */
const TOP_TIER_SLOT_COUNT = 5;

/**
 * The gu TOP-5 price constraint is not applied to a dong cohort this small.
 * 잠실동 in the frozen sample has 6 complexes.
 * Read paths may expose this as metadata. It is not a new gate.
 */
export const SMALL_DONG_COHORT_MAX = 6;

export function priceGateMode(
  regionScope: "gu" | "dong",
  cohortSize: number,
): "TOP5_CONSTRAINT" | "NOT_EVALUATED_FOR_SMALL_COHORT" {
  if (regionScope === "dong" && cohortSize <= SMALL_DONG_COHORT_MAX) {
    return "NOT_EVALUATED_FOR_SMALL_COHORT";
  }
  return "TOP5_CONSTRAINT";
}

/**
 * Raw order is score order. When the price gate is on, top-tier rows
 * take the front of the order. Ranks are then 1..N with no reserved holes.
 */
export function placeRanks(
  scored: readonly Scored[],
  mode: "TOP5_CONSTRAINT" | "NOT_EVALUATED_FOR_SMALL_COHORT",
): { raw: Scored[]; constrained: Scored[]; rankById: Map<string, number> } {
  const raw = scored.filter((item) => item.eligible).sort(compareRank);
  if (mode === "NOT_EVALUATED_FOR_SMALL_COHORT") {
    return {
      raw,
      constrained: raw,
      rankById: new Map(raw.map((item, index) => [item.row.complexId, index + 1])),
    };
  }
  const head = raw.filter((item) => item.topTierEligible).slice(0, TOP_TIER_SLOT_COUNT);
  const headIds = new Set(head.map((item) => item.row.complexId));
  const rest = raw.filter((item) => !headIds.has(item.row.complexId));
  const constrained = [...head, ...rest];
  return {
    raw,
    constrained,
    rankById: new Map(constrained.map((item, index) => [item.row.complexId, index + 1])),
  };
}

export function rankWithTopTierSlots(
  items: readonly { id: string; score: number; topTier: boolean; tieBreak: number }[],
  mode: "TOP5_CONSTRAINT" | "NOT_EVALUATED_FOR_SMALL_COHORT",
): { id: string; rank: number }[] {
  const ordered = [...items].sort((a, b) => {
    if (a.score !== b.score) return a.score > b.score ? -1 : 1;
    if (a.tieBreak !== b.tieBreak) return a.tieBreak > b.tieBreak ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  if (mode === "NOT_EVALUATED_FOR_SMALL_COHORT") {
    return ordered.map((item, index) => ({ id: item.id, rank: index + 1 }));
  }
  const head = ordered.filter((item) => item.topTier).slice(0, TOP_TIER_SLOT_COUNT);
  const headIds = new Set(head.map((item) => item.id));
  const rest = ordered.filter((item) => !headIds.has(item.id));
  return [...head, ...rest].map((item, index) => ({ id: item.id, rank: index + 1 }));
}

function reliabilityOf(config: RankingPrivateConfig, confidence: FeatureSnapshotRow["profileConfidence"]): number {
  if (confidence === "HIGH") return config.reliability.high;
  if (confidence === "MEDIUM") return config.reliability.medium;
  if (confidence === "LOW") return config.reliability.low;
  return config.reliability.missing;
}

/**
 * Higher score wins. Remaining ties break by higher price signal,
 * then higher trade_count, then complex_id ascending.
 */
export function compareRank(a: Scored, b: Scored): number {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1;
  if (a.priceSignal !== b.priceSignal) return a.priceSignal > b.priceSignal ? -1 : 1;
  if (a.row.tradeCount !== b.row.tradeCount) return a.row.tradeCount > b.row.tradeCount ? -1 : 1;
  return a.row.complexId.localeCompare(b.row.complexId);
}

export function scoreCohort(params: {
  featureRunId: string;
  rows: readonly FeatureSnapshotRow[];
  regionScope: "gu" | "dong";
  regionCode: string;
  config: RankingPrivateConfig | null;
  privateConfigFingerprint: string | null;
  /** Algorithm label. Defaults to the injected config version so fingerprints stay stable. */
  rankingVersion?: string;
}): CohortScore {
  if (!params.config || !params.privateConfigFingerprint) {
    return { ok: false, code: "PRIVATE_CONFIG_ABSENT" };
  }
  const config = params.config;
  const rankingVersion = params.rankingVersion ?? config.rankingVersion;
  const cohort = params.rows.filter((row) =>
    params.regionScope === "gu" ? row.lawdCd === params.regionCode : row.bjdongCd === params.regionCode,
  );
  const preliminary = cohort.map((row) => {
    const gate = evaluateEligibility({
      features: asFeatureInputs(row),
      transactionAsOf: row.transactionAsOf,
      identityStatus: row.identityStatus,
      config: {
        minTradeCount: config.minTradeCount,
        minActiveMonths: config.minActiveMonths,
        maxRecencyDays: config.maxRecencyDays,
        requireHouseholdProfile: config.requireHouseholdProfile,
        identityConfidenceFloor: config.identityConfidenceFloor ?? undefined,
      },
    });
    return { row, eligible: gate.eligibleInput, exclusionReason: gate.exclusionReason };
  });
  const eligibleRows = preliminary.filter((item) => item.eligible).map((item) => item.row);
  const priceValues = eligibleRows.map((row) => row.medianPricePerSqm ?? Number.NEGATIVE_INFINITY);
  const liquidityValues = eligibleRows.map((row) => row.tradeCount);
  const turnoverValues = eligibleRows.map((row) => row.turnover ?? Number.NEGATIVE_INFINITY);
  const householdValues = eligibleRows.map((row) => row.householdCount ?? Number.NEGATIVE_INFINITY);
  const stabilityValues = eligibleRows.map((row) => row.activeMonthCount);
  const momentumValues = eligibleRows.map((row) => row.recent3mTradeCount - row.previous3mTradeCount);

  const scored: Scored[] = preliminary.map((item) => {
    if (!item.eligible) {
      return {
        row: item.row,
        eligible: false,
        exclusionReason: item.exclusionReason,
        score: Number.NEGATIVE_INFINITY,
        priceSignal: item.row.medianPricePerSqm ?? Number.NEGATIVE_INFINITY,
        topTierEligible: false,
      };
    }
    const price = percentileRank(item.row.medianPricePerSqm ?? Number.NEGATIVE_INFINITY, priceValues);
    const liquidity = percentileRank(item.row.tradeCount, liquidityValues);
    const turnover = percentileRank(item.row.turnover ?? Number.NEGATIVE_INFINITY, turnoverValues);
    const household = percentileRank(item.row.householdCount ?? Number.NEGATIVE_INFINITY, householdValues);
    const stability = percentileRank(item.row.activeMonthCount, stabilityValues);
    const momentum = percentileRank(
      item.row.recent3mTradeCount - item.row.previous3mTradeCount,
      momentumValues,
    );
    const weighted =
      config.weights.price * price +
      config.weights.liquidity * liquidity +
      config.weights.turnover * turnover +
      config.weights.householdScale * household +
      config.weights.stability * stability +
      config.weights.momentum * momentum;
    const adjusted = Math.min(weighted * reliabilityOf(config, item.row.profileConfidence), config.normalizationCap);
    const priceSignal = item.row.medianPricePerSqm ?? Number.NEGATIVE_INFINITY;
    return {
      row: item.row,
      eligible: true,
      exclusionReason: null,
      score: adjusted,
      priceSignal,
      topTierEligible: price >= config.priceTopTierPercentileFloor,
    };
  });

  const mode = priceGateMode(params.regionScope, cohort.length);
  if (mode === "NOT_EVALUATED_FOR_SMALL_COHORT") {
    for (const item of scored) item.topTierEligible = false;
  }
  const placed = placeRanks(scored, mode);
  const rankById = placed.rankById;
  const runId = rankingRunId({
    featureRunId: params.featureRunId,
    rankingVersion,
    privateConfigFingerprint: params.privateConfigFingerprint,
    regionScope: params.regionScope,
    regionCode: params.regionCode,
  });
  const regionTotal = placed.constrained.length;
  const rawRank = new Map(placed.raw.map((item, index) => [item.row.complexId, index + 1]));
  const rows = scored
    .map((item): PublicRankingRow => {
      const metrics = publicDisplayMetrics(item.row);
      assertPublicMetricsOnly(metrics);
      return {
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
        rankingVersion,
        transactionAsOf: item.row.transactionAsOf,
        publicDisplayMetrics: metrics,
      };
    })
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
    baseEligible: placed.constrained.length,
    baseExcluded: cohort.length - placed.constrained.length,
    topTierEligible: mode === "TOP5_CONSTRAINT" ? scored.filter((item) => item.topTierEligible).length : null,
    rawOrder: placed.raw.map((item) => ({
      complexId: item.row.complexId,
      rank: rawRank.get(item.row.complexId) ?? 0,
    })),
    constrainedOrder: placed.constrained.map((item) => ({
      complexId: item.row.complexId,
      rank: rankById.get(item.row.complexId) ?? 0,
    })),
    strengthByComplex: Object.fromEntries(
      scored.filter((item) => item.eligible).map((item) => [item.row.complexId, item.score]),
    ),
  };
}
