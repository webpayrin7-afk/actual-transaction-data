/**
 * Read-only Songpa full-region 84㎡ feature extract.
 * The cohort is every canonical complex with at least one in-band sale.
 * It does not apply ranking eligibility thresholds.
 * Does not score, rank, or write Production.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { activeAreaBand, AREA_BAND_VERSION } from "../../src/lib/region-ranking/area-band";
import { extractFeatures } from "../../src/lib/region-ranking/features";
import { cohortInputId, featureRunId } from "../../src/lib/region-ranking/run-identity";
import { FEATURE_VERSION, snapshotIdentity, windowsFromAsOf } from "../../src/lib/region-ranking/snapshot";

const RESOLUTION_PATH = "data/poc/region-ranking/songpa-full-84-profile-resolution.json";
const OUT_PATH = "data/poc/region-ranking/songpa-full-84-feature-snapshot.json";
const PINNED_AS_OF = "2026-09-17";
const LAWD = "11710";
const ORIGIN = "SONGPA_FULL_84_FEATURE_UNIVERSE";

type ResolutionRow = {
  complex_id: string;
  household_count: number | null;
  profile_source: string | null;
  profile_source_key: string | null;
  profile_confidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING";
  profile_as_of: string | null;
  unresolved_reason: string | null;
};

type ResolutionFile = {
  cohort_origin: string;
  rows: ResolutionRow[];
};

async function main() {
  const resolution = JSON.parse(readFileSync(RESOLUTION_PATH, "utf8")) as ResolutionFile;
  if (resolution.cohort_origin !== ORIGIN) throw new Error("resolution origin mismatch");
  const byProfile = new Map(resolution.rows.map((row) => [row.complex_id, row]));
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const max = await db.execute(
    `SELECT MAX(deal_date) AS m FROM transactions WHERE lawd_cd = '${LAWD}' AND deal_type = 'trade'`,
  );
  const warehouseMax = String(max.rows[0].m).slice(0, 10);
  const windows = windowsFromAsOf(PINNED_AS_OF);
  const band = activeAreaBand("84");
  const universe = await db.execute({
    sql: `SELECT m.complex_id, m.apt_name_norm, m.lawd_cd, m.bjdong_cd, m.identity_status
          FROM apt_complex_master m
          JOIN transactions t
            ON t.lawd_cd = m.lawd_cd AND t.apt_name_norm = m.apt_name_norm
          WHERE m.lawd_cd = ?
            AND t.deal_type = 'trade'
            AND t.deal_date > ?
            AND t.deal_date <= ?
            AND t.exclusive_area >= ?
            AND t.exclusive_area <= ?
          GROUP BY m.complex_id, m.apt_name_norm, m.lawd_cd, m.bjdong_cd, m.identity_status
          ORDER BY m.complex_id ASC`,
    args: [LAWD, windows.base12m.startExclusive, windows.base12m.endInclusive, band.exclusiveSqmMin, band.exclusiveSqmMax],
  });
  const nameCounts = await db.execute({
    sql: `SELECT apt_name_norm, COUNT(*) AS c
          FROM apt_complex_master
          WHERE lawd_cd = ?
          GROUP BY apt_name_norm
          HAVING COUNT(*) > 1`,
    args: [LAWD],
  });
  const duplicateNames = new Set(nameCounts.rows.map((row) => String(row.apt_name_norm)));
  const norms = universe.rows.map((row) => String(row.apt_name_norm));
  const tx = await db.execute({
    sql: `SELECT apt_name_norm, deal_date, exclusive_area, deal_amount
          FROM transactions
          WHERE lawd_cd = ?
            AND deal_type = 'trade'
            AND apt_name_norm IN (${norms.map(() => "?").join(",")})
            AND deal_date > ?
            AND deal_date <= ?`,
    args: [LAWD, ...norms, windows.base12m.startExclusive, windows.base12m.endInclusive],
  });
  db.close();

  const cohort = universe.rows.map((row) => {
    const profile = byProfile.get(String(row.complex_id));
    return {
      complexId: String(row.complex_id),
      householdCount: profile?.household_count ?? null,
      profileConfidence: profile?.profile_confidence ?? "MISSING",
      cohortOrigin: ORIGIN,
    };
  });
  const inputId = cohortInputId(cohort);
  const runId = featureRunId({
    transactionAsOf: PINNED_AS_OF,
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

  function buildRows() {
    const rows = [];
    let duplicateIdentity = 0;
    let missingDong = 0;
    for (const master of universe.rows) {
      const id = String(master.complex_id);
      const profile = byProfile.get(id);
      if (!master.bjdong_cd) missingDong += 1;
      if (duplicateNames.has(String(master.apt_name_norm))) duplicateIdentity += 1;
      const dealRows = tx.rows
        .filter((row) => row.apt_name_norm === master.apt_name_norm)
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
          householdCount: profile?.household_count ?? null,
          source: profile?.profile_source ?? null,
          sourceKey: profile?.profile_source_key ?? null,
          sourceAsOf: profile?.profile_as_of ?? null,
          confidence: profile?.profile_confidence ?? "MISSING",
        },
      });
      const householdMissing = features.householdCount == null || features.householdCount <= 0;
      rows.push({
        ...identity,
        complex_id: id,
        apt_name_norm: String(master.apt_name_norm),
        lawd_cd: String(master.lawd_cd),
        bjdong_cd: master.bjdong_cd == null ? null : String(master.bjdong_cd),
        identity_status: master.identity_status == null ? null : String(master.identity_status),
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
        eligible_input: !householdMissing,
        exclusion_reason: householdMissing ? "HOUSEHOLD_PROFILE_MISSING" : null,
        unresolved_reason: profile?.unresolved_reason ?? (householdMissing ? "NO_UNIQUE_OFFICIAL_KEY" : null),
        building_count_used: false,
        scoring: false,
      });
    }
    return { rows, duplicateIdentity, missingDong };
  }

  const first = buildRows();
  const second = buildRows();
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("in-memory rerun diverged");
  const dongs = new Set(first.rows.map((row) => row.bjdong_cd).filter(Boolean));
  const doc = {
    status: "FEATURE_EXTRACT_ONLY",
    sample_label: ORIGIN,
    scoring: false,
    private_config: "ABSENT",
    production_write: false,
    lawd_cd: LAWD,
    cohort_input_id: inputId,
    feature_run_id: runId,
    transaction_as_of: PINNED_AS_OF,
    warehouse_max_deal_date: warehouseMax,
    source_window_start: windows.base12m.startExclusive,
    source_window_end: windows.base12m.endInclusive,
    recent_3m: windows.recent3m,
    previous_3m: windows.previous3m,
    area_band: "84",
    area_band_version: AREA_BAND_VERSION,
    area_band_bounds: [band.exclusiveSqmMin, band.exclusiveSqmMax],
    feature_version: FEATURE_VERSION,
    feature_rows: first.rows.length,
    duplicate_identity: first.duplicateIdentity,
    missing_bjdong: first.missingDong,
    dong_count: dongs.size,
    household_confirmed: first.rows.filter((row) => row.household_count != null).length,
    household_missing: first.rows.filter((row) => row.household_count == null).length,
    deterministic_in_memory_rerun: "IDENTICAL",
    building_count_used: false,
    rows: first.rows,
  };
  mkdirSync("data/poc/region-ranking", { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(doc, null, 2) + "\n");
  console.log(JSON.stringify({
    feature_run_id: runId,
    feature_rows: doc.feature_rows,
    duplicate_identity: doc.duplicate_identity,
    dong_count: doc.dong_count,
    household_confirmed: doc.household_confirmed,
    household_missing: doc.household_missing,
    transaction_as_of: PINNED_AS_OF,
    warehouse_max_deal_date: warehouseMax,
  }));
}

main();
