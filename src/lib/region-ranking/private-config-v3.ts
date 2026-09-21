/**
 * Ranking V3 private config.
 * Interest is schema-present at weight 0 (inactive). Activity thresholds are not hard gates.
 * Numeric production weights stay out of the repository and public reports.
 */
import { sha256Hex } from "./run-identity";

export type RankingWeightsV3 = {
  price: number;
  liquidity: number;
  turnover: number;
  householdScale: number;
  stability: number;
  momentum: number;
  /** Always 0 until a real interest feed exists. */
  interest: number;
};

export type ReliabilityFactorsV3 = {
  high: number;
  medium: number;
  low: number;
  missing: number;
};

export type RankingPrivateConfigV3 = {
  rankingVersion: string;
  weights: RankingWeightsV3;
  /** Soft coverage floor: available active-weight share below this damps score. Not an exclusion. */
  minAvailableWeightShare: number;
  priceTopTierPercentileFloor: number;
  reliability: ReliabilityFactorsV3;
  normalizationCap: number;
  /** Months of lookback when 12M price is missing. Does not invent prices. */
  priceLookbackMonths: number;
};

export type ConfigLoadResultV3 =
  | { ok: true; config: RankingPrivateConfigV3; fingerprint: string }
  | { ok: false; code: "PRIVATE_CONFIG_ABSENT" | "PRIVATE_CONFIG_MALFORMED" | "PRIVATE_CONFIG_VERSION_MISSING" };

const WEIGHT_KEYS = [
  "price",
  "liquidity",
  "turnover",
  "household_scale",
  "stability",
  "momentum",
  "interest",
] as const;

const RELIABILITY_KEYS = ["high", "medium", "low", "missing"] as const;

const ROOT_KEYS = [
  "ranking_version",
  "weights",
  "min_available_weight_share",
  "price_top_tier_percentile_floor",
  "reliability",
  "normalization_cap",
  "price_lookback_months",
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

function unitInterval(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n == null || n < 0 || n > 1) return null;
  return n;
}

function reliabilityFactor(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n == null || n <= 0 || n > 2) return null;
  return n;
}

export function fingerprintConfigV3(config: RankingPrivateConfigV3): string {
  return sha256Hex(
    JSON.stringify({
      ranking_version: config.rankingVersion,
      weights: {
        price: config.weights.price,
        liquidity: config.weights.liquidity,
        turnover: config.weights.turnover,
        household_scale: config.weights.householdScale,
        stability: config.weights.stability,
        momentum: config.weights.momentum,
        interest: config.weights.interest,
      },
      min_available_weight_share: config.minAvailableWeightShare,
      price_top_tier_percentile_floor: config.priceTopTierPercentileFloor,
      reliability: {
        high: config.reliability.high,
        medium: config.reliability.medium,
        low: config.reliability.low,
        missing: config.reliability.missing,
      },
      normalization_cap: config.normalizationCap,
      price_lookback_months: config.priceLookbackMonths,
    }),
  );
}

export function loadPrivateConfigV3(raw: unknown): ConfigLoadResultV3 {
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
    interest: unitInterval(raw.weights.interest),
  };
  if (Object.values(weights).some((value) => value == null)) {
    return { ok: false, code: "PRIVATE_CONFIG_MALFORMED" };
  }
  if (weights.interest !== 0) return { ok: false, code: "PRIVATE_CONFIG_MALFORMED" };
  const weightTotal =
    weights.price! +
    weights.liquidity! +
    weights.turnover! +
    weights.householdScale! +
    weights.stability! +
    weights.momentum! +
    weights.interest!;
  if (Math.abs(weightTotal - 1) > 1e-9) return { ok: false, code: "PRIVATE_CONFIG_MALFORMED" };

  const minShare = unitInterval(raw.min_available_weight_share);
  const priceFloor = unitInterval(raw.price_top_tier_percentile_floor);
  const cap = finiteNumber(raw.normalization_cap);
  const lookback = finiteNumber(raw.price_lookback_months);
  if (
    minShare == null ||
    priceFloor == null ||
    cap == null ||
    cap <= 0 ||
    cap > 10 ||
    lookback == null ||
    !Number.isInteger(lookback) ||
    lookback < 12 ||
    lookback > 120
  ) {
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

  const config: RankingPrivateConfigV3 = {
    rankingVersion: raw.ranking_version.trim(),
    weights: {
      price: weights.price!,
      liquidity: weights.liquidity!,
      turnover: weights.turnover!,
      householdScale: weights.householdScale!,
      stability: weights.stability!,
      momentum: weights.momentum!,
      interest: weights.interest!,
    },
    minAvailableWeightShare: minShare,
    priceTopTierPercentileFloor: priceFloor,
    reliability: {
      high: reliability.high!,
      medium: reliability.medium!,
      low: reliability.low!,
      missing: reliability.missing!,
    },
    normalizationCap: cap,
    priceLookbackMonths: lookback,
  };
  return { ok: true, config, fingerprint: fingerprintConfigV3(config) };
}
