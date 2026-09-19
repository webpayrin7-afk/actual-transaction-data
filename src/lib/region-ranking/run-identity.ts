/**
 * Feature runs and ranking runs are separate identities.
 * This module does not contain weights or thresholds.
 */

import { createHash } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type CohortInputRow = {
  complexId: string;
  householdCount: number;
  profileConfidence: string;
  cohortOrigin: string;
};

/** Identity of the pinned cohort input. Not a hash of computed trade features. */
export function cohortInputId(rows: readonly CohortInputRow[]): string {
  const canonical = [...rows]
    .sort((a, b) => a.complexId.localeCompare(b.complexId))
    .map((row) => ({
      complex_id: row.complexId,
      household_count: row.householdCount,
      profile_confidence: row.profileConfidence,
      cohort_origin: row.cohortOrigin,
    }));
  return sha256Hex(JSON.stringify(canonical));
}

export type FeatureRunParts = {
  transactionAsOf: string;
  sourceWindowStart: string;
  sourceWindowEnd: string;
  recentWindowStart: string;
  recentWindowEnd: string;
  previousWindowStart: string;
  previousWindowEnd: string;
  areaBand: string;
  areaBandVersion: string;
  featureVersion: string;
  cohortInputId: string;
};

/** Same raw feature snapshot. Ranking config is intentionally absent. */
export function featureRunId(parts: FeatureRunParts): string {
  return sha256Hex(JSON.stringify({
    transaction_as_of: parts.transactionAsOf,
    source_window_start: parts.sourceWindowStart,
    source_window_end: parts.sourceWindowEnd,
    recent_window_start: parts.recentWindowStart,
    recent_window_end: parts.recentWindowEnd,
    previous_window_start: parts.previousWindowStart,
    previous_window_end: parts.previousWindowEnd,
    area_band: parts.areaBand,
    area_band_version: parts.areaBandVersion,
    feature_version: parts.featureVersion,
    cohort_input_id: parts.cohortInputId,
  }));
}

export type RankingRunParts = {
  featureRunId: string;
  rankingVersion: string;
  privateConfigFingerprint: string;
  regionScope: string;
  regionCode: string;
};

/** One ranking config applied to one regional cohort. Config values are not stored. */
export function rankingRunId(parts: RankingRunParts): string {
  return sha256Hex(JSON.stringify({
    feature_run_id: parts.featureRunId,
    ranking_version: parts.rankingVersion,
    private_config_fingerprint: parts.privateConfigFingerprint,
    region_scope: parts.regionScope,
    region_code: parts.regionCode,
  }));
}
