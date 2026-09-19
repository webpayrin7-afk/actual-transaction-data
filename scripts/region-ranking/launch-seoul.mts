/**
 * Seoul 59/84/114 + ALL launch.
 * Private configs are file inputs. This script does not embed them and does not print them.
 *
 * Usage: npx tsx scripts/region-ranking/launch-seoul.mts <p1.json> <all-configs.json>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { SEOUL_REGIONS } from "../../src/lib/constants/regions-registry";
import { activeAreaBand, AREA_BAND_VERSION, type AreaBandDef } from "../../src/lib/region-ranking/area-band";
import { extractFeatures, type FeatureInputs } from "../../src/lib/region-ranking/features";
import { aggregateAll, classifyProductCoverage, type AllBandId, type AllPrivateConfig, type AllBandStrength } from "../../src/lib/region-ranking/all-aggregate";
import { householdFromTitleRows, type TitleRow } from "../../src/lib/region-ranking/ledger-household";
import { loadPrivateConfig, type RankingPrivateConfig } from "../../src/lib/region-ranking/private-config";
import { cohortInputId, featureRunId, rankingRunId, sha256Hex } from "../../src/lib/region-ranking/run-identity";
import { precheckAdditiveCreateSql } from "../../src/lib/region-ranking/migration-precheck";
import { percentileRank, priceGateMode, rankWithTopTierSlots, scoreCohort, type FeatureSnapshotRow } from "../../src/lib/region-ranking/score";
import { publishedComplexPosition, publishedRegionRanking } from "../../src/lib/region-ranking/query";
import { FEATURE_VERSION, windowsFromAsOf } from "../../src/lib/region-ranking/snapshot";

const P1_FINGERPRINT = "19ba3623e8187a35f763a0a44e6c37ba568c8322e5b6e5c82c761c9a632c7835";
const ALGORITHM_VERSION = "seoul-ranking-v2";
const PINNED_TARGET = "2026-09-17";
const LAWD = SEOUL_REGIONS.map((region) => region.lawdCodes[0]!);
if (LAWD.length !== 25) throw new Error("SEOUL_GU_COUNT");
const GU_NAME = new Map(SEOUL_REGIONS.map((region) => [region.lawdCodes[0]!, region.name]));
const BANDS = ["59", "84", "114"] as const;
const KAPT_PATH = process.env.KAPT_UNIVERSE_PATH ?? "/tmp/national-inputs/kapt-complex-universe.jsonl";
const CACHE_PATH = "/tmp/seoul-kapt-basis-cache.json";
const LEDGER_CACHE_PATH = "/tmp/seoul-ledger-cache.json";
const PUBLICATION_SQL = "src/lib/db/migrations/20260920_region_ranking_publications.sql";
const CALCULATED_AT = new Date().toISOString();

type BandId = (typeof BANDS)[number];

type Master = {
  complexId: string;
  name: string;
  lawd: string;
  bjdong: string;
  jibun: string;
  identityStatus: string | null;
};

type ProfileRes = {
  household: number | null;
  source: string | null;
  sourceKey: string | null;
  asOf: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING";
  conflict: boolean;
};

function must<T>(value: T | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

function loadAllConfigs(path: string): AllPrivateConfig[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) throw new Error("ALL_CONFIG_MALFORMED");
  return raw.map((row) => {
    const config = row as AllPrivateConfig;
    if (!config.rankingVersion || !config.method) throw new Error("ALL_CONFIG_MALFORMED");
    if (!["reliability_weighted_mean", "median", "balanced_mean"].includes(config.method)) {
      throw new Error("ALL_CONFIG_MALFORMED");
    }
    for (const key of ["tradeReliabilityScale", "monthReliabilityScale", "coverageAdjustment", "topTierSignalFloor"] as const) {
      if (typeof config[key] !== "number" || !Number.isFinite(config[key])) throw new Error("ALL_CONFIG_MALFORMED");
    }
    return config;
  });
}

function daysSince(dealDate: string, asOf: string): number {
  const a = Date.parse(`${dealDate.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function likelyWithoutHousehold(row: FeatureSnapshotRow, config: RankingPrivateConfig): boolean {
  if (row.tradeCount < config.minTradeCount) return false;
  if (row.activeMonthCount < config.minActiveMonths) return false;
  if (!row.latestDealDate) return false;
  if (daysSince(row.latestDealDate, row.transactionAsOf) > config.maxRecencyDays) return false;
  if (row.householdCount != null && config.identityConfidenceFloor) {
    const order = ["MISSING", "LOW", "MEDIUM", "HIGH"];
    if (order.indexOf(row.profileConfidence) < order.indexOf(config.identityConfidenceFloor)) return false;
  }
  return true;
}

function rankIssues(ranks: number[]): { duplicate: number; gaps: number } {
  const sorted = [...ranks].sort((a, b) => a - b);
  let duplicate = 0;
  let gaps = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) gaps += 1;
    if (i > 0 && sorted[i] === sorted[i - 1]) duplicate += 1;
  }
  return { duplicate, gaps };
}

function severeAnomaly(rows: FeatureSnapshotRow[], order: Array<{ complexId: string; rank: number }>): boolean {
  const eligible = order.map((item) => must(rows.find((row) => row.complexId === item.complexId), item.complexId));
  if (eligible.length < 5) return false;
  const byTrades = [...eligible].sort((a, b) => b.tradeCount - a.tradeCount || a.complexId.localeCompare(b.complexId));
  const top5 = order.filter((item) => item.rank <= 5).sort((a, b) => a.rank - b.rank).map((item) => item.complexId);
  const volumeTop = byTrades.slice(0, 5).map((row) => row.complexId);
  if (top5.every((id, index) => id === volumeTop[index])) return true;
  const households = eligible.map((row) => row.householdCount ?? 0).sort((a, b) => a - b);
  const p25 = households[Math.floor((households.length - 1) * 0.25)] ?? 0;
  const rank1 = eligible.find((row) => order.find((item) => item.complexId === row.complexId)?.rank === 1);
  if (!rank1 || rank1.householdCount == null) return false;
  const maxTurnover = Math.max(...eligible.map((row) => row.turnover ?? 0));
  const prices = eligible.map((row) => row.medianPricePerSqm ?? 0).sort((a, b) => a - b);
  const priceMedian = prices[Math.floor((prices.length - 1) * 0.5)] ?? 0;
  return rank1.householdCount <= p25 && (rank1.turnover ?? 0) === maxTurnover && (rank1.medianPricePerSqm ?? 0) < priceMedian;
}

function toSnapshot(master: Master, features: FeatureInputs, asOf: string, windows: ReturnType<typeof windowsFromAsOf>, band: AreaBandDef, profile: ProfileRes): FeatureSnapshotRow {
  return {
    complexId: master.complexId,
    lawdCd: master.lawd,
    bjdongCd: master.bjdong,
    areaBand: band.id,
    areaBandVersion: AREA_BAND_VERSION,
    period: "12M",
    transactionAsOf: asOf,
    sourceWindowStart: windows.base12m.startExclusive,
    sourceWindowEnd: windows.base12m.endInclusive,
    recentWindowStart: windows.recent3m.startExclusive,
    recentWindowEnd: windows.recent3m.endInclusive,
    previousWindowStart: windows.previous3m.startExclusive,
    previousWindowEnd: windows.previous3m.endInclusive,
    medianPricePerSqm: features.medianPricePerSqm,
    medianDealAmount: features.medianDealAmount,
    tradeCount: features.tradeCount,
    householdCount: features.householdCount,
    turnover: features.turnover,
    activeMonthCount: features.activeMonthCount,
    latestDealDate: features.latestDealDate,
    recent3mTradeCount: features.recent3mTradeCount,
    previous3mTradeCount: features.previous3mTradeCount,
    recent3mMedianPricePerSqm: features.recent3mMedianPricePerSqm,
    previous3mMedianPricePerSqm: features.previous3mMedianPricePerSqm,
    featureVersion: FEATURE_VERSION,
    profileSource: profile.source,
    profileConfidence: profile.confidence,
    identityStatus: master.identityStatus,
  };
}

async function main() {
  const p1Path = process.argv[2];
  const allPath = process.argv[3];
  if (!p1Path || !allPath) throw new Error("config paths required");
  const loaded = loadPrivateConfig(JSON.parse(readFileSync(p1Path, "utf8")));
  if (!loaded.ok || loaded.fingerprint !== P1_FINGERPRINT) {
    console.log(JSON.stringify({ status: "FINGERPRINT_MISMATCH" }));
    process.exit(2);
  }
  const allConfigs = loadAllConfigs(allPath);
  const config = loaded.config;
  const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  const maxRow = await db.execute({
    sql: `SELECT MAX(deal_date) AS m FROM transactions WHERE deal_type = 'trade' AND lawd_cd IN (${LAWD.map(() => "?").join(",")})`,
    args: LAWD,
  });
  const warehouseMax = String(maxRow.rows[0]!.m).slice(0, 10);
  const asOf = warehouseMax < PINNED_TARGET ? warehouseMax : PINNED_TARGET;
  const windows = windowsFromAsOf(asOf);
  const bandDefs = Object.fromEntries(BANDS.map((id) => [id, activeAreaBand(id)])) as Record<BandId, AreaBandDef>;

  const ambiguous = await db.execute({
    sql: `SELECT lawd_cd, apt_name_norm FROM apt_complex_master
          WHERE lawd_cd IN (${LAWD.map(() => "?").join(",")})
          GROUP BY lawd_cd, apt_name_norm HAVING COUNT(*) > 1`,
    args: LAWD,
  });
  const ambiguousKeys = new Set(ambiguous.rows.map((row) => `${row.lawd_cd}|${row.apt_name_norm}`));

  const masters = new Map<string, Master>();
  const deals = new Map<string, Array<{ dealDate: string; exclusiveArea: number; dealAmount: number }>>();
  for (const lawd of LAWD) {
    const rows = await db.execute({
      sql: `SELECT m.complex_id, m.apt_name_norm, m.lawd_cd, m.bjdong_cd, m.jibun, m.identity_status,
                   t.deal_date, t.exclusive_area, t.deal_amount
            FROM apt_complex_master m
            JOIN transactions t ON t.lawd_cd = m.lawd_cd AND t.apt_name_norm = m.apt_name_norm
            WHERE m.lawd_cd = ? AND t.deal_type = 'trade'
              AND t.deal_date > ? AND t.deal_date <= ?
              AND (
                (t.exclusive_area >= 55 AND t.exclusive_area <= 65)
                OR (t.exclusive_area >= 80 AND t.exclusive_area <= 90)
                OR (t.exclusive_area >= 110 AND t.exclusive_area <= 120)
              )`,
      args: [lawd, windows.base12m.startExclusive, windows.base12m.endInclusive],
    });
    for (const row of rows.rows) {
      const name = String(row.apt_name_norm);
      if (ambiguousKeys.has(`${lawd}|${name}`)) continue;
      if (row.bjdong_cd == null || String(row.bjdong_cd) === "") continue;
      const id = String(row.complex_id);
      if (!masters.has(id)) {
        masters.set(id, {
          complexId: id,
          name,
          lawd,
          bjdong: String(row.bjdong_cd),
          jibun: row.jibun == null ? "" : String(row.jibun),
          identityStatus: row.identity_status == null ? null : String(row.identity_status),
        });
      }
      const list = deals.get(id) ?? [];
      list.push({
        dealDate: String(row.deal_date),
        exclusiveArea: Number(row.exclusive_area),
        dealAmount: Number(row.deal_amount),
      });
      deals.set(id, list);
    }
    console.log(JSON.stringify({ stage: "deals", lawd, rows: rows.rows.length }));
  }

  const profiles = await loadProfiles(db, [...masters.keys()]);
  const profileBefore = Number((await db.execute("SELECT COUNT(*) AS c FROM apt_complex_profile")).rows[0]!.c);
  const resolved = await resolveHouseholds(db, masters, profiles);
  let built = buildBands(masters, deals, resolved, asOf, windows, bandDefs);
  const missingBefore = [...resolved.values()].filter((row) => row.household == null || row.household <= 0).length;
  const coverageBefore = coverageSnapshot(built, config);
  const ledger = await repairPriorityHouseholds(db, masters, resolved, built, config);
  if (ledger.newly_resolved > 0) built = buildBands(masters, deals, resolved, asOf, windows, bandDefs);
  const coverageAfter = coverageSnapshot(built, config);
  const profileWrites = await fillNullProfiles(db, resolved, profiles);
  const profileAfter = Number((await db.execute("SELECT COUNT(*) AS c FROM apt_complex_profile")).rows[0]!.c);
  if (!built.deterministic) {
    console.log(JSON.stringify({ status: "DETERMINISM_FAIL" }));
    process.exit(2);
  }

  const cellResults = [];
  const rankingRows: RankingInsert[] = [];
  const publications: PublicationInsert[] = [];
  const guScores = new Map<string, Map<BandId, Map<string, { score: number; pricePercentile: number; row: FeatureSnapshotRow }>>>();
  let dongBandCohorts = 0;
  let dongSmallCohorts = 0;
  let dongRejected = 0;

  for (const band of BANDS) {
    const rows = built.rows[band];
    const runId = built.runIds[band];
    for (const lawd of LAWD) {
      const cohort = rows.filter((row) => row.lawdCd === lawd);
      const scored = scoreCohort({
        featureRunId: runId,
        rows: cohort,
        regionScope: "gu",
        regionCode: lawd,
        config,
        privateConfigFingerprint: loaded.fingerprint,
        rankingVersion: ALGORITHM_VERSION,
      });
      if (!scored.ok) throw new Error("score failed");
      const likely = cohort.filter((row) => likelyWithoutHousehold(row, config));
      const likelyHit = likely.filter((row) => row.householdCount != null && row.householdCount > 0).length;
      const coverage = likely.length === 0 ? 1 : likelyHit / likely.length;
      const ranks = scored.constrainedOrder.map((item) => item.rank);
      const issues = rankIssues(ranks);
      const removed = scored.rows.filter((row) => row.eligible && row.rank == null).length;
      const anomaly = severeAnomaly(cohort, scored.constrainedOrder);
      let status = "PASS";
      if (coverage < 0.95) status = "HOLD_PROFILE_COVERAGE";
      else if (scored.constrainedOrder.length !== scored.baseEligible) status = "HOLD_RANK_COVERAGE";
      else if (issues.duplicate > 0) status = "HOLD_DUPLICATE_RANK";
      else if (issues.gaps > 0) status = "HOLD_RANK_GAP";
      else if (removed > 0) status = "HOLD_PRICE_GATE_REMOVAL";
      else if (anomaly) status = "HOLD_SANITY";
      cellResults.push({
        lawd,
        gu: GU_NAME.get(lawd),
        band,
        universe: cohort.length,
        likely: likely.length,
        likely_coverage: Number(coverage.toFixed(4)),
        base_eligible: scored.baseEligible,
        status,
      });
      const byComplex = new Map<string, { score: number; pricePercentile: number; row: FeatureSnapshotRow }>();
      const eligibleRows = cohort.filter((row) => scored.rows.find((item) => item.complexId === row.complexId)?.eligible);
      const priceValues = eligibleRows.map((row) => row.medianPricePerSqm ?? Number.NEGATIVE_INFINITY);
      for (const row of eligibleRows) {
        byComplex.set(row.complexId, {
          score: scored.strengthByComplex[row.complexId] ?? 0,
          pricePercentile: percentileRank(row.medianPricePerSqm ?? Number.NEGATIVE_INFINITY, priceValues),
          row,
        });
      }
      const lawdMap = guScores.get(lawd) ?? new Map();
      lawdMap.set(band, byComplex);
      guScores.set(lawd, lawdMap);
      if (status === "PASS") {
        publications.push({
          regionScope: "gu",
          regionCode: lawd,
          areaBand: band,
          rankingRunId: rankingRunId({
            featureRunId: runId,
            rankingVersion: ALGORITHM_VERSION,
            privateConfigFingerprint: loaded.fingerprint,
            regionScope: "gu",
            regionCode: lawd,
          }),
          featureRunId: runId,
          rankingVersion: ALGORITHM_VERSION,
          asOf,
        });
        pushRanking(rankingRows, scored, cohort, runId, loaded.fingerprint, config, "gu", lawd, band);
        const dongCodes = [...new Set(cohort.map((row) => row.bjdongCd))];
        for (const bjdong of dongCodes) {
          const members = cohort.filter((row) => row.bjdongCd === bjdong);
          dongBandCohorts += 1;
          if (members.length <= 6) dongSmallCohorts += 1;
          const dongCode = `${lawd}${bjdong}`;
          const dong = scoreCohort({
            featureRunId: runId,
            rows: members,
            regionScope: "dong",
            regionCode: bjdong,
            config,
            privateConfigFingerprint: loaded.fingerprint,
            rankingVersion: ALGORITHM_VERSION,
          });
          if (!dong.ok) continue;
          const dongIssues = rankIssues(dong.constrainedOrder.map((item) => item.rank));
          if (
            dongIssues.duplicate > 0
            || dongIssues.gaps > 0
            || dong.constrainedOrder.length !== dong.baseEligible
          ) {
            dongRejected += 1;
            continue;
          }
          publications.push({
            regionScope: "dong",
            regionCode: dongCode,
            areaBand: band,
            rankingRunId: rankingRunId({
              featureRunId: runId,
              rankingVersion: ALGORITHM_VERSION,
              privateConfigFingerprint: loaded.fingerprint,
              regionScope: "dong",
              regionCode: dongCode,
            }),
            featureRunId: runId,
            rankingVersion: ALGORITHM_VERSION,
            asOf,
          });
          pushRanking(rankingRows, dong, members, runId, loaded.fingerprint, config, "dong", dongCode, band);
        }
      }
    }
  }

  const expected = await loadExpectedBands(db, masters, bandDefs);
  const selected = selectAll(allConfigs);
  const allRun = rankingRunId({
    featureRunId: built.allFeatureRunId,
    rankingVersion: ALGORITHM_VERSION,
    privateConfigFingerprint: selected.fingerprint,
    regionScope: "gu",
    regionCode: "11",
  });
  const allCells = [];
  const allCoverage = { 3: 0, 2: 0, 1: 0, excluded: 0 };
  const productCoverage = { single_product: 0, partial: 0, unknown: 0, complete: 0 };
  let allDongCohorts = 0;
  let allSmallCohorts = 0;
  for (const lawd of LAWD) {
    const items = allItemsForGu(lawd, guScores, selected.config, expected);
    const universeIds = new Set<string>();
    for (const band of BANDS) {
      for (const row of built.rows[band]) {
        if (row.lawdCd === lawd) universeIds.add(row.complexId);
      }
    }
    const scoredIds = new Set(items.map((item) => item.complexId));
    allCoverage.excluded += [...universeIds].filter((id) => !scoredIds.has(id)).length;
    allCoverage[3] += items.filter((item) => item.coverage === 3).length;
    allCoverage[2] += items.filter((item) => item.coverage === 2).length;
    allCoverage[1] += items.filter((item) => item.coverage === 1).length;
    productCoverage.single_product += items.filter((item) => item.singleProductBand).length;
    productCoverage.partial += items.filter((item) => item.coverageStatus === "PARTIAL_PRODUCT_COVERAGE").length;
    productCoverage.unknown += items.filter((item) => item.coverageStatus === "EXPECTED_BAND_UNKNOWN").length;
    productCoverage.complete += items.filter((item) => item.coverageStatus === "COMPLETE_PRODUCT_COVERAGE").length;
    const partialInTop = items.filter((item) => item.rank != null && item.rank <= 5 && item.coverageStatus === "PARTIAL_PRODUCT_COVERAGE").length;
    const topCount = items.filter((item) => item.rank != null && item.rank <= 5).length;
    const ranks = items.filter((item) => item.rank != null).map((item) => item.rank!);
    const issues = rankIssues(ranks);
    let status = "PASS";
    if (items.length === 0) status = "HOLD_ALL_EMPTY";
    else if (issues.duplicate > 0 || issues.gaps > 0) status = "HOLD_ALL_RANK_GAP";
    else if (topCount > 0 && partialInTop / topCount > 0.6) status = "HOLD_ALL_PARTIAL_DATA";
    allCells.push({ lawd, gu: GU_NAME.get(lawd), status, eligible: items.length, partial_in_top5: partialInTop });
    if (status !== "PASS") continue;
    publications.push({
      regionScope: "gu",
      regionCode: lawd,
      areaBand: "ALL",
      rankingRunId: allRun,
      featureRunId: built.allFeatureRunId,
      rankingVersion: ALGORITHM_VERSION,
      asOf,
    });
    for (const item of items) {
      rankingRows.push(allRow(allRun, built.allFeatureRunId, ALGORITHM_VERSION, asOf, "gu", lawd, item));
    }
    const byDong = new Map<string, typeof items>();
    for (const item of items) {
      const list = byDong.get(item.bjdong) ?? [];
      list.push(item);
      byDong.set(item.bjdong, list);
    }
    for (const [bjdong, members] of byDong) {
      allDongCohorts += 1;
      if (members.length <= 6) allSmallCohorts += 1;
      const mode = priceGateMode("dong", members.length);
      const ranked = rankWithTopTierSlots(
        members.map((item) => ({ id: item.complexId, score: item.score, topTier: mode === "NOT_EVALUATED_FOR_SMALL_COHORT" ? false : item.topTier, tieBreak: item.tieBreak })),
        mode,
      );
      const rankById = new Map(ranked.map((item) => [item.id, item.rank]));
      const dongIssues = rankIssues(ranked.map((item) => item.rank));
      if (dongIssues.duplicate > 0 || dongIssues.gaps > 0 || ranked.length !== members.length) {
        dongRejected += 1;
        continue;
      }
      const dongCode = `${lawd}${bjdong}`;
      publications.push({
        regionScope: "dong",
        regionCode: dongCode,
        areaBand: "ALL",
        rankingRunId: allRun,
        featureRunId: built.allFeatureRunId,
        rankingVersion: ALGORITHM_VERSION,
        asOf,
      });
      for (const item of members) {
        rankingRows.push(allRow(allRun, built.allFeatureRunId, ALGORITHM_VERSION, asOf, "dong", dongCode, {
          ...item,
          rank: rankById.get(item.complexId) ?? null,
          regionTotal: members.length,
        }));
      }
    }
  }

  console.log(JSON.stringify({ stage: "write", features: built.universe, rankings: rankingRows.length, publications: publications.length }));
  await ensurePublicationTable(db);
  const featureInserted = await writeFeatures(db, built, asOf);
  const rankingInserted = await writeRankings(db, rankingRows);
  const publicationInserted = await writePublications(db, publications);
  const featureCount = await db.execute("SELECT COUNT(*) AS c FROM ranking_feature_snapshots");
  const rankingCount = await db.execute("SELECT COUNT(*) AS c FROM region_complex_rankings");
  const publicationCount = await db.execute("SELECT COUNT(*) AS c FROM region_ranking_publications");
  await writeFeatures(db, built, asOf);
  await writeRankings(db, rankingRows);
  await writePublications(db, publications);
  const featureCount2 = await db.execute("SELECT COUNT(*) AS c FROM ranking_feature_snapshots");
  const rankingCount2 = await db.execute("SELECT COUNT(*) AS c FROM region_complex_rankings");
  const publicationCount2 = await db.execute("SELECT COUNT(*) AS c FROM region_ranking_publications");

  const manifest = {
    transaction_as_of: asOf,
    warehouse_max_deal_date: warehouseMax,
    area_band_version: AREA_BAND_VERSION,
    bands: {
      59: bandDefs["59"],
      84: bandDefs["84"],
      114: bandDefs["114"],
    },
    feature_run_id: built.runIds,
    all_feature_run_id: built.allFeatureRunId,
    ranking_version: ALGORITHM_VERSION,
    p1_fingerprint: loaded.fingerprint,
    all_ranking_version: ALGORITHM_VERSION,
    all_fingerprint: selected.fingerprint,
    all_ranking_run_id: allRun,
    all_selection: selected.reason,
    ambiguous_name_groups: ambiguous.rows.length,
    universe: built.universe,
    profile_writes: profileWrites,
    profile_count_before: profileBefore,
    profile_count_after: profileAfter,
    profile_resolved: [...resolved.values()].filter((row) => row.household != null && row.household > 0).length,
    profile_missing_before: missingBefore,
    profile_missing: [...resolved.values()].filter((row) => row.household == null || row.household <= 0).length,
    household_newly_resolved: ledger.newly_resolved,
    household_attempted: ledger.attempted,
    household_conflicts: ledger.conflicts,
    coverage_before: summarizeCoverage(coverageBefore),
    coverage_after: summarizeCoverage(coverageAfter),
    conflicts: [...resolved.values()].filter((row) => row.conflict).length,
    dong_band_cohorts: dongBandCohorts,
    dong_small_cohorts: dongSmallCohorts,
    all_dong_cohorts: allDongCohorts,
    dong_rejected: dongRejected,
    product_coverage: productCoverage,
    publication_rows: publications.length,
    cells: cellResults,
    all_cells: allCells,
    all_coverage: allCoverage,
    comparison: selected.comparison,
    counts: {
      feature_before_rerun: Number(featureCount.rows[0]!.c),
      feature_after_rerun: Number(featureCount2.rows[0]!.c),
      ranking_before_rerun: Number(rankingCount.rows[0]!.c),
      ranking_after_rerun: Number(rankingCount2.rows[0]!.c),
      publication_before_rerun: Number(publicationCount.rows[0]!.c),
      publication_after_rerun: Number(publicationCount2.rows[0]!.c),
      feature_inserted_attempt: featureInserted,
      ranking_inserted_attempt: rankingInserted,
      publication_inserted_attempt: publicationInserted,
    },
    production_write: true,
  };
  writeFileSync("data/poc/region-ranking/seoul-launch-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({
    status: "WROTE",
    as_of: asOf,
    universe: built.universe,
    feature_runs: built.runIds,
    all_feature_run: built.allFeatureRunId,
    cells_pass: cellResults.filter((row) => row.status === "PASS").length,
    cells_hold: cellResults.filter((row) => row.status !== "PASS").length,
    all_pass: allCells.filter((row) => row.status === "PASS").length,
    all_version: ALGORITHM_VERSION,
    feature_rows: manifest.counts.feature_after_rerun,
    ranking_rows: manifest.counts.ranking_after_rerun,
    idempotent: manifest.counts.feature_before_rerun === manifest.counts.feature_after_rerun
      && manifest.counts.ranking_before_rerun === manifest.counts.ranking_after_rerun
      && manifest.counts.publication_before_rerun === manifest.counts.publication_after_rerun,
    profile_resolved: manifest.profile_resolved,
    profile_missing: manifest.profile_missing,
    conflicts: manifest.conflicts,
    profile_writes: profileWrites,
  }));
  await postValidate(db, built, allRun);
  db.close();
}

type Built = {
  deterministic: boolean;
  rows: Record<BandId, FeatureSnapshotRow[]>;
  runIds: Record<BandId, string>;
  allFeatureRunId: string;
  universe: Record<BandId, number>;
};

function buildBands(
  masters: Map<string, Master>,
  deals: Map<string, Array<{ dealDate: string; exclusiveArea: number; dealAmount: number }>>,
  profiles: Map<string, ProfileRes>,
  asOf: string,
  windows: ReturnType<typeof windowsFromAsOf>,
  bandDefs: Record<BandId, AreaBandDef>,
): Built {
  const rows = {} as Record<BandId, FeatureSnapshotRow[]>;
  const runIds = {} as Record<BandId, string>;
  const universe = {} as Record<BandId, number>;
  let deterministic = true;
  for (const band of BANDS) {
    const members: FeatureSnapshotRow[] = [];
    for (const master of [...masters.values()].sort((a, b) => a.complexId.localeCompare(b.complexId))) {
      const profile = must(profiles.get(master.complexId), master.complexId);
      const once = extractFeatures({
        deals: deals.get(master.complexId) ?? [],
        band: bandDefs[band],
        windows,
        profile: {
          householdCount: profile.household,
          source: profile.source,
          sourceKey: profile.sourceKey,
          sourceAsOf: profile.asOf,
          confidence: profile.confidence,
        },
      });
      const twice = extractFeatures({
        deals: deals.get(master.complexId) ?? [],
        band: bandDefs[band],
        windows,
        profile: {
          householdCount: profile.household,
          source: profile.source,
          sourceKey: profile.sourceKey,
          sourceAsOf: profile.asOf,
          confidence: profile.confidence,
        },
      });
      if (JSON.stringify(once) !== JSON.stringify(twice)) deterministic = false;
      if (once.tradeCount < 1) continue;
      members.push(toSnapshot(master, once, asOf, windows, bandDefs[band], profile));
    }
    const inputId = cohortInputId(members.map((row) => ({
      complexId: row.complexId,
      householdCount: row.householdCount,
      profileConfidence: row.profileConfidence,
      cohortOrigin: "SEOUL_FULL_LAUNCH",
    })));
    runIds[band] = featureRunId({
      transactionAsOf: asOf,
      sourceWindowStart: windows.base12m.startExclusive,
      sourceWindowEnd: windows.base12m.endInclusive,
      recentWindowStart: windows.recent3m.startExclusive,
      recentWindowEnd: windows.recent3m.endInclusive,
      previousWindowStart: windows.previous3m.startExclusive,
      previousWindowEnd: windows.previous3m.endInclusive,
      areaBand: band,
      areaBandVersion: AREA_BAND_VERSION,
      featureVersion: FEATURE_VERSION,
      cohortInputId: inputId,
    });
    rows[band] = members;
    universe[band] = members.length;
  }
  const allFeatureRunId = sha256Hex(JSON.stringify({
    kind: "band-aggregate",
    "59": runIds["59"],
    "84": runIds["84"],
    "114": runIds["114"],
  }));
  return { deterministic, rows, runIds, allFeatureRunId, universe };
}

async function loadProfiles(db: Client, ids: string[]) {
  const out = new Map<string, { household: number | null; source: string | null; updatedAt: string | null }>();
  for (let i = 0; i < ids.length; i += 80) {
    const slice = ids.slice(i, i + 80);
    const result = await db.execute({
      sql: `SELECT complex_id, household_count, source, updated_at FROM apt_complex_profile WHERE complex_id IN (${slice.map(() => "?").join(",")})`,
      args: slice,
    });
    for (const row of result.rows) {
      const household = row.household_count == null ? null : Number(row.household_count);
      out.set(String(row.complex_id), {
        household: household != null && household > 0 ? household : null,
        source: row.source == null ? null : String(row.source),
        updatedAt: row.updated_at == null ? null : String(row.updated_at),
      });
    }
  }
  return out;
}

function artifactHouseholds(): Map<string, ProfileRes> {
  const out = new Map<string, ProfileRes>();
  const files = [
    "data/poc/region-ranking/songpa-full-84-profile-resolution.json",
    "data/poc/region-ranking/nowon-cross-region-backtest-cohort.json",
  ];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const doc = JSON.parse(readFileSync(file, "utf8")) as { rows: Array<Record<string, unknown>> };
    for (const row of doc.rows) {
      const household = row.household_count == null ? null : Number(row.household_count);
      if (household == null || household <= 0) continue;
      const confidence = String(row.profile_confidence ?? "MEDIUM");
      out.set(String(row.complex_id), {
        household,
        source: row.profile_source == null ? "verified_cache" : String(row.profile_source),
        sourceKey: row.profile_source_key == null ? null : String(row.profile_source_key),
        asOf: row.profile_as_of == null ? null : String(row.profile_as_of),
        confidence: confidence === "HIGH" || confidence === "LOW" || confidence === "MISSING" ? confidence : "MEDIUM",
        conflict: false,
      });
    }
  }
  return out;
}

async function resolveHouseholds(
  db: Client,
  masters: Map<string, Master>,
  production: Map<string, { household: number | null; source: string | null; updatedAt: string | null }>,
): Promise<Map<string, ProfileRes>> {
  const cache = await officialHouseholds(db, masters);
  const artifacts = artifactHouseholds();
  const out = new Map<string, ProfileRes>();
  for (const master of masters.values()) {
    const prod = production.get(master.complexId);
    const official = cache.get(master.complexId);
    const cached = artifacts.get(master.complexId);
    if (prod?.household) {
      out.set(master.complexId, {
        household: prod.household,
        source: prod.source,
        sourceKey: official?.sourceKey ?? cached?.sourceKey ?? null,
        asOf: prod.updatedAt?.slice(0, 10) ?? null,
        confidence: prod.source === "kapt_basis_v5" ? "HIGH" : "MEDIUM",
        conflict: official?.household != null && official.household !== prod.household,
      });
      continue;
    }
    if (official?.household) {
      out.set(master.complexId, official);
      continue;
    }
    if (cached?.household) {
      out.set(master.complexId, cached);
      continue;
    }
    out.set(master.complexId, {
      household: null,
      source: null,
      sourceKey: null,
      asOf: null,
      confidence: "MISSING",
      conflict: false,
    });
  }
  return out;
}

async function officialHouseholds(db: Client, masters: Map<string, Master>): Promise<Map<string, ProfileRes>> {
  const ids = [...masters.keys()];
  const links = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 80) {
    const slice = ids.slice(i, i + 80);
    const result = await db.execute({
      sql: `SELECT complex_id, source_key FROM apt_complex_source_links
            WHERE source = 'KAPT' AND complex_id IN (${slice.map(() => "?").join(",")})`,
      args: slice,
    });
    for (const row of result.rows) links.set(String(row.complex_id), String(row.source_key));
  }
  const joined = matchKapt(masters, links);
  const cache: Record<string, { household: number | null; field: string | null }> = existsSync(CACHE_PATH)
    ? JSON.parse(readFileSync(CACHE_PATH, "utf8"))
    : {};
  const key = process.env.MOLIT_API_KEY?.trim();
  const missing = [...new Set([...joined.values()].map((row) => row.kapt))].filter((code) => cache[code] == null);
  console.log(JSON.stringify({ stage: "kapt_plan", missing: missing.length, cached: Object.keys(cache).length, joined: joined.size }));
  if (key && missing.length) {
    let cursor = 0;
    async function worker() {
      while (cursor < missing.length) {
        const code = missing[cursor++]!;
        const url = `https://apis.data.go.kr/1613000/AptBasisInfoServiceV5/getAphusBassInfoV5?serviceKey=${key}&kaptCode=${code}`;
        let stored = false;
        for (let attempt = 0; attempt < 8 && !stored; attempt++) {
          try {
            await new Promise((resolve) => setTimeout(resolve, 180));
            const res = await fetch(url, { headers: { Accept: "application/json" }, redirect: "follow" });
            if (res.status === 429 || res.status >= 500) {
              await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
              continue;
            }
            const text = await res.text();
            const parsed = JSON.parse(text) as { response?: { header?: { resultCode?: string }; body?: { item?: Record<string, unknown> | Array<Record<string, unknown>> } } };
            const resultCode = String(parsed?.response?.header?.resultCode ?? "");
            const rawItem = parsed?.response?.body?.item;
            const item = Array.isArray(rawItem) ? rawItem[0] : rawItem;
            if (resultCode !== "00" || item == null) {
              await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
              continue;
            }
            const kaptda = officialCount(item.kaptdaCnt);
            const ho = officialCount(item.hoCnt);
            if (kaptda != null) cache[code] = { household: kaptda, field: "kaptdaCnt" };
            else if (ho != null) cache[code] = { household: ho, field: "hoCnt" };
            else cache[code] = { household: null, field: null };
            stored = true;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
          }
        }
        if (cursor % 40 === 0) {
          writeFileSync(CACHE_PATH, JSON.stringify(cache));
          console.log(JSON.stringify({ stage: "kapt", done: cursor, total: missing.length, stored: Object.keys(cache).length }));
        }
      }
    }
    await Promise.all([worker(), worker()]);
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
    const unresolved = missing.filter((code) => cache[code] == null).length;
    console.log(JSON.stringify({ stage: "kapt_done", unresolved, cached: Object.keys(cache).length }));
  }
  const shared = new Map<string, number>();
  for (const row of joined.values()) shared.set(row.kapt, (shared.get(row.kapt) ?? 0) + 1);
  const out = new Map<string, ProfileRes>();
  for (const [complexId, row] of joined) {
    if ((shared.get(row.kapt) ?? 0) > 1) continue;
    if (row.combined) continue;
    const got = cache[row.kapt];
    if (!got?.household) continue;
    out.set(complexId, {
      household: got.household,
      source: "AptBasisInfoServiceV5",
      sourceKey: row.kapt,
      asOf: "2026-09-19",
      confidence: got.field === "kaptdaCnt" ? "HIGH" : "MEDIUM",
      conflict: false,
    });
  }
  return out;
}

function parcelLots(address: string): string[] {
  const lots: string[] = [];
  // "성수동2가 830" must yield 830, not the 2 inside the dong name.
  const re = /(?:동[0-9]*가|동|리)\s+([0-9]+(?:-[0-9]+)?)/g;
  for (const match of address.matchAll(re)) {
    if (match[1]) lots.push(match[1]);
  }
  return lots;
}

function officialCount(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}

function matchKapt(masters: Map<string, Master>, links: Map<string, string>) {
  const nameIndex = new Map<string, Set<string>>();
  const lotIndex = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  if (existsSync(KAPT_PATH)) {
    for (const line of readFileSync(KAPT_PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { lawd_cd?: string; bjdong_code?: string; apt_name?: string; kapt_code?: string; parcel_address?: string };
      if (!row.lawd_cd || !LAWD.includes(row.lawd_cd) || !row.kapt_code) continue;
      names.set(row.kapt_code, row.apt_name ?? "");
      const key = `${row.lawd_cd}|${row.bjdong_code}|${(row.apt_name ?? "").replace(/\s+/g, "").replace(/아파트$/, "")}`;
      const set = nameIndex.get(key) ?? new Set();
      set.add(row.kapt_code);
      nameIndex.set(key, set);
      for (const lot of parcelLots(String(row.parcel_address ?? ""))) {
        const lotKey = `${row.lawd_cd}|${row.bjdong_code}|${lot}`;
        const lots = lotIndex.get(lotKey) ?? new Set();
        lots.add(row.kapt_code);
        lotIndex.set(lotKey, lots);
      }
    }
  }
  const out = new Map<string, { kapt: string; combined: boolean }>();
  for (const master of masters.values()) {
    const link = links.get(master.complexId);
    if (link) {
      out.set(master.complexId, { kapt: link, combined: false });
      continue;
    }
    const norm = master.name.replace(/\s+/g, "").replace(/아파트$/, "");
    const named = nameIndex.get(`${master.lawd}|${master.bjdong}|${norm}`);
    const parcelCode = lookupParcel(lotIndex, master.lawd, master.bjdong, master.jibun);
    let code: string | null = null;
    if (named && named.size === 1 && parcelCode && [...named][0] === parcelCode) code = parcelCode;
    else if (parcelCode) code = parcelCode;
    else if (named && named.size === 1) code = [...named][0]!;
    if (!code) continue;
    const official = (names.get(code) ?? "").replace(/\s+/g, "");
    const combined = ((official.includes("1차") && official.includes("2차")) || official.includes("1,2"))
      && !((norm.includes("1차") && norm.includes("2차")) || norm.includes("1,2"));
    out.set(master.complexId, { kapt: code, combined });
  }
  return out;
}

async function fillNullProfiles(
  db: Client,
  resolved: Map<string, ProfileRes>,
  production: Map<string, { household: number | null; source: string | null; updatedAt: string | null }>,
) {
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  for (const [complexId, profile] of resolved) {
    if (!profile.household || profile.conflict) continue;
    const existing = production.get(complexId);
    if (existing?.household) continue;
    if (!existing) {
      statements.push({
        sql: `INSERT INTO apt_complex_profile
              (complex_id, household_count, source, source_version, raw_meta_json, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [complexId, profile.household, profile.source ?? "AptBasisInfoServiceV5", "seoul-ranking-launch", JSON.stringify({ source_key: profile.sourceKey }), CALCULATED_AT],
      });
    } else {
      statements.push({
        sql: `UPDATE apt_complex_profile
              SET household_count = ?, source = ?, source_version = ?, updated_at = ?
              WHERE complex_id = ? AND (household_count IS NULL OR household_count <= 0)`,
        args: [profile.household, profile.source ?? "AptBasisInfoServiceV5", "seoul-ranking-launch", CALCULATED_AT, complexId],
      });
    }
  }
  await runBatches(db, statements, "profile");
  return statements.length;
}

type Stmt = { sql: string; args: Array<string | number | null> };

async function runBatches(db: Client, statements: Stmt[], stage: string) {
  const size = 40;
  for (let i = 0; i < statements.length; i += size) {
    const slice = statements.slice(i, i + size);
    await db.batch(slice, "write");
    const done = Math.min(i + size, statements.length);
    if (done === statements.length || done % 800 === 0) {
      console.log(JSON.stringify({ stage, done, total: statements.length }));
    }
  }
}

type RankingInsert = {
  rankingRunId: string;
  regionScope: "gu" | "dong";
  regionCode: string;
  complexId: string;
  areaBand: string;
  featureRunId: string;
  rank: number | null;
  regionTotal: number;
  confidence: string;
  eligible: number;
  exclusion: string | null;
  rankingVersion: string;
  asOf: string;
  metrics: string;
};

function pushRanking(
  target: RankingInsert[],
  scored: Extract<ReturnType<typeof scoreCohort>, { ok: true }>,
  cohort: FeatureSnapshotRow[],
  featureRunIdValue: string,
  fingerprint: string,
  config: RankingPrivateConfig,
  scope: "gu" | "dong",
  regionCode: string,
  band: string,
) {
  const runId = rankingRunId({
    featureRunId: featureRunIdValue,
    rankingVersion: ALGORITHM_VERSION,
    privateConfigFingerprint: fingerprint,
    regionScope: scope,
    regionCode,
  });
  const byId = new Map(cohort.map((row) => [row.complexId, row]));
  for (const row of scored.rows) {
    const feat = byId.get(row.complexId);
    target.push({
      rankingRunId: runId,
      regionScope: scope,
      regionCode,
      complexId: row.complexId,
      areaBand: band,
      featureRunId: featureRunIdValue,
      rank: row.rank,
      regionTotal: row.regionTotal,
      confidence: row.confidenceBucket,
      eligible: row.eligible ? 1 : 0,
      exclusion: row.exclusionReason,
      rankingVersion: ALGORITHM_VERSION,
      asOf: row.transactionAsOf,
      metrics: JSON.stringify({
        median_price_per_sqm: feat?.medianPricePerSqm ?? null,
        median_deal_amount: feat?.medianDealAmount ?? null,
        trade_count: feat?.tradeCount ?? 0,
        latest_deal_date: feat?.latestDealDate ?? null,
      }),
    });
  }
}

function selectAll(configs: AllPrivateConfig[]) {
  const config = configs.find((row) => row.method === "reliability_weighted_mean");
  if (!config) throw new Error("ALL_CONFIG_MALFORMED");
  return {
    config,
    fingerprint: sha256Hex(JSON.stringify(config)),
    reason: "retained reliability-weighted mean",
    comparison: [] as Array<{ pair: string; mean_top5: number; mean_top10: number }>,
  };
}

function allItemsForGu(
  lawd: string,
  guScores: Map<string, Map<BandId, Map<string, { score: number; pricePercentile: number; row: FeatureSnapshotRow }>>>,
  config: AllPrivateConfig,
  expected: Map<string, BandId[]>,
) {
  const bands = guScores.get(lawd);
  const ids = new Set<string>();
  for (const band of BANDS) for (const id of bands?.get(band)?.keys() ?? []) ids.add(id);
  const items = [];
  for (const complexId of ids) {
    const strengths: AllBandStrength[] = [];
    let bjdong = "";
    let tieBreak = 0;
    let confidence = "MISSING";
    for (const band of BANDS) {
      const got = bands?.get(band)?.get(complexId);
      if (!got) continue;
      bjdong = got.row.bjdongCd;
      tieBreak = Math.max(tieBreak, got.row.tradeCount);
      confidence = got.row.profileConfidence;
      strengths.push({
        band: band as AllBandId,
        score: got.score,
        tradeCount: got.row.tradeCount,
        activeMonthCount: got.row.activeMonthCount,
        pricePercentile: got.pricePercentile,
      });
    }
    const expectedBands = expected.get(complexId) ?? null;
    const usable = expectedBands == null
      ? strengths
      : strengths.filter((band) => expectedBands.includes(band.band));
    const aggregate = aggregateAll(usable, config);
    if (!aggregate) continue;
    const product = classifyProductCoverage(
      usable.map((band) => band.band),
      expectedBands,
    );
    items.push({
      complexId,
      bjdong,
      score: aggregate.score,
      topTier: aggregate.topTier,
      tieBreak,
      coverage: aggregate.coverage,
      coverageClass: aggregate.coverageClass,
      confidence,
      rank: null as number | null,
      regionTotal: 0,
      ...product,
    });
  }
  const mode = priceGateMode("gu", items.length);
  const ranked = rankWithTopTierSlots(items.map((item) => ({
    id: item.complexId,
    score: item.score,
    topTier: item.topTier,
    tieBreak: item.tieBreak,
  })), mode);
  const rankById = new Map(ranked.map((item) => [item.id, item.rank]));
  for (const item of items) {
    item.rank = rankById.get(item.complexId) ?? null;
    item.regionTotal = items.length;
  }
  return items;
}

function allRow(
  rankingRunIdValue: string,
  featureRunIdValue: string,
  rankingVersion: string,
  asOf: string,
  scope: "gu" | "dong",
  regionCode: string,
  item: ReturnType<typeof allItemsForGu>[number],
): RankingInsert {
  return {
    rankingRunId: rankingRunIdValue,
    regionScope: scope,
    regionCode,
    complexId: item.complexId,
    areaBand: "ALL",
    featureRunId: featureRunIdValue,
    rank: item.rank,
    regionTotal: item.regionTotal,
    confidence: item.coverageStatus === "PARTIAL_PRODUCT_COVERAGE" ? "DATA_COVERAGE_INCOMPLETE" : item.confidence,
    eligible: 1,
    exclusion: null,
    rankingVersion,
    asOf,
    metrics: JSON.stringify({
      expected_band_count: item.expectedBandCount,
      valid_band_count: item.validBandCount,
      expected_bands: item.expectedBands == null ? null : item.expectedBands.join(","),
      valid_bands: item.validBands.join(","),
      coverage_completeness: item.coverageCompleteness,
      coverage_status: item.coverageStatus,
      single_product_band: item.singleProductBand,
    }),
  };
}

async function writeFeatures(db: Client, built: Built, asOf: string) {
  const statements: Stmt[] = [];
  for (const band of BANDS) {
    for (const row of built.rows[band]) {
      statements.push({
        sql: `INSERT INTO ranking_feature_snapshots (
          feature_run_id, complex_id, lawd_cd, bjdong_cd, area_band, area_band_version, period,
          transaction_as_of, source_window_start, source_window_end, recent_window_start, recent_window_end,
          previous_window_start, previous_window_end, median_price_per_sqm, median_deal_amount, trade_count,
          household_count, turnover, active_month_count, latest_deal_date, recent_3m_trade_count, previous_3m_trade_count,
          recent_3m_median_price_per_sqm, previous_3m_median_price_per_sqm, feature_version, profile_source,
          profile_confidence, eligible_input, exclusion_reason, calculated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(feature_run_id, complex_id, area_band, period) DO NOTHING`,
        args: [
          built.runIds[band], row.complexId, row.lawdCd, row.bjdongCd, band, AREA_BAND_VERSION, "12M",
          asOf, row.sourceWindowStart, row.sourceWindowEnd, row.recentWindowStart, row.recentWindowEnd,
          row.previousWindowStart, row.previousWindowEnd, row.medianPricePerSqm, row.medianDealAmount, row.tradeCount,
          row.householdCount, row.turnover, row.activeMonthCount, row.latestDealDate, row.recent3mTradeCount, row.previous3mTradeCount,
          row.recent3mMedianPricePerSqm, row.previous3mMedianPricePerSqm, FEATURE_VERSION, row.profileSource,
          row.profileConfidence, row.householdCount != null && row.householdCount > 0 ? 1 : 0,
          row.householdCount != null && row.householdCount > 0 ? null : "HOUSEHOLD_PROFILE_MISSING",
          CALCULATED_AT,
        ],
      });
    }
  }
  await runBatches(db, statements, "features");
  return statements.length;
}

async function writeRankings(db: Client, rows: RankingInsert[]) {
  const statements: Stmt[] = rows.map((row) => ({
    sql: `INSERT INTO region_complex_rankings (
      ranking_run_id, region_scope, region_code, complex_id, area_band, period, feature_run_id,
      "rank", region_total, confidence_bucket, eligible, exclusion_reason, ranking_version,
      transaction_as_of, calculated_at, public_display_metrics_json
    ) VALUES (?, ?, ?, ?, ?, '12M', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ranking_run_id, region_scope, region_code, complex_id, area_band, period) DO UPDATE SET
      "rank" = excluded."rank",
      region_total = excluded.region_total,
      confidence_bucket = excluded.confidence_bucket,
      eligible = excluded.eligible,
      exclusion_reason = excluded.exclusion_reason,
      public_display_metrics_json = excluded.public_display_metrics_json,
      calculated_at = excluded.calculated_at`,
    args: [
      row.rankingRunId, row.regionScope, row.regionCode, row.complexId, row.areaBand, row.featureRunId,
      row.rank, row.regionTotal, row.confidence, row.eligible, row.exclusion, row.rankingVersion,
      row.asOf, CALCULATED_AT, row.metrics,
    ],
  }));
  await runBatches(db, statements, "rankings");
  return statements.length;
}

type PublicationInsert = {
  regionScope: "gu" | "dong";
  regionCode: string;
  areaBand: string;
  rankingRunId: string;
  featureRunId: string;
  rankingVersion: string;
  asOf: string;
};

type CoverageCell = { lawd: string; band: BandId; pass: boolean; coverage: number };

function coverageSnapshot(built: Built, config: RankingPrivateConfig): CoverageCell[] {
  const cells: CoverageCell[] = [];
  for (const band of BANDS) {
    for (const lawd of LAWD) {
      const cohort = built.rows[band].filter((row) => row.lawdCd === lawd);
      const likely = cohort.filter((row) => likelyWithoutHousehold(row, config));
      const hit = likely.filter((row) => row.householdCount != null && row.householdCount > 0).length;
      const coverage = likely.length === 0 ? 1 : hit / likely.length;
      cells.push({ lawd, band, pass: coverage >= 0.95, coverage });
    }
  }
  return cells;
}

function summarizeCoverage(cells: CoverageCell[]) {
  const out: Record<string, { pass: number; hold: number }> = {};
  for (const band of BANDS) {
    const rows = cells.filter((cell) => cell.band === band);
    out[band] = {
      pass: rows.filter((cell) => cell.pass).length,
      hold: rows.filter((cell) => !cell.pass).length,
    };
  }
  return out;
}

function bandsForSpan(min: number, max: number, defs: Record<BandId, AreaBandDef>): BandId[] {
  const hits: BandId[] = [];
  for (const band of BANDS) {
    const lo = defs[band].exclusiveSqmMin;
    const hi = defs[band].exclusiveSqmMax;
    if (lo == null || hi == null) continue;
    if (max >= lo && min <= hi) hits.push(band);
  }
  return hits;
}

function lookupParcel(
  lotIndex: Map<string, Set<string>>,
  lawd: string,
  bjdong: string,
  jibun: string,
): string | null {
  const raw = jibun.trim();
  if (!raw) return null;
  const keys = [`${lawd}|${bjdong}|${raw}`];
  const [bun, ji] = raw.replace(/^산\s*/, "").split("-");
  if (bun) keys.push(`${lawd}|${bjdong}|${String(Number(bun))}`);
  if (bun && ji && Number(ji) === 0) keys.push(`${lawd}|${bjdong}|${String(Number(bun))}`);
  const found = new Set<string>();
  for (const key of keys) {
    for (const code of lotIndex.get(key) ?? []) found.add(code);
  }
  if (found.size !== 1) return null;
  return [...found][0]!;
}

