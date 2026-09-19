/**
 * Gate interface only. Numeric thresholds are private config inputs.
 * This file has no production threshold literals.
 */

import type { FeatureInputs } from "./features";

export type EligibilityConfig = {
  minTradeCount?: number;
  minActiveMonths?: number;
  maxRecencyDays?: number;
  requireHouseholdProfile: boolean;
  identityConfidenceFloor?: string;
};

export type TopTierGateConfig = {
  pricePercentileFloor?: number;
};

export type EligibilityResult = {
  eligibleInput: boolean;
  exclusionReason: string | null;
  topTierEvaluated: boolean;
};

const CONFIDENCE_ORDER = ["MISSING", "LOW", "MEDIUM", "HIGH"] as const;

/** HIGH/MEDIUM/LOW/MISSING are an ordinal floor on profile confidence. Other tokens stay an exact identity-status match. */
function meetsIdentityFloor(
  floor: string,
  profileConfidence: string,
  identityStatus: string | null,
): boolean {
  const floorRank = CONFIDENCE_ORDER.indexOf(floor as (typeof CONFIDENCE_ORDER)[number]);
  if (floorRank < 0) return identityStatus === floor;
  const actualRank = CONFIDENCE_ORDER.indexOf(profileConfidence as (typeof CONFIDENCE_ORDER)[number]);
  if (actualRank < 0) return false;
  return actualRank >= floorRank;
}

function daysSince(dealDate: string, asOf: string): number {
  const a = Date.parse(`${dealDate.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

export function evaluateEligibility(params: {
  features: FeatureInputs;
  transactionAsOf: string;
  identityStatus: string | null;
  config: EligibilityConfig | null;
}): EligibilityResult {
  if (!params.config) {
    return {
      eligibleInput: false,
      exclusionReason: "PRIVATE_CONFIG_ABSENT",
      topTierEvaluated: false,
    };
  }
  if (params.features.tradeCount === 0) {
    return {
      eligibleInput: false,
      exclusionReason: "NO_TRADES_IN_BAND",
      topTierEvaluated: false,
    };
  }
  if (
    params.config.requireHouseholdProfile &&
    (params.features.householdCount == null || params.features.householdCount <= 0)
  ) {
    return {
      eligibleInput: false,
      exclusionReason: "PROFILE_HOUSEHOLD_MISSING",
      topTierEvaluated: false,
    };
  }
  if (
    params.config.minTradeCount != null &&
    params.features.tradeCount < params.config.minTradeCount
  ) {
    return {
      eligibleInput: false,
      exclusionReason: "BELOW_MIN_TRADE_COUNT",
      topTierEvaluated: false,
    };
  }
  if (
    params.config.minActiveMonths != null &&
    params.features.activeMonthCount < params.config.minActiveMonths
  ) {
    return {
      eligibleInput: false,
      exclusionReason: "BELOW_MIN_ACTIVE_MONTHS",
      topTierEvaluated: false,
    };
  }
  if (params.config.maxRecencyDays != null) {
    if (!params.features.latestDealDate) {
      return {
        eligibleInput: false,
        exclusionReason: "STALE_OR_MISSING_DEAL",
        topTierEvaluated: false,
      };
    }
    if (
      daysSince(params.features.latestDealDate, params.transactionAsOf) >
      params.config.maxRecencyDays
    ) {
      return {
        eligibleInput: false,
        exclusionReason: "STALE_OR_MISSING_DEAL",
        topTierEvaluated: false,
      };
    }
  }
  if (params.config.identityConfidenceFloor) {
    const ok = meetsIdentityFloor(
      params.config.identityConfidenceFloor,
      params.features.profile.confidence,
      params.identityStatus,
    );
    if (!ok) {
      return {
        eligibleInput: false,
        exclusionReason: "IDENTITY_BELOW_FLOOR",
        topTierEvaluated: false,
      };
    }
  }
  return {
    eligibleInput: true,
    exclusionReason: null,
    topTierEvaluated: false,
  };
}

/** Top-tier price gate is config-only. This phase does not compute a percentile. */
export function topTierGateReady(config: TopTierGateConfig | null): boolean {
  return config?.pricePercentileFloor != null;
}
