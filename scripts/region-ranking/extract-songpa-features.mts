/**
 * Read-only Songpa 84㎡ feature extract for the fixed ORIGINAL_POC 25.
 * Does not score, rank, or write Production.
 *
 * Cohort: data/poc/region-ranking/songpa-original-poc-25.json
 * Household overlay is sample-only. Conflicts are excluded, not chosen.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { activeAreaBand, AREA_BAND_VERSION, REJECTED_84_ALTERNATE, inAreaBand } from "../../src/lib/region-ranking/area-band";
import { extractFeatures } from "../../src/lib/region-ranking/features";
import {
  parsePocCohort,
  resolveProfileOverlay,
  type WarehouseHousehold,
} from "../../src/lib/region-ranking/profile-overlay";
import { cohortInputId, featureRunId } from "../../src/lib/region-ranking/run-identity";
import { FEATURE_VERSION, snapshotIdentity, windowsFromAsOf } from "../../src/lib/region-ranking/snapshot";

const COHORT_PATH = "data/poc/region-ranking/songpa-original-poc-25.json";
const OUT_DIR = "data/poc/region-ranking";
const PINNED_AS_OF = "2026-09-17";
const CITED = ["헬리오시티", "주공아파트5단지"] as const;

function numOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const max = await db.execute(
    `SELECT MAX(deal_date) AS m FROM transactions WHERE lawd_cd = '11710' AND deal_type = 'trade'`,
  );
  const warehouseMax = String(max.rows[0].m).slice(0, 10);
  if (warehouseMax < PINNED_AS_OF) {
    throw new Error(`warehouse max deal_date ${warehouseMax} is before pinned ${PINNED_AS_OF}`);
  }
  const asOf = PINNED_AS_OF;
  const windows = windowsFromAsOf(asOf);
  const band = activeAreaBand("84");
  const cohort = parsePocCohort(JSON.parse(readFileSync(COHORT_PATH, "utf8")));
  const ids = cohort.map((row) => row.complexId).sort();

  const citedMasters = await db.execute({
    sql: `SELECT complex_id, apt_name_norm
          FROM apt_complex_master
          WHERE lawd_cd = '11710' AND apt_name_norm IN (?, ?)`,
    args: [...CITED],
  });
  const citedDeals = await db.execute({
    sql: `SELECT apt_name_norm, exclusive_area
          FROM transactions
          WHERE lawd_cd = '11710' AND deal_type = 'trade'
            AND apt_name_norm IN (?, ?)
            AND deal_date > ? AND deal_date <= ?`,
    args: [...CITED, windows.base12m.startExclusive, windows.base12m.endInclusive],
  });
  const audit = [];
  for (const name of CITED) {
    const masters = citedMasters.rows.filter((row) => row.apt_name_norm === name);
    const rows = citedDeals.rows.filter((row) => row.apt_name_norm === name);
    audit.push({
      apt_name_norm: name,
      master_rows: masters.length,
      complex_id: masters.length === 1 ? String(masters[0].complex_id) : null,
      trade_count_band_v1: rows.filter((row) => inAreaBand(Number(row.exclusive_area), band)).length,
      trade_count_rejected_82_87: rows.filter((row) =>
        inAreaBand(Number(row.exclusive_area), REJECTED_84_ALTERNATE),
      ).length,
    });
  }

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
          WHERE lawd_cd = '11710' AND apt_name_norm IN (${norms.map(() => "?").join(",")})
          GROUP BY apt_name_norm`,
    args: norms,
  });
  const nameCount = new Map(nameCounts.rows.map((row) => [String(row.apt_name_norm), Number(row.c)]));
  const tx = await db.execute({
    sql: `SELECT apt_name_norm, deal_date, exclusive_area, deal_amount
          FROM transactions
          WHERE lawd_cd = '11710' AND deal_type = 'trade'
            AND apt_name_norm IN (${norms.map(() => "?").join(",")})
            AND deal_date > ? AND deal_date <= ?`,
    args: [...norms, windows.base12m.startExclusive, windows.base12m.endInclusive],
  });
  const profiles = await db.execute({
    sql: `SELECT complex_id, household_count, source, updated_at
          FROM apt_complex_profile WHERE complex_id IN (${ph})`,
    args: ids,
  });
  const links = await db.execute({
    sql: `SELECT complex_id, source_key
          FROM apt_complex_source_links
          WHERE complex_id IN (${ph}) AND source = 'KAPT'`,
    args: ids,
  });
  const profileById = new Map(profiles.rows.map((row) => [String(row.complex_id), row]));
  const kaptById = new Map(links.rows.map((row) => [String(row.complex_id), String(row.source_key)]));
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
    cohortInputId: cohortInputId(cohort),
  });
  const identity = snapshotIdentity({
    featureRunId: runId,
    windows,
  });

  const rows = [];
  const excluded = [];
  const conflicts = [];
  let overlayRows = 0;
  let matchRows = 0;
  for (const poc of [...cohort].sort((a, b) => a.complexId.localeCompare(b.complexId))) {
    const id = poc.complexId;
    const profileRow = profileById.get(id);
    const warehouse: WarehouseHousehold | null = profileRow
      ? {
          householdCount: numOrNull(profileRow.household_count),
          source: profileRow.source == null ? null : String(profileRow.source),
          sourceKey: kaptById.get(id) ?? null,
          sourceAsOf: profileRow.updated_at == null ? null : String(profileRow.updated_at),
        }
      : null;
    const resolution = resolveProfileOverlay(poc, warehouse);
    if (resolution.status === "PRODUCTION_MATCH") matchRows += 1;
    if (resolution.status === "POC_OVERLAY") overlayRows += 1;
    if (resolution.status === "PROFILE_CONFLICT") {
      conflicts.push({
        complex_id: id,
        production_household_count: resolution.productionHousehold,
        poc_household_count: resolution.pocHousehold,
      });
    }
    const master = byId.get(id);
    const reasons: string[] = [];
    if (!master || String(master.lawd_cd) !== "11710") reasons.push("NOT_IN_SONGPA_MASTER");
    if (master && nameCount.get(String(master.apt_name_norm)) !== 1) reasons.push("AMBIGUOUS_IDENTITY");
    if (resolution.status === "PROFILE_CONFLICT") reasons.push("PROFILE_CONFLICT");
    if (reasons.length > 0 || resolution.status === "PROFILE_CONFLICT") {
      excluded.push({ complex_id: id, exclusion_reason: reasons.join(",") || "PROFILE_CONFLICT" });
      continue;
    }
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
      profile: resolution.profile,
    });
    const eligibleInput = features.householdCount != null && features.householdCount > 0;
    const shared = {
      ...identity,
      complex_id: id,
      apt_name_norm: String(master!.apt_name_norm),
      lawd_cd: String(master!.lawd_cd),
      bjdong_cd: master!.bjdong_cd == null ? null : String(master!.bjdong_cd),
      area_band: "84",
      area_band_version: AREA_BAND_VERSION,
      area_band_min: band.exclusiveSqmMin,
      area_band_max: band.exclusiveSqmMax,
      period: "12M",
      recent_3m_window: windows.recent3m,
      previous_3m_window: windows.previous3m,
      profile_resolution: resolution.status,
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
      eligible_input: eligibleInput,
      exclusion_reason: eligibleInput ? null : "PROFILE_HOUSEHOLD_MISSING",
      building_count_used: false,
      scoring: false,
    };
    if (
      shared.featureRunId !== runId ||
      shared.transactionAsOf !== asOf ||
      shared.sourceWindowStart !== windows.base12m.startExclusive ||
      shared.sourceWindowEnd !== windows.base12m.endInclusive ||
      shared.featureVersion !== FEATURE_VERSION
    ) {
      throw new Error(`snapshot identity diverged for ${id}`);
    }
    rows.push(shared);
  }

  const doc = {
    status: "FEATURE_EXTRACT_ONLY",
    scoring: false,
    private_config: "ABSENT",
    production_write: false,
    migration_applied: false,
    cohort: "songpa-original-poc-25",
    cohort_rows: cohort.length,
    profile_overlay_rows: overlayRows,
    production_profile_matches: matchRows,
    profile_conflicts: conflicts,
    feature_run_id: runId,
    transaction_as_of: asOf,
    warehouse_max_deal_date: warehouseMax,
    source_window_start: windows.base12m.startExclusive,
    source_window_end: windows.base12m.endInclusive,
    recent_3m: windows.recent3m,
    previous_3m: windows.previous3m,
    area_band: "84",
    area_band_version: AREA_BAND_VERSION,
    area_band_bounds: [band.exclusiveSqmMin, band.exclusiveSqmMax],
    feature_version: FEATURE_VERSION,
    feature_rows: rows.length,
    excluded,
    median_price_calculated: rows.every((row) => row.median_price_per_sqm != null),
    trade_count_calculated: rows.every((row) => typeof row.trade_count === "number"),
    turnover_calculated: rows.every((row) => row.turnover != null),
    active_months_calculated: rows.every((row) => typeof row.active_month_count === "number"),
    momentum_inputs_calculated: rows.every(
      (row) =>
        typeof row.recent_3m_trade_count === "number" &&
        typeof row.previous_3m_trade_count === "number",
    ),
    cited_current_counts: audit,
    prior_manifest_note:
      "Codex manifest trade counts are not inputs. Current pinned snapshot counts are the sample.",
    rows,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/area-band-audit.json`, JSON.stringify({
    area_band_version: AREA_BAND_VERSION,
    transaction_as_of: asOf,
    warehouse_max_deal_date: warehouseMax,
    source_window_start: windows.base12m.startExclusive,
    source_window_end: windows.base12m.endInclusive,
    cited: audit,
    note: "Counts are from one read of the pinned snapshot. Manifest counts are not mixed in.",
  }, null, 2) + "\n");
  writeFileSync(`${OUT_DIR}/songpa-84-feature-snapshot.json`, JSON.stringify(doc, null, 2) + "\n");
  console.log(JSON.stringify({
    status: doc.status,
    feature_run_id: runId,
    feature_rows: doc.feature_rows,
    excluded: excluded.length,
    profile_overlay_rows: overlayRows,
    production_profile_matches: matchRows,
    profile_conflicts: conflicts.length,
    transaction_as_of: asOf,
  }));
  db.close();
}

main();
