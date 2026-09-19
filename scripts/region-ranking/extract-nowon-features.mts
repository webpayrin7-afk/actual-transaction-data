/**
 * Read-only Nowon 84㎡ feature extract for the cross-region backtest sample.
 * Does not score, rank, or write Production.
 *
 * Cohort: data/poc/region-ranking/nowon-cross-region-backtest-cohort.json
 * Household is already frozen from a unique official join. This script does not
 * call K-apt and does not write apt_complex_profile.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { activeAreaBand, AREA_BAND_VERSION } from "../../src/lib/region-ranking/area-band";
import { extractFeatures } from "../../src/lib/region-ranking/features";
import { cohortInputId, featureRunId } from "../../src/lib/region-ranking/run-identity";
import { FEATURE_VERSION, snapshotIdentity, windowsFromAsOf } from "../../src/lib/region-ranking/snapshot";

const COHORT_PATH = "data/poc/region-ranking/nowon-cross-region-backtest-cohort.json";
const OUT_DIR = "data/poc/region-ranking";
const PINNED_AS_OF = "2026-09-17";
const LAWD = "11350";

type CohortFile = {
  cohort_origin: string;
  unresolved: Array<{ complex_id: string; reason: string }>;
  rows: Array<{
    complex_id: string;
    household_count: number;
    profile_confidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING";
    cohort_origin: string;
    profile_source: string;
    profile_source_key: string;
    profile_as_of: string;
  }>;
};

function num(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("bad number");
  return n;
}

async function main() {
  const cohortFile = JSON.parse(readFileSync(COHORT_PATH, "utf8")) as CohortFile;
  if (cohortFile.cohort_origin !== "CROSS_REGION_BACKTEST_SAMPLE") {
    throw new Error("cohort origin is not the backtest sample");
  }
  const cohort = cohortFile.rows.map((row) => {
    if (!Number.isInteger(row.household_count) || row.household_count <= 0) {
      throw new Error(`household missing for ${row.complex_id}`);
    }
    return {
      complexId: row.complex_id,
      householdCount: row.household_count,
      profileConfidence: row.profile_confidence,
      cohortOrigin: row.cohort_origin,
    };
  });
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const max = await db.execute(
    `SELECT MAX(deal_date) AS m, COUNT(*) AS c FROM transactions WHERE lawd_cd = '${LAWD}' AND deal_type = 'trade'`,
  );
  const warehouseMax = String(max.rows[0].m).slice(0, 10);
  if (warehouseMax > PINNED_AS_OF) {
    throw new Error(`warehouse max ${warehouseMax} is after pinned ${PINNED_AS_OF}; refuse a moving snapshot`);
  }
  const asOf = PINNED_AS_OF;
  const windows = windowsFromAsOf(asOf);
  const band = activeAreaBand("84");
  const ids = cohort.map((row) => row.complexId);
  const ph = ids.map(() => "?").join(",");
  const masters = await db.execute({
    sql: `SELECT complex_id, apt_name_norm, lawd_cd, bjdong_cd, identity_status
          FROM apt_complex_master WHERE complex_id IN (${ph})`,
    args: ids,
  });
  const byId = new Map(masters.rows.map((row) => [String(row.complex_id), row]));
  const norms = [...new Set(masters.rows.map((row) => String(row.apt_name_norm)))];
  const nameCounts = await db.execute({
    sql: `SELECT apt_name_norm, COUNT(*) AS c
          FROM apt_complex_master
          WHERE lawd_cd = '${LAWD}' AND apt_name_norm IN (${norms.map(() => "?").join(",")})
          GROUP BY apt_name_norm`,
    args: norms,
  });
  const nameCount = new Map(nameCounts.rows.map((row) => [String(row.apt_name_norm), Number(row.c)]));
  const tx = await db.execute({
    sql: `SELECT apt_name_norm, deal_date, exclusive_area, deal_amount
          FROM transactions
          WHERE lawd_cd = '${LAWD}' AND deal_type = 'trade'
            AND apt_name_norm IN (${norms.map(() => "?").join(",")})
            AND deal_date > ? AND deal_date <= ?`,
    args: [...norms, windows.base12m.startExclusive, windows.base12m.endInclusive],
  });
  const candidateCount = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM (
            SELECT m.complex_id
            FROM apt_complex_master m
            JOIN transactions t
              ON t.lawd_cd = m.lawd_cd AND t.apt_name_norm = m.apt_name_norm
            WHERE m.lawd_cd = '${LAWD}' AND t.deal_type = 'trade'
              AND t.deal_date > ? AND t.deal_date <= ?
              AND t.exclusive_area >= ? AND t.exclusive_area <= ?
              AND m.apt_name_norm IN (
                SELECT apt_name_norm FROM apt_complex_master
                WHERE lawd_cd = '${LAWD}'
                GROUP BY apt_name_norm
                HAVING COUNT(*) = 1
              )
            GROUP BY m.complex_id
            HAVING COUNT(*) >= 8
          )`,
    args: [windows.base12m.startExclusive, windows.base12m.endInclusive, band.exclusiveSqmMin, band.exclusiveSqmMax],
  });
  const inputId = cohortInputId(cohort);
  const runId = featureRunId({
    transactionAsOf: asOf,
    sourceWindowStart: windows.base12m.startExclusive,
    sourceWindowEnd: windows.base12m.endInclusive,
    recentWindowStart: windows.recent3m.startExclusive,
    recentWindowEnd: windows.recent3m.endInclusive,
    previousWindowStart: windows.previous3m.startExclusive,
    previousWindowEnd: windows.previous3m.endInclusive,
    areaBand: "84",
    areaBandVersion: AREA_BAND_VERSION,
    featureVersion: FEATURE_VERSION,
    cohortInputId: inputId,
  });
  const identity = snapshotIdentity({ featureRunId: runId, windows });
  const profileById = new Map(cohortFile.rows.map((row) => [row.complex_id, row]));

  function buildRows() {
    const rows = [];
    const excluded = [];
    for (const member of [...cohort].sort((a, b) => a.complexId.localeCompare(b.complexId))) {
      const master = byId.get(member.complexId);
      const reasons: string[] = [];
      if (!master || String(master.lawd_cd) !== LAWD) reasons.push("NOT_IN_NOWON_MASTER");
      if (master && nameCount.get(String(master.apt_name_norm)) !== 1) reasons.push("AMBIGUOUS_IDENTITY");
      if (reasons.length > 0) {
        excluded.push({ complex_id: member.complexId, exclusion_reason: reasons.join(",") });
        continue;
      }
      const profile = profileById.get(member.complexId)!;
      const dealRows = tx.rows
        .filter((row) => row.apt_name_norm === master!.apt_name_norm)
        .map((row) => ({
          dealDate: String(row.deal_date),
          exclusiveArea: Number(row.exclusive_area),
          dealAmount: Number(row.deal_amount),
        }));
      const features = extractFeatures({
        deals: dealRows,
        band,
        windows,
        profile: {
          householdCount: profile.household_count,
          source: profile.profile_source,
          sourceKey: profile.profile_source_key,
          sourceAsOf: profile.profile_as_of,
          confidence: profile.profile_confidence,
        },
      });
      rows.push({
        ...identity,
        complex_id: member.complexId,
        apt_name_norm: String(master!.apt_name_norm),
        lawd_cd: String(master!.lawd_cd),
        bjdong_cd: master!.bjdong_cd == null ? null : String(master!.bjdong_cd),
        identity_status: master!.identity_status == null ? null : String(master!.identity_status),
        area_band: "84",
        area_band_version: AREA_BAND_VERSION,
        area_band_min: band.exclusiveSqmMin,
        area_band_max: band.exclusiveSqmMax,
        period: "12M",
        recent_3m_window: windows.recent3m,
        previous_3m_window: windows.previous3m,
        median_price_per_sqm: features.medianPricePerSqm,
        median_deal_amount: features.medianDealAmount,
        trade_count: features.tradeCount,
        household_count: features.householdCount,
        turnover: features.turnover,
        active_month_count: features.activeMonthCount,
        monthly_trade_counts: features.monthlyTradeCounts,
        latest_deal_date: features.latestDealDate,
        recent_3m_trade_count: features.recent3mTradeCount,
        previous_3m_trade_count: features.previous3mTradeCount,
        recent_3m_median_price_per_sqm: features.recent3mMedianPricePerSqm,
        previous_3m_median_price_per_sqm: features.previous3mMedianPricePerSqm,
        recent_3m_median_deal_amount: features.recent3mMedianDealAmount,
        previous_3m_median_deal_amount: features.previous3mMedianDealAmount,
        profile_source: features.profile.source,
        profile_source_key: features.profile.sourceKey,
        profile_as_of: features.profile.sourceAsOf,
        profile_confidence: features.profile.confidence,
        eligible_input: features.householdCount != null && features.householdCount > 0,
        exclusion_reason: null,
        building_count_used: false,
        scoring: false,
      });
    }
    return { rows, excluded };
  }

  const first = buildRows();
  const second = buildRows();
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("in-memory rerun diverged");
  }
  const doc = {
    status: "FEATURE_EXTRACT_ONLY",
    sample_label: "CROSS_REGION_BACKTEST_SAMPLE",
    scoring: false,
    private_config: "ABSENT",
    production_write: false,
    cohort: "nowon-cross-region-backtest",
    lawd_cd: LAWD,
    discovery_candidates: num(candidateCount.rows[0].c),
    discovered_selected: 25,
    household_confirmed: cohort.length,
    household_coverage: cohort.length / 25,
    profile_unresolved: cohortFile.unresolved,
    cohort_input_id: inputId,
    feature_run_id: runId,
    transaction_as_of: asOf,
    warehouse_max_deal_date: warehouseMax,
    warehouse_trade_rows: num(max.rows[0].c),
    source_window_start: windows.base12m.startExclusive,
    source_window_end: windows.base12m.endInclusive,
    recent_3m: windows.recent3m,
    previous_3m: windows.previous3m,
    area_band: "84",
    area_band_version: AREA_BAND_VERSION,
    area_band_bounds: [band.exclusiveSqmMin, band.exclusiveSqmMax],
    feature_version: FEATURE_VERSION,
    feature_rows: first.rows.length,
    excluded: first.excluded,
    deterministic_in_memory_rerun: "IDENTICAL",
    building_count_used: false,
    rows: first.rows,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/nowon-84-feature-snapshot.json`, JSON.stringify(doc, null, 2) + "\n");
  console.log(JSON.stringify({
    status: doc.status,
    feature_run_id: runId,
    feature_rows: doc.feature_rows,
    excluded: first.excluded.length,
    discovery_candidates: doc.discovery_candidates,
    household_confirmed: doc.household_confirmed,
    transaction_as_of: asOf,
    warehouse_max_deal_date: warehouseMax,
  }));
  db.close();
}

main();
