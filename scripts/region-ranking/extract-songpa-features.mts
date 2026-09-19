/**
 * Read-only Songpa 84㎡ feature extract.
 * Does not score, rank, or write Production.
 *
 * Cohort file, when present:
 *   data/poc/region-ranking/songpa-original-poc-25.json
 *   { "complex_ids": ["cx_..."] }
 * If that file is absent, the ORIGINAL_POC sample is not invented.
 * A cited-count audit for 헬리오시티 and 주공아파트5단지 still runs.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createClient } from "@libsql/client";
import { activeAreaBand, AREA_BAND_VERSION, REJECTED_84_ALTERNATE, inAreaBand } from "../../src/lib/region-ranking/area-band";
import { evaluateEligibility } from "../../src/lib/region-ranking/eligibility";
import { extractFeatures, type ProfileInput } from "../../src/lib/region-ranking/features";
import { FEATURE_VERSION, snapshotIdentity, windowsFromAsOf } from "../../src/lib/region-ranking/snapshot";

const COHORT_PATH = "data/poc/region-ranking/songpa-original-poc-25.json";
const OUT_DIR = "data/poc/region-ranking";
const CITED = ["헬리오시티", "주공아파트5단지"] as const;

function profileConfidence(source: string | null, household: number | null): ProfileInput["confidence"] {
  if (household == null) return "MISSING";
  if (source === "kapt_basis_v5") return "HIGH";
  if (source === "COMPOSITE") return "MEDIUM";
  return "LOW";
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const max = await db.execute(
    `SELECT MAX(deal_date) AS m FROM transactions WHERE lawd_cd = '11710' AND deal_type = 'trade'`,
  );
  const asOf = String(max.rows[0].m).slice(0, 10);
  const windows = windowsFromAsOf(asOf);
  const band = activeAreaBand("84");

  const citedMasters = await db.execute({
    sql: `SELECT complex_id, apt_name_norm, legal_dong_name, bjdong_cd, identity_status
          FROM apt_complex_master
          WHERE lawd_cd = '11710' AND apt_name_norm IN (?, ?)`,
    args: [...CITED],
  });
  const deals = await db.execute({
    sql: `SELECT apt_name_norm, deal_date, exclusive_area, deal_amount
          FROM transactions
          WHERE lawd_cd = '11710' AND deal_type = 'trade'
            AND apt_name_norm IN (?, ?)
            AND deal_date > ? AND deal_date <= ?`,
    args: [...CITED, windows.base12m.startExclusive, windows.base12m.endInclusive],
  });

  const audit = [];
  for (const name of CITED) {
    const masters = citedMasters.rows.filter((row) => row.apt_name_norm === name);
    const rows = deals.rows.filter((row) => row.apt_name_norm === name);
    const v1 = rows.filter((row) => inAreaBand(Number(row.exclusive_area), band)).length;
    const alt = rows.filter((row) => inAreaBand(Number(row.exclusive_area), REJECTED_84_ALTERNATE)).length;
    audit.push({
      apt_name_norm: name,
      master_rows: masters.length,
      complex_id: masters.length === 1 ? String(masters[0].complex_id) : null,
      trade_count_band_v1: v1,
      trade_count_rejected_82_87: alt,
    });
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const auditDoc = {
    area_band_version: AREA_BAND_VERSION,
    transaction_as_of: asOf,
    source_window_start: windows.base12m.startExclusive,
    source_window_end: windows.base12m.endInclusive,
    cited: audit,
    note: "Counts are from one read of the current warehouse. Manifest counts are not mixed in.",
  };
  writeFileSync(`${OUT_DIR}/area-band-audit.json`, JSON.stringify(auditDoc, null, 2) + "\n");

  if (!existsSync(COHORT_PATH)) {
    const blocked = {
      status: "COHORT_SOURCE_MISSING",
      cohort: "songpa-original-poc-25",
      feature_rows: 0,
      transaction_as_of: asOf,
      feature_version: FEATURE_VERSION,
      production_write: false,
      scoring: false,
    };
    writeFileSync(`${OUT_DIR}/songpa-84-feature-snapshot.json`, JSON.stringify(blocked, null, 2) + "\n");
    console.log(JSON.stringify(blocked));
    db.close();
    return;
  }

  const cohort = JSON.parse(readFileSync(COHORT_PATH, "utf8")) as { complex_ids: string[] };
  const ids = [...new Set(cohort.complex_ids)].sort();
  if (ids.length !== 25) {
    throw new Error(`cohort must be 25 explicit ids, got ${ids.length}`);
  }
  const ph = ids.map(() => "?").join(",");
  const masters = await db.execute({
    sql: `SELECT complex_id, apt_name_norm, lawd_cd, legal_dong_name, bjdong_cd, identity_status
          FROM apt_complex_master WHERE complex_id IN (${ph})`,
    args: ids,
  });
  const byId = new Map(masters.rows.map((row) => [String(row.complex_id), row]));
  const normsForIds = [...new Set(masters.rows.map((row) => String(row.apt_name_norm)))];
  const tx = await db.execute({
    sql: `SELECT apt_name_norm, deal_date, exclusive_area, deal_amount
          FROM transactions
          WHERE lawd_cd = '11710' AND deal_type = 'trade'
            AND apt_name_norm IN (${normsForIds.map(() => "?").join(",")})
            AND deal_date > ? AND deal_date <= ?`,
    args: [...normsForIds, windows.base12m.startExclusive, windows.base12m.endInclusive],
  });
  const profiles = await db.execute({
    sql: `SELECT complex_id, household_count, source, source_version, updated_at
          FROM apt_complex_profile WHERE complex_id IN (${ph})`,
    args: ids,
  });
  const links = await db.execute({
    sql: `SELECT complex_id, source, source_key
          FROM apt_complex_source_links
          WHERE complex_id IN (${ph}) AND source = 'KAPT'`,
    args: ids,
  });
  const profileById = new Map(profiles.rows.map((row) => [String(row.complex_id), row]));
  const kaptById = new Map(links.rows.map((row) => [String(row.complex_id), String(row.source_key)]));
  const runId = createHash("sha256")
    .update(JSON.stringify({
      feature: FEATURE_VERSION,
      band: AREA_BAND_VERSION,
      asOf,
      ids,
    }))
    .digest("hex");
  const identity = snapshotIdentity({
    calculationRunId: runId,
    windows,
    rankingVersion: "private-config-not-in-repo",
  });
  const rows = [];
  let excluded = 0;
  for (const id of ids) {
    const master = byId.get(id);
    if (!master || String(master.lawd_cd) !== "11710") {
      excluded += 1;
      rows.push({ complex_id: id, exclusion_reason: "NOT_IN_SONGPA_MASTER" });
      continue;
    }
    const dupes = masters.rows.filter((row) => row.apt_name_norm === master.apt_name_norm);
    if (dupes.length !== 1) {
      excluded += 1;
      rows.push({ complex_id: id, exclusion_reason: "AMBIGUOUS_IDENTITY" });
      continue;
    }
    const dealRows = tx.rows
      .filter((row) => row.apt_name_norm === master.apt_name_norm)
      .map((row) => ({
        dealDate: String(row.deal_date),
        exclusiveArea: Number(row.exclusive_area),
        dealAmount: Number(row.deal_amount),
      }));
    const profileRow = profileById.get(id);
    const household = profileRow?.household_count == null ? null : Number(profileRow.household_count);
    const source = profileRow?.source == null ? null : String(profileRow.source);
    const features = extractFeatures({
      deals: dealRows,
      band,
      windows,
      profile: {
        householdCount: household,
        source,
        sourceKey: kaptById.get(id) ?? null,
        sourceAsOf: profileRow?.updated_at == null ? null : String(profileRow.updated_at),
        confidence: profileConfidence(source, household),
      },
    });
    const gate = evaluateEligibility({
      features,
      transactionAsOf: asOf,
      identityStatus: master.identity_status == null ? null : String(master.identity_status),
      config: { requireHouseholdProfile: true },
    });
    if (!gate.eligibleInput) excluded += 1;
    const shared = {
      ...identity,
      complex_id: id,
      area_band: "84",
      area_band_version: AREA_BAND_VERSION,
      period: "12M",
      median_price_per_sqm: features.medianPricePerSqm,
      median_deal_amount: features.medianDealAmount,
      trade_count: features.tradeCount,
      household_count: features.householdCount,
      turnover: features.turnover,
      active_month_count: features.activeMonthCount,
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
      eligible_input: gate.eligibleInput,
      exclusion_reason: gate.exclusionReason,
      building_count_used: false,
    };
    rows.push({ ...shared, region_scope: "gu", region_code: "11710" });
    rows.push({
      ...shared,
      region_scope: "dong",
      region_code: master.bjdong_cd == null ? null : String(master.bjdong_cd),
    });
  }
  const doc = {
    status: "FEATURE_EXTRACT_ONLY",
    scoring: false,
    production_write: false,
    cohort: "songpa-original-poc-25",
    transaction_as_of: asOf,
    feature_rows: rows.filter((row) => row.region_scope === "gu").length,
    scope_rows: rows.length,
    excluded,
    turnover_calculated: rows.some((row) => row.turnover != null),
    stability_calculated: rows.some((row) => row.active_month_count != null),
    momentum_calculated: rows.some((row) => row.recent_3m_trade_count != null),
    rows,
  };
  writeFileSync(`${OUT_DIR}/songpa-84-feature-snapshot.json`, JSON.stringify(doc, null, 2) + "\n");
  console.log(JSON.stringify({
    status: doc.status,
    feature_rows: doc.feature_rows,
    excluded: doc.excluded,
    transaction_as_of: asOf,
  }));
  db.close();
}

main();
