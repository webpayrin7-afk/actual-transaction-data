/**
 * Injected ranking config. Numeric production values are not defined here.
 * Callers pass a parsed object. This module never reads a committed env file.
 */

import { sha256Hex } from "./run-identity";

export type RankingWeights = {
  price: number;
  liquidity: number;
  turnover: number;
  householdScale: number;
  stability: number;
  momentum: number;
};

export type ReliabilityFactors = {
  high: number;
  medium: number;
  low: number;
  missing: number;
};

export type RankingPrivateConfig = {
  rankingVersion: string;
  weights: RankingWeights;
  minTradeCount: number;
  minActiveMonths: number;
  maxRecencyDays: number;
  requireHouseholdProfile: boolean;
  identityConfidenceFloor: string | null;
  priceTopTierPercentileFloor: number;
  reliability: ReliabilityFactors;
  normalizationCap: number;
};

export type ConfigLoadCode =
  | "PRIVATE_CONFIG_ABSENT"
  | "PRIVATE_CONFIG_MALFORMED"
  | "PRIVATE_CONFIG_VERSION_MISSING";

export type ConfigLoadResult =
  | { ok: true; config: RankingPrivateConfig; fingerprint: string }
  | { ok: false; code: ConfigLoadCode };

const WEIGHT_KEYS = [
  "price",
  "liquidity",
  "turnover",
  "household_scale",
  "stability",
  "momentum",
] as const;

const RELIABILITY_KEYS = ["high", "medium", "low", "missing"] as const;

const ROOT_KEYS = [
  "ranking_version",
  "weights",
  "min_trade_count",
  "min_active_months",
  "max_recency_days",
  "require_household_profile",
  "identity_confidence_floor",
  "price_top_tier_percentile_floor",
  "reliability",
  "normalization_cap",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function nonNegativeInteger(value: unknown, max: number): number | null {
  const n = finiteNumber(value);
  if (n == null || !Number.isInteger(n) || n < 0 || n > max) return null;
  return n;
}

function unitInterval(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n == null || n < 0 || n > 1) return null;
  return n;
}

/** Sanity cap for adjustment factors. Not a production gate. */
function reliabilityFactor(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n == null || n <= 0 || n > 2) return null;
  return n;
}

export function fingerprintConfig(config: RankingPrivateConfig): string {
  return sha256Hex(JSON.stringify({
    ranking_version: config.rankingVersion,
    weights: {
      price: config.weights.price,
      liquidity: config.weights.liquidity,
      turnover: config.weights.turnover,
      household_scale: config.weights.householdScale,
      stability: config.weights.stability,
      momentum: config.weights.momentum,
    },
    min_trade_count: config.minTradeCount,
    min_active_months: config.minActiveMonths,
    max_recency_days: config.maxRecencyDays,
    require_household_profile: config.requireHouseholdProfile,
    identity_confidence_floor: config.identityConfidenceFloor,
    price_top_tier_percentile_floor: config.priceTopTierPercentileFloor,
    reliability: {
      high: config.reliability.high,
      medium: config.reliability.medium,
      low: config.reliability.low,
      missing: config.reliability.missing,
    },
    normalization_cap: config.normalizationCap,
  }));
}