function padLot(jibun: string): { plat: string; bun: string; ji: string } | null {
  const mountain = /^\s*산/.test(jibun);
  const raw = jibun.replace(/^산\s*/, "").trim();
  if (!raw) return null;
  const [bun, ji] = raw.split("-");
  if (!bun || !/^[0-9]+$/.test(bun)) return null;
  if (ji != null && ji !== "" && !/^[0-9]+$/.test(ji)) return null;
  return {
    plat: mountain ? "1" : "0",
    bun: String(Number(bun)).padStart(4, "0"),
    ji: String(Number(ji || 0)).padStart(4, "0"),
  };
}

function parcelKey(master: Master): string | null {
  const lot = padLot(master.jibun);
  if (!lot) return null;
  return `${master.lawd}|${master.bjdong}|${lot.plat}|${lot.bun}|${lot.ji}`;
}

type LedgerCacheEntry = { complete: boolean; rows: TitleRow[] };

function readLedgerCache(): Record<string, LedgerCacheEntry> {
  if (!existsSync(LEDGER_CACHE_PATH)) return {};
  return JSON.parse(readFileSync(LEDGER_CACHE_PATH, "utf8")) as Record<string, LedgerCacheEntry>;
}

function parseLedgerBody(text: string): { ok: boolean; total: number; rows: TitleRow[] } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as {
      response?: { header?: { resultCode?: string }; body?: { totalCount?: unknown; items?: { item?: unknown } } };
    };
    if (String(parsed.response?.header?.resultCode ?? "") !== "00") return { ok: false, total: 0, rows: [] };
    const item = parsed.response?.body?.items?.item;
    const list = Array.isArray(item) ? item : item ? [item] : [];
    const rows = list.map((row) => {
      const rec = row as Record<string, unknown>;
      return {
        bldNm: rec.bldNm == null ? null : String(rec.bldNm),
        dongNm: rec.dongNm == null ? null : String(rec.dongNm),
        mainPurpsCdNm: rec.mainPurpsCdNm == null ? null : String(rec.mainPurpsCdNm),
        hhldCnt: rec.hhldCnt,
      };
    });
    const totalRaw = Number(parsed.response?.body?.totalCount ?? rows.length);
    return { ok: true, total: Number.isFinite(totalRaw) ? totalRaw : rows.length, rows };
  }
  if (!trimmed.includes("<resultCode>00</resultCode>")) return { ok: false, total: 0, rows: [] };
  const rows: TitleRow[] = [];
  for (const block of trimmed.split(/<item>/).slice(1)) {
    const body = block.split(/<\/item>/)[0] ?? "";
    const pick = (tag: string) => {
      const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body);
      return match?.[1] ?? null;
    };
    rows.push({
      bldNm: pick("bldNm"),
      dongNm: pick("dongNm"),
      mainPurpsCdNm: pick("mainPurpsCdNm"),
      hhldCnt: pick("hhldCnt"),
    });
  }
  const totalMatch = /<totalCount>([0-9]+)<\/totalCount>/.exec(trimmed);
  return { ok: true, total: totalMatch ? Number(totalMatch[1]) : rows.length, rows };
}

