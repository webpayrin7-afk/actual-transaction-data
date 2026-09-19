/**
 * Collapse the phase-1 Songpa extract, which stored the same features twice
 * (gu and dong), into one feature row per complex.
 * Does not read transactions or apt_complex_profile.
 */

import { FEATURE_VERSION } from "./snapshot";
import type { FeatureSnapshotRow } from "./score";
import { featureRunId } from "./run-identity";

const NUMERIC_KEYS = [
  "median_price_per_sqm",
  "median_deal_amount",
  "trade_count",
  "household_count",
  "turnover",
  "active_month_count",
  "recent_3m_trade_count",
  "previous_3m_trade_count",
  "recent_3m_median_price_per_sqm",
  "previous_3m_median_price_per_sqm",
] as const;

type Phase1Row = Record<string, unknown>;

function str(row: Phase1Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value === "") throw new Error(`missing ${key}`);
  return value;
}

function numOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("bad number");
  return value;
}

export function normalizePhase1FeatureSnapshot(params: {
  doc: {
    transaction_as_of: string;
    source_window_start: string;
    source_window_end: string;
    recent_3m: { startExclusive: string; endInclusive: string };
    previous_3m: { startExclusive: string; endInclusive: string };
    area_band: string;
    area_band_version: string;
    feature_version: string;
    rows: Phase1Row[];
  };
  cohortInputId: string;
}): { featureRunId: string; rows: FeatureSnapshotRow[] } {
  const doc = params.doc;
  if (doc.feature_version !== FEATURE_VERSION) throw new Error("feature_version mismatch");
  const gu = doc.rows.filter((row) => row.region_scope === "gu");
  const dong = doc.rows.filter((row) => row.region_scope === "dong");
  if (gu.length === 0 || gu.length !== dong.length) throw new Error("gu/dong row count mismatch");
  const dongById = new Map(dong.map((row) => [str(row, "complex_id"), row]));
  const rows: FeatureSnapshotRow[] = [];
  for (const row of gu) {
    const id = str(row, "complex_id");
    const pair = dongById.get(id);
    if (!pair) throw new Error(`missing dong row ${id}`);
    for (const key of NUMERIC_KEYS) {
      if (row[key] !== pair[key]) throw new Error(`gu/dong feature mismatch ${id} ${key}`);
    }
    if (str(row, "transactionAsOf") !== doc.transaction_as_of) throw new Error("mixed as-of");
    if (str(row, "area_band") !== doc.area_band) throw new Error("mixed area band");
    const confidence = str(row, "profile_confidence");
    if (confidence !== "HIGH" && confidence !== "MEDIUM" && confidence !== "LOW" && confidence !== "MISSING") {
      throw new Error(`bad confidence ${id}`);
    }
    rows.push({
      complexId: id,
      lawdCd: str(row, "region_code"),
      bjdongCd: str(pair, "region_code"),
      areaBand: str(row, "area_band"),
      areaBandVersion: str(row, "area_band_version"),
      period: str(row, "period"),
      transactionAsOf: str(row, "transactionAsOf"),
      sourceWindowStart: str(row, "sourceWindowStart"),
      sourceWindowEnd: str(row, "sourceWindowEnd"),
      recentWindowStart: doc.recent_3m.startExclusive,
      recentWindowEnd: doc.recent_3m.endInclusive,
      previousWindowStart: doc.previous_3m.startExclusive,
      previousWindowEnd: doc.previous_3m.endInclusive,
      medianPricePerSqm: numOrNull(row.median_price_per_sqm),
      medianDealAmount: numOrNull(row.median_deal_amount),
      tradeCount: numOrNull(row.trade_count) ?? 0,
      householdCount: numOrNull(row.household_count),
      turnover: numOrNull(row.turnover),
      activeMonthCount: numOrNull(row.active_month_count) ?? 0,
      latestDealDate: row.latest_deal_date == null ? null : str(row, "latest_deal_date"),
      recent3mTradeCount: numOrNull(row.recent_3m_trade_count) ?? 0,
      previous3mTradeCount: numOrNull(row.previous_3m_trade_count) ?? 0,
      recent3mMedianPricePerSqm: numOrNull(row.recent_3m_median_price_per_sqm),
      previous3mMedianPricePerSqm: numOrNull(row.previous_3m_median_price_per_sqm),
      featureVersion: str(row, "featureVersion"),
      profileSource: row.profile_source == null ? null : str(row, "profile_source"),
      profileConfidence: confidence,
      identityStatus: null,
    });
  }
  rows.sort((a, b) => a.complexId.localeCompare(b.complexId));
  const runId = featureRunId({
    transactionAsOf: doc.transaction_as_of,
    sourceWindowStart: doc.source_window_start,
    sourceWindowEnd: doc.source_window_end,
    recentWindowStart: doc.recent_3m.startExclusive,
    recentWindowEnd: doc.recent_3m.endInclusive,
    previousWindowStart: doc.previous_3m.startExclusive,
    previousWindowEnd: doc.previous_3m.endInclusive,
    areaBand: doc.area_band,
    areaBandVersion: doc.area_band_version,
    featureVersion: doc.feature_version,
    cohortInputId: params.cohortInputId,
  });
  return { featureRunId: runId, rows };
}
