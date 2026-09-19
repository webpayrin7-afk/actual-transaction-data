/**
 * Phase 2 checks. TEST_ONLY configs are synthetic and are not a leaderboard.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateEligibility } from "../src/lib/region-ranking/eligibility";
import { precheckRankingMigrationSql } from "../src/lib/region-ranking/migration-precheck";
import { normalizePhase1FeatureSnapshot } from "../src/lib/region-ranking/normalize-snapshot";
import {
  loadPrivateConfig,
  loadPrivateConfigFromEnv,
  safeConfigLog,
} from "../src/lib/region-ranking/private-config";
import { parsePocCohort } from "../src/lib/region-ranking/profile-overlay";
import { cohortInputId, featureRunId, rankingRunId } from "../src/lib/region-ranking/run-identity";
import { compareRank, percentileRank, scoreCohort, type FeatureSnapshotRow } from "../src/lib/region-ranking/score";
import { extractFeatures } from "../src/lib/region-ranking/features";
import { activeAreaBand } from "../src/lib/region-ranking/area-band";
import { windowsFromAsOf } from "../src/lib/region-ranking/snapshot";

const sql = readFileSync("src/lib/db/migrations/20260919_region_ranking_foundation.sql", "utf8");
const precheck = precheckRankingMigrationSql(sql);
assert.equal(precheck.ok, true, precheck.ok ? "" : precheck.reason);

assert.equal(loadPrivateConfig(null).ok, false);
assert.equal(loadPrivateConfig(undefined).ok, false);
if (!loadPrivateConfig(null).ok) assert.equal(loadPrivateConfig(null).code, "PRIVATE_CONFIG_ABSENT");
assert.equal(loadPrivateConfig("nope").ok, false);
assert.equal(loadPrivateConfig({}).code, "PRIVATE_CONFIG_VERSION_MISSING");
assert.equal(loadPrivateConfig({ ranking_version: " " }).code, "PRIVATE_CONFIG_VERSION_MISSING");
assert.equal(loadPrivateConfig({ ranking_version: "X" }).code, "PRIVATE_CONFIG_MALFORMED");
assert.equal(loadPrivateConfigFromEnv({}).code, "PRIVATE_CONFIG_ABSENT");
assert.equal(loadPrivateConfigFromEnv({ REGION_RANKING_PRIVATE_CONFIG: "{" }).code, "PRIVATE_CONFIG_MALFORMED");

const TEST_ONLY = {
  ranking_version: "TEST_ONLY",
  weights: {
    price: 1,
    liquidity: 0,
    turnover: 0,
    household_scale: 0,
    stability: 0,
    momentum: 0,
  },
  min_trade_count: 0,
  min_active_months: 0,
  max_recency_days: 100000,
  require_household_profile: true,
  identity_confidence_floor: null,
  price_top_tier_percentile_floor: 0,
  reliability: { high: 1, medium: 1, low: 1, missing: 1 },
  normalization_cap: 1,
};
const TEST_ONLY_ALT = {
  ...TEST_ONLY,
  weights: {
    price: 0,
    liquidity: 1,
    turnover: 0,
    household_scale: 0,
    stability: 0,
    momentum: 0,
  },
};
const loaded = loadPrivateConfig(TEST_ONLY);
const loadedAlt = loadPrivateConfig(TEST_ONLY_ALT);
assert.equal(loaded.ok, true);
assert.equal(loadedAlt.ok, true);
if (!loaded.ok || !loadedAlt.ok) throw new Error("test config");
assert.notEqual(loaded.fingerprint, loadedAlt.fingerprint);
const log = safeConfigLog(loaded);
assert.equal(log.validation, "PASS");
assert.equal(log.ranking_version, "TEST_ONLY");
assert.equal("weights" in log, false);
assert.equal(JSON.stringify(log).includes("min_trade_count"), false);
assert.equal(safeConfigLog(loadPrivateConfig(null)).validation, "FAIL");

assert.equal(loadPrivateConfig({ ...TEST_ONLY, weights: { ...TEST_ONLY.weights, price: 0.2 } }).ok, false);
assert.equal(loadPrivateConfig({ ...TEST_ONLY, min_trade_count: -1 }).ok, false);
assert.equal(loadPrivateConfig({ ...TEST_ONLY, extra: 1 }).ok, false);

const cohort = parsePocCohort(JSON.parse(readFileSync("data/poc/region-ranking/songpa-original-poc-25.json", "utf8")));
const inputId = cohortInputId(cohort);
const doc = JSON.parse(readFileSync("data/poc/region-ranking/songpa-84-feature-snapshot.json", "utf8"));
const normalized = normalizePhase1FeatureSnapshot({ doc, cohortInputId: inputId });
const again = normalizePhase1FeatureSnapshot({ doc, cohortInputId: inputId });
assert.equal(normalized.featureRunId, again.featureRunId);
assert.equal(normalized.rows.length, 25);
assert.equal(new Set(normalized.rows.map((row) => row.lawdCd)).size, 1);
assert.equal(normalized.rows.every((row) => row.regionScope == null), true);
const dongCounts = new Map<string, number>();
for (const row of normalized.rows) dongCounts.set(row.bjdongCd, (dongCounts.get(row.bjdongCd) ?? 0) + 1);
const dongSum = [...dongCounts.values()].reduce((sum, n) => sum + n, 0);
assert.equal(dongSum, 25);
assert.ok(dongCounts.size > 1);

const absent = scoreCohort({
  featureRunId: normalized.featureRunId,
  rows: normalized.rows,
  regionScope: "gu",
  regionCode: normalized.rows[0]!.lawdCd,
  config: null,
  privateConfigFingerprint: null,
});
assert.equal(absent.ok, false);

const gu = scoreCohort({
  featureRunId: normalized.featureRunId,
  rows: normalized.rows,
  regionScope: "gu",
  regionCode: normalized.rows[0]!.lawdCd,
  config: loaded.config,
  privateConfigFingerprint: loaded.fingerprint,
});
const gu2 = scoreCohort({
  featureRunId: normalized.featureRunId,
  rows: normalized.rows,
  regionScope: "gu",
  regionCode: normalized.rows[0]!.lawdCd,
  config: loaded.config,
  privateConfigFingerprint: loaded.fingerprint,
});
assert.equal(gu.ok, true);
assert.equal(gu2.ok, true);
if (!gu.ok || !gu2.ok) throw new Error("gu score");
assert.equal(gu.cohortSize, 25);
assert.equal(gu.rankingRunId, gu2.rankingRunId);
assert.deepEqual(gu.rows, gu2.rows);
assert.equal(gu.featureRunId, normalized.featureRunId);
for (const row of gu.rows) {
  assert.deepEqual(Object.keys(row.publicDisplayMetrics).sort(), [
    "latest_deal_date",
    "median_deal_amount",
    "median_price_per_sqm",
    "trade_count",
  ]);
  assert.equal("score" in row, false);
  assert.equal(JSON.stringify(row.publicDisplayMetrics).includes("weight"), false);
}

const guAlt = scoreCohort({
  featureRunId: normalized.featureRunId,
  rows: normalized.rows,
  regionScope: "gu",
  regionCode: normalized.rows[0]!.lawdCd,
  config: loadedAlt.config,
  privateConfigFingerprint: loadedAlt.fingerprint,
});
assert.equal(guAlt.ok, true);
if (!guAlt.ok) throw new Error("alt");
assert.notEqual(guAlt.rankingRunId, gu.rankingRunId);
assert.equal(guAlt.featureRunId, gu.featureRunId);
assert.equal(
  guAlt.rankingRunId,
  rankingRunId({
    featureRunId: normalized.featureRunId,
    rankingVersion: loadedAlt.config.rankingVersion,
    privateConfigFingerprint: loadedAlt.fingerprint,
    regionScope: "gu",
    regionCode: normalized.rows[0]!.lawdCd,
  }),
);

const dongRuns = new Set<string>();
for (const [code, size] of dongCounts) {
  const dong = scoreCohort({
    featureRunId: normalized.featureRunId,
    rows: normalized.rows,
    regionScope: "dong",
    regionCode: code,
    config: loaded.config,
    privateConfigFingerprint: loaded.fingerprint,
  });
  assert.equal(dong.ok, true);
  if (!dong.ok) throw new Error("dong");
  assert.equal(dong.cohortSize, size);
  assert.equal(dong.featureRunId, normalized.featureRunId);
  assert.notEqual(dong.rankingRunId, gu.rankingRunId);
  dongRuns.add(dong.rankingRunId);
}
assert.equal(dongRuns.size, dongCounts.size);

const tiedA: FeatureSnapshotRow = { ...normalized.rows[0]!, complexId: "cx_000000000000000b", tradeCount: 3, medianPricePerSqm: 10 };
const tiedB: FeatureSnapshotRow = { ...tiedA, complexId: "cx_000000000000000a" };
const order = [ 
  { row: tiedA, eligible: true, exclusionReason: null, score: 1, priceSignal: 10 },
  { row: tiedB, eligible: true, exclusionReason: null, score: 1, priceSignal: 10 },
].sort(compareRank);
assert.equal(order[0]!.row.complexId, "cx_000000000000000a");
assert.equal(percentileRank(5, [1, 5, 9]), 0.5);

const changedWindows = featureRunId({
  transactionAsOf: "2026-09-17",
  sourceWindowStart: "2025-09-17",
  sourceWindowEnd: "2026-09-17",
  recentWindowStart: "2026-06-17",
  recentWindowEnd: "2026-09-17",
  previousWindowStart: "2026-03-17",
  previousWindowEnd: "2026-06-17",
  areaBand: "84",
  areaBandVersion: "REGIONAL_RANKING_AREA_BAND_V1",
  featureVersion: "region-feature-v1",
  cohortInputId: inputId,
});
assert.equal(changedWindows, normalized.featureRunId);
assert.notEqual(featureRunId({
  transactionAsOf: "2026-09-17",
  sourceWindowStart: "2025-09-17",
  sourceWindowEnd: "2026-09-17",
  recentWindowStart: "2026-06-17",
  recentWindowEnd: "2026-09-17",
  previousWindowStart: "2026-03-17",
  previousWindowEnd: "2026-06-17",
  areaBand: "84",
  areaBandVersion: "REGIONAL_RANKING_AREA_BAND_V1",
  featureVersion: "region-feature-v1",
  cohortInputId: "other",
}), normalized.featureRunId);

const band = activeAreaBand("84");
const windows = windowsFromAsOf("2026-09-17");
const sample = extractFeatures({
  band,
  windows,
  profile: {
    householdCount: 10,
    source: null,
    sourceKey: null,
    sourceAsOf: null,
    confidence: "HIGH",
  },
  deals: [{ dealDate: "2026-09-01", exclusiveArea: 84, dealAmount: 100 }],
});
assert.equal(evaluateEligibility({
  features: sample,
  transactionAsOf: "2026-09-17",
  identityStatus: null,
  config: null,
}).exclusionReason, "PRIVATE_CONFIG_ABSENT");

const slotConfig = loadPrivateConfig({
  ranking_version: "TEST_ONLY_SLOT",
  weights: { price: 0, liquidity: 1, turnover: 0, household_scale: 0, stability: 0, momentum: 0 },
  min_trade_count: 0,
  min_active_months: 0,
  max_recency_days: 100000,
  require_household_profile: true,
  identity_confidence_floor: null,
  price_top_tier_percentile_floor: 0.5,
  reliability: { high: 1, medium: 1, low: 1, missing: 1 },
  normalization_cap: 1,
});
assert.equal(slotConfig.ok, true);
if (!slotConfig.ok) throw new Error("slot");
const baseRow = normalized.rows[0]!;
function slotRow(id: string, trades: number, price: number): FeatureSnapshotRow {
  return {
    ...baseRow,
    complexId: id,
    lawdCd: "11710",
    bjdongCd: "10100",
    tradeCount: trades,
    medianPricePerSqm: price,
    householdCount: 100,
    turnover: trades / 100,
    activeMonthCount: 6,
    latestDealDate: "2026-09-01",
    profileConfidence: "HIGH",
    recent3mTradeCount: 1,
    previous3mTradeCount: 1,
  };
}
const slotRows = [
  slotRow("cx_a00000000000000a", 60, 1),
  slotRow("cx_b00000000000000b", 50, 90),
  slotRow("cx_c00000000000000c", 40, 80),
  slotRow("cx_d00000000000000d", 30, 70),
  slotRow("cx_e00000000000000e", 20, 60),
  slotRow("cx_f00000000000000f", 10, 50),
];
const slotted = scoreCohort({
  featureRunId: normalized.featureRunId,
  rows: slotRows,
  regionScope: "gu",
  regionCode: "11710",
  config: slotConfig.config,
  privateConfigFingerprint: slotConfig.fingerprint,
});
assert.equal(slotted.ok, true);
if (!slotted.ok) throw new Error("slotted");
assert.equal(slotted.baseEligible, 6);
assert.equal(slotted.rows.filter((row) => row.rank != null).length, 6);
assert.equal(slotted.rows.some((row) => row.exclusionReason === "PRICE_BELOW_TOP_TIER_FLOOR"), false);
const cheap = slotted.rows.find((row) => row.complexId === "cx_a00000000000000a");
assert.equal(cheap?.eligible, true);
assert.ok((cheap?.rank ?? 0) >= 6);
assert.equal(slotted.constrainedOrder.filter((row) => row.rank <= 5).length, slotted.topTierEligible);

const dongSlot = scoreCohort({
  featureRunId: normalized.featureRunId,
  rows: slotRows,
  regionScope: "dong",
  regionCode: "10100",
  config: slotConfig.config,
  privateConfigFingerprint: slotConfig.fingerprint,
});
assert.equal(dongSlot.ok, true);
if (!dongSlot.ok) throw new Error("dong slot");
assert.equal(dongSlot.priceGate, "NOT_EVALUATED_FOR_SMALL_COHORT");
assert.equal(dongSlot.rows.filter((row) => row.rank != null).length, 6);
assert.deepEqual(
  dongSlot.constrainedOrder.map((row) => row.rank),
  dongSlot.rawOrder.map((row) => row.rank),
);

const summary = {
  feature_run_id: normalized.featureRunId,
  gu_cohort: gu.cohortSize,
  dong_cohorts: dongCounts.size,
  dong_partition: dongSum,
  synthetic_scoring_executed: true,
  deterministic_rerun: gu.rankingRunId === gu2.rankingRunId,
  changed_config_new_ranking_run_id: gu.rankingRunId !== guAlt.rankingRunId,
  feature_run_id_unchanged: gu.featureRunId === guAlt.featureRunId,
  leaderboard_published: false,
};
console.log(JSON.stringify({ ok: true, ...summary }));