async function fetchLedgerPages(master: Master): Promise<LedgerCacheEntry | null> {
  const lot = padLot(master.jibun);
  const key = process.env.MOLIT_API_KEY?.trim();
  if (!lot || !key) return null;
  const rows: TitleRow[] = [];
  let total = 0;
  for (let page = 1; page <= 5; page += 1) {
    const url = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?serviceKey=${key}&sigunguCd=${master.lawd}&bjdongCd=${master.bjdong}&platGbCd=${lot.plat}&bun=${lot.bun}&ji=${lot.ji}&numOfRows=100&pageNo=${page}&_type=json`;
    let parsed: { ok: boolean; total: number; rows: TitleRow[] } | null = null;
    for (let attempt = 0; attempt < 4 && !parsed; attempt += 1) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (res.status === 429 || res.status >= 500) {
          await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
          continue;
        }
        const body = parseLedgerBody(await res.text());
        if (!body.ok) {
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          continue;
        }
        parsed = body;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    if (!parsed) return null;
    total = parsed.total;
    rows.push(...parsed.rows);
    if (rows.length >= total || parsed.rows.length === 0) break;
  }
  if (total > rows.length) return { complete: false, rows: [] };
  return { complete: true, rows };
}

async function repairPriorityHouseholds(
  db: Client,
  masters: Map<string, Master>,
  resolved: Map<string, ProfileRes>,
  built: Built,
  config: RankingPrivateConfig,
) {
  void db;
  const bandHits = new Map<string, number>();
  const likely = new Set<string>();
  for (const band of BANDS) {
    for (const row of built.rows[band]) {
      bandHits.set(row.complexId, (bandHits.get(row.complexId) ?? 0) + 1);
      if ((row.householdCount == null || row.householdCount <= 0) && likelyWithoutHousehold(row, config)) {
        likely.add(row.complexId);
      }
    }
  }
  const parcelOwners = new Map<string, number>();
  for (const master of masters.values()) {
    const key = parcelKey(master);
    if (!key) continue;
    parcelOwners.set(key, (parcelOwners.get(key) ?? 0) + 1);
  }
  const targets = [...masters.values()].filter((master) => {
    const profile = resolved.get(master.complexId);
    if (profile?.household) return false;
    const bands = bandHits.get(master.complexId) ?? 0;
    if (likely.has(master.complexId) || bands >= 2) return true;
    return false;
  }).sort((a, b) => {
    const pa = likely.has(a.complexId) ? 0 : 1;
    const pb = likely.has(b.complexId) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.complexId.localeCompare(b.complexId);
  });
  const cache = readLedgerCache();
  let attempted = 0;
  let newly = 0;
  let conflicts = 0;
  const queue = targets.filter((master) => {
    const key = parcelKey(master);
    return key != null && parcelOwners.get(key) === 1;
  });
  console.log(JSON.stringify({ stage: "ledger_plan", targets: targets.length, exact_parcel: queue.length, cached: Object.keys(cache).length }));
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const master = queue[cursor++]!;
      const key = parcelKey(master);
      if (!key) continue;
      attempted += 1;
      let entry = cache[key];
      if (!entry) {
        const fetched = await fetchLedgerPages(master);
        if (!fetched) continue;
        if (!fetched.complete) continue;
        cache[key] = fetched;
        entry = fetched;
        if (attempted % 25 === 0) writeFileSync(LEDGER_CACHE_PATH, JSON.stringify(cache));
      }
      if (!entry.complete) continue;
      const household = householdFromTitleRows(entry.rows, master.name);
      if (household == null) continue;
      const current = resolved.get(master.complexId);
      if (current?.household && current.household !== household) {
        conflicts += 1;
        continue;
      }
      if (current?.household) continue;
      resolved.set(master.complexId, {
        household,
        source: "BldRgstHubService",
        sourceKey: key.replace(/\|/g, ""),
        asOf: "2026-09-19",
        confidence: "MEDIUM",
        conflict: false,
      });
      newly += 1;
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  writeFileSync(LEDGER_CACHE_PATH, JSON.stringify(cache));
  console.log(JSON.stringify({ stage: "ledger_done", attempted, newly_resolved: newly, conflicts }));
  return { newly_resolved: newly, attempted, conflicts };
}

async function loadExpectedBands(
  db: Client,
  masters: Map<string, Master>,
  defs: Record<BandId, AreaBandDef>,
): Promise<Map<string, BandId[]>> {
  const expected = new Map<string, Set<BandId>>();
  const remember = (complexId: string, min: number, max: number) => {
    if (!masters.has(complexId) || !Number.isFinite(min) || !Number.isFinite(max)) return;
    const set = expected.get(complexId) ?? new Set<BandId>();
    for (const band of bandsForSpan(min, max, defs)) set.add(band);
    if (set.size > 0) expected.set(complexId, set);
  };
  const ids = [...masters.keys()];
  const fromUnit = new Set<string>();
  for (let i = 0; i < ids.length; i += 80) {
    const slice = ids.slice(i, i + 80);
    const unit = await db.execute({
      sql: `SELECT c.complex_id, u.exclusive_area_min, u.exclusive_area_max
            FROM apt_complex_classifications c
            JOIN apt_unit_types u ON u.complex_key = c.complex_key
            WHERE c.complex_id IN (${slice.map(() => "?").join(",")})`,
      args: slice,
    });
    for (const row of unit.rows) {
      const id = String(row.complex_id);
      remember(id, Number(row.exclusive_area_min), Number(row.exclusive_area_max));
      if (expected.has(id)) fromUnit.add(id);
    }
  }
  for (let i = 0; i < ids.length; i += 80) {
    const slice = ids.slice(i, i + 80).filter((id) => !fromUnit.has(id));
    if (slice.length === 0) continue;
    const groups = await db.execute({
      sql: `SELECT complex_id, exclusive_area_min, exclusive_area_max
            FROM apt_pyeong_groups
            WHERE complex_id IN (${slice.map(() => "?").join(",")})`,
      args: slice,
    });
    const touched = new Set<string>();
    for (const row of groups.rows) {
      if (row.complex_id == null) continue;
      const id = String(row.complex_id);
      if (fromUnit.has(id)) continue;
      remember(id, Number(row.exclusive_area_min), Number(row.exclusive_area_max));
      if (expected.has(id)) touched.add(id);
    }
    for (const id of touched) fromUnit.add(id);
  }
  for (const lawd of LAWD) {
    const hist = await db.execute({
      sql: `SELECT m.complex_id,
              MAX(CASE WHEN t.exclusive_area >= 55 AND t.exclusive_area <= 65 THEN 1 ELSE 0 END) AS b59,
              MAX(CASE WHEN t.exclusive_area >= 80 AND t.exclusive_area <= 90 THEN 1 ELSE 0 END) AS b84,
              MAX(CASE WHEN t.exclusive_area >= 110 AND t.exclusive_area <= 120 THEN 1 ELSE 0 END) AS b114
            FROM apt_complex_master m
            JOIN transactions t ON t.lawd_cd = m.lawd_cd AND t.apt_name_norm = m.apt_name_norm
            WHERE m.lawd_cd = ? AND t.deal_type = 'trade'
              AND m.complex_id IN (SELECT complex_id FROM apt_complex_master WHERE lawd_cd = ?)
            GROUP BY m.complex_id`,
      args: [lawd, lawd],
    });
    for (const row of hist.rows) {
      const id = String(row.complex_id);
      if (!masters.has(id) || fromUnit.has(id)) continue;
      const set = new Set<BandId>();
      if (Number(row.b59) === 1) set.add("59");
      if (Number(row.b84) === 1) set.add("84");
      if (Number(row.b114) === 1) set.add("114");
      if (set.size > 0) expected.set(id, set);
    }
    console.log(JSON.stringify({ stage: "expected", lawd, known: expected.size }));
  }
  return new Map([...expected.entries()].map(([id, set]) => [id, [...set].sort() as BandId[]]));
}

async function ensurePublicationTable(db: Client) {
  const sql = readFileSync(PUBLICATION_SQL, "utf8");
  const precheck = precheckAdditiveCreateSql(sql);
  if (!precheck.ok) throw new Error(precheck.reason);
  for (const statement of precheck.statements) await db.execute(statement);
}

async function writePublications(db: Client, rows: PublicationInsert[]) {
  const statements: Stmt[] = rows.map((row) => ({
    sql: `INSERT INTO region_ranking_publications (
            region_scope, region_code, area_band, period, active_ranking_run_id,
            feature_run_id, ranking_version, transaction_as_of, published_at
          ) VALUES (?, ?, ?, '12M', ?, ?, ?, ?, ?)
          ON CONFLICT(region_scope, region_code, area_band, period) DO UPDATE SET
            active_ranking_run_id = excluded.active_ranking_run_id,
            feature_run_id = excluded.feature_run_id,
            ranking_version = excluded.ranking_version,
            transaction_as_of = excluded.transaction_as_of,
            published_at = excluded.published_at`,
    args: [
      row.regionScope,
      row.regionCode,
      row.areaBand,
      row.rankingRunId,
      row.featureRunId,
      row.rankingVersion,
      row.asOf,
      CALCULATED_AT,
    ],
  }));
  await runBatches(db, statements, "publications");
  return statements.length;
}

async function postValidate(db: Client, built: Built, allRun: string) {
  const version = ALGORITHM_VERSION;
  const groups = await db.execute({
    sql: `SELECT region_scope, region_code, area_band,
           COUNT(*) AS n,
           MIN("rank") AS min_rank,
           MAX("rank") AS max_rank,
           COUNT(DISTINCT "rank") AS distinct_ranks
    FROM region_complex_rankings
    WHERE ranking_version = ? AND eligible = 1 AND "rank" IS NOT NULL
    GROUP BY ranking_run_id, region_scope, region_code, area_band`,
    args: [version],
  });
  let guGap = 0;
  let guDup = 0;
  let dongGap = 0;
  for (const row of groups.rows) {
    const n = Number(row.n);
    const minRank = Number(row.min_rank);
    const maxRank = Number(row.max_rank);
    const distinct = Number(row.distinct_ranks);
    const gap = minRank !== 1 || maxRank !== n || distinct !== n;
    const dup = distinct !== n;
    if (row.region_scope === "gu" && gap) guGap += 1;
    if (row.region_scope === "gu" && dup) guDup += 1;
    if (row.region_scope === "dong" && gap) dongGap += 1;
  }
  const missingRank = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM region_complex_rankings WHERE ranking_version = ? AND eligible = 1 AND "rank" IS NULL`,
    args: [version],
  });
  const featureDup = await db.execute(`
    SELECT COUNT(*) AS c FROM (
      SELECT feature_run_id, complex_id, area_band, period
      FROM ranking_feature_snapshots
      GROUP BY feature_run_id, complex_id, area_band, period
      HAVING COUNT(*) > 1
    )
  `);
  const badAll = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM region_complex_rankings
          WHERE ranking_version = ? AND area_band = 'ALL' AND (
            public_display_metrics_json NOT LIKE '%valid_band_count%'
            OR public_display_metrics_json LIKE '%median_price_per_sqm%'
            OR feature_run_id != ?
          )`,
    args: [version, built.allFeatureRunId],
  });
  const orphanFeature = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM region_complex_rankings r
          WHERE r.ranking_version = ? AND r.area_band != 'ALL'
            AND NOT EXISTS (
              SELECT 1 FROM ranking_feature_snapshots f
              WHERE f.feature_run_id = r.feature_run_id
                AND f.complex_id = r.complex_id
                AND f.area_band = r.area_band
                AND f.period = r.period
            )`,
    args: [version],
  });
  const badPublication = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM region_ranking_publications p
          WHERE p.ranking_version != ?
             OR p.active_ranking_run_id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM region_complex_rankings r
               WHERE r.ranking_run_id = p.active_ranking_run_id
                 AND r.region_scope = p.region_scope
                 AND r.region_code = p.region_code
                 AND r.area_band = p.area_band
                 AND r.period = p.period
                 AND r.ranking_version = p.ranking_version
             )`,
    args: [version],
  });
  const oldSelected = await db.execute({
    sql: `SELECT COUNT(*) AS c FROM region_ranking_publications WHERE ranking_version != ?`,
    args: [version],
  });
  const published = await db.execute(
    `SELECT area_band, region_scope, COUNT(*) AS c
     FROM region_ranking_publications
     GROUP BY area_band, region_scope`,
  );
  const focus = ["11680", "11650", "11710", "11200", "11440", "11350"];
  const tops: Record<string, unknown> = {};
  const timings: Record<string, number> = {};
  for (const lawd of focus) {
    for (const band of ["ALL", "59", "84", "114"] as const) {
      if (lawd !== "11710" && band !== "ALL") continue;
      const started = Date.now();
      const result = await publishedRegionRanking(db, { regionCode: lawd, areaBand: band, limit: 10 });
      timings[`${lawd}:${band}`] = Date.now() - started;
      tops[`${lawd}:${band}`] = result.published
        ? result.rows.map((row) => ({
          rank: row.rank,
          name: row.name,
          total: row.regionTotal,
          confidence: row.confidenceBucket,
          metrics: row.publicMetrics,
        }))
        : { published: false };
    }
  }
  const complexStarted = Date.now();
  const jamsilAll = await publishedComplexPosition(db, { complexId: "cx_4c63d9a100973c60" });
  const jamsilAllMs = Date.now() - complexStarted;
  const jamsil84Started = Date.now();
  const jamsil84 = await publishedComplexPosition(db, { complexId: "cx_4c63d9a100973c60", areaBand: "84" });
  const jamsil84Ms = Date.now() - jamsil84Started;
  const spot = {
    ranking_version: version,
    all_ranking_run_id: allRun,
    gu_rank_gap_cells: guGap,
    gu_duplicate_rank_cells: guDup,
    dong_slot_gap_cells: dongGap,
    eligible_missing_rank: Number(missingRank.rows[0]!.c),
    feature_duplicate_groups: Number(featureDup.rows[0]!.c),
    invalid_all_rows: Number(badAll.rows[0]!.c),
    orphan_feature_rows: Number(orphanFeature.rows[0]!.c),
    bad_publications: Number(badPublication.rows[0]!.c),
    old_runs_selected: Number(oldSelected.rows[0]!.c),
    published: published.rows,
    timings,
    jamsil_all_ms: jamsilAllMs,
    jamsil_84_ms: jamsil84Ms,
    tops,
    jamsil_all: jamsilAll,
    jamsil_84: jamsil84,
  };
  writeFileSync("/tmp/seoul-launch-spotcheck.json", JSON.stringify(spot, null, 2) + "\n");
  console.log(JSON.stringify({
    stage: "validate",
    gu_rank_gap_cells: guGap,
    gu_duplicate_rank_cells: guDup,
    dong_slot_gap_cells: dongGap,
    eligible_missing_rank: spot.eligible_missing_rank,
    orphan_feature_rows: spot.orphan_feature_rows,
    bad_publications: spot.bad_publications,
    old_runs_selected: spot.old_runs_selected,
    published: published.rows,
    region_top_ms: timings["11710:ALL"],
    complex_ms: jamsil84Ms,
  }));
}

main();