export function loadPrivateConfig(raw: unknown): ConfigLoadResult {
  if (raw == null) return { ok: false, code: "PRIVATE_CONFIG_ABSENT" };
  if (!isRecord(raw)) return { ok: false, code: "PRIVATE_CONFIG_MALFORMED" };
  if (!("ranking_version" in raw) || typeof raw.ranking_version !== "string" || raw.ranking_version.trim() === "") {
    return { ok: false, code: "PRIVATE_CONFIG_VERSION_MISSING" };
  }
  if (!sameKeys(raw, ROOT_KEYS)) return { ok: false, code: "PRIVATE_CONFIG_MALFORMED" };
  if (!isRecord(raw.weights) || !sameKeys(raw.weights, WEIGHT_KEYS)) {
    return { ok: false, code: "PRIVATE_CONFIG_MALFORMED" };
  }
  if (!isRecord(raw.reliability) || !sameKeys(raw.reliability, RELIABILITY_KEYS)) {
    return { ok: false, code: "PRIVATE_CONFIG_MALFORMED" };
  }

  const weights = {
    price: unitInterval(raw.weights.price),
    liquidity: unitInterval(raw.weights.liquidity),
    turnover: unitInterval(raw.weights.turnover),
    householdScale: unitInterval(raw.weights.household_scale),
    stability: unitInterval(raw.weights.stability),
    momentum: unitInterval(raw.weights.momentum),
  };
  if (Object.values(weights).some((value) => value == null)) {
    return { ok: false, code: "PRIVATE_CONFIG_MALFORMED" };
  }
  const weightTotal = Object.values(weights).reduce((sum, value) => sum + (value ?? 0), 0);
  if (Math.abs(weightTotal - 1) > 1e-9) return { ok: false, code: "PRIVATE_CONFIG_MALFORMED" };

  const minTradeCount = nonNegativeInteger(raw.min_trade_count, 1_000_000);
  const minActiveMonths = nonNegativeInteger(raw.min_active_months, 1_000);
  const maxRecencyDays = nonNegativeInteger(raw.max_recency_days, 1_000_000);
  const priceFloor = unitInterval(raw.price_top_tier_percentile_floor);
  const cap = finiteNumber(raw.normalization_cap);
  if (
    minTradeCount == null ||
    minActiveMonths == null ||
    maxRecencyDays == null ||
    priceFloor == null ||
    cap == null ||
    cap <= 0 ||
    cap > 10 ||
    typeof raw.require_household_profile !== "boolean"
  ) {
    return { ok: false, code: "PRIVATE_CONFIG_MALFORMED" };
  }
  const floor = raw.identity_confidence_floor;
  if (!(floor == null || (typeof floor === "string" && floor.trim() !== ""))) {
    return { ok: false, code: "PRIVATE_CONFIG_MALFORMED" };
  }
  const reliability = {
    high: reliabilityFactor(raw.reliability.high),
    medium: reliabilityFactor(raw.reliability.medium),
    low: reliabilityFactor(raw.reliability.low),
    missing: reliabilityFactor(raw.reliability.missing),
  };
  if (Object.values(reliability).some((value) => value == null)) {
    return { ok: false, code: "PRIVATE_CONFIG_MALFORMED" };
  }

  const config: RankingPrivateConfig = {
    rankingVersion: raw.ranking_version.trim(),
    weights: {
      price: weights.price!,
      liquidity: weights.liquidity!,
      turnover: weights.turnover!,
      householdScale: weights.householdScale!,
      stability: weights.stability!,
      momentum: weights.momentum!,
    },
    minTradeCount,
    minActiveMonths,
    maxRecencyDays,
    requireHouseholdProfile: raw.require_household_profile,
    identityConfidenceFloor: floor == null ? null : floor.trim(),
    priceTopTierPercentileFloor: priceFloor,
    reliability: {
      high: reliability.high!,
      medium: reliability.medium!,
      low: reliability.low!,
      missing: reliability.missing!,
    },
    normalizationCap: cap,
  };
  return { ok: true, config, fingerprint: fingerprintConfig(config) };
}

/** Env injection point. Unset or blank is absence. The raw string is not returned. */
export function loadPrivateConfigFromEnv(
  env: Record<string, string | undefined>,
): ConfigLoadResult {
  const raw = env.REGION_RANKING_PRIVATE_CONFIG;
  if (raw == null || raw.trim() === "") return { ok: false, code: "PRIVATE_CONFIG_ABSENT" };
  try {
    return loadPrivateConfig(JSON.parse(raw));
  } catch {
    return { ok: false, code: "PRIVATE_CONFIG_MALFORMED" };
  }
}

/** Safe to print. Never includes weights, thresholds, or the raw document. */
export function safeConfigLog(result: ConfigLoadResult): {
  validation: "PASS" | "FAIL";
  code?: ConfigLoadCode;
  ranking_version?: string;
  config_fingerprint?: string;
} {
  if (!result.ok) return { validation: "FAIL", code: result.code };
  return {
    validation: "PASS",
    ranking_version: result.config.rankingVersion,
    config_fingerprint: result.fingerprint,
  };
}
