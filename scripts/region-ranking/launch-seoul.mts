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
import { aggregateAll, type AllBandId, type AllPrivateConfig, type AllBandStrength } from "../../src/lib/region-ranking/all-aggregate";
import { loadPrivateConfig, type RankingPrivateConfig } from "../../src/lib/region-ranking/private-config";
import { cohortInputId, featureRunId, rankingRunId, sha256Hex } from "../../src/lib/region-ranking/run-identity";
import { percentileRank, priceGateMode, rankWithTopTierSlots, scoreCohort, type FeatureSnapshotRow } from "../../src/lib/region-ranking/score";
import { FEATURE_VERSION, windowsFromAsOf } from "../../src/lib/region-ranking/snapshot";

const P1_FINGERPRINT = "19ba3623e8187a35f763a0a44e6c37ba568c8322e5b6e5c82c761c9a632c7835";
const PINNED_TARGET = "2026-09-17";
const LAWD = SEOUL_REGIONS.map((region) => region.lawdCodes[0]!);
if (LAWD.length !== 25) throw new Error("SEOUL_GU_COUNT");
const GU_NAME = new Map(SEOUL_REGIONS.map((region) => [region.lawdCodes[0]!, region.name]));
const BANDS = ["59", "84", "114"] as const;
const KAPT_PATH = process.env.KAPT_UNIVERSE_PATH ?? "/tmp/national-inputs/kapt-complex-universe.jsonl";
const CACHE_PATH = "/tmp/seoul-kapt-basis-cache.json";
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
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3) throw new Error("ALL_CONFIG_MALFORMED");
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
  const profileWrites = await fillNullProfiles(db, resolved, profiles);
  const profileAfter = Number((await db.execute("SELECT COUNT(*) AS c FROM apt_complex_profile")).rows[0]!.c);

  const built = buildBands(masters, deals, resolved, asOf, windows, bandDefs);
  if (!built.deterministic) {
    console.log(JSON.stringify({ status: "DETERMINISM_FAIL" }));
    process.exit(2);
  }

  const cellResults = [];
  const rankingRows: RankingInsert[] = [];
  const guScores = new Map<string, Map<BandId, Map<string, { score: number; pricePercentile: number; row: FeatureSnapshotRow }>>>();
  let dongBandCohorts = 0;
  let dongSmallCohorts = 0;

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
        pushRanking(rankingRows, scored, cohort, runId, loaded.fingerprint, config, "gu", lawd, band);
        const dongCodes = [...new Set(cohort.map((row) => row.bjdongCd))];
        for (const bjdong of dongCodes) {
          const members = cohort.filter((row) => row.bjdongCd === bjdong);
          dongBandCohorts += 1;
          if (members.length <= 6) dongSmallCohorts += 1;
          const dong = scoreCohort({
            featureRunId: runId,
            rows: members,
            regionScope: "dong",
            regionCode: bjdong,
            config,
            privateConfigFingerprint: loaded.fingerprint,
          });
          if (!dong.ok) continue;
          pushRanking(rankingRows, dong, members, runId, loaded.fingerprint, config, "dong", `${lawd}${bjdong}`, band);
        }
      }
    }
  }

  const selected = selectAll(allConfigs, guScores, LAWD);
  const allRun = rankingRunId({
    featureRunId: built.allFeatureRunId,
    rankingVersion: selected.config.rankingVersion,
    privateConfigFingerprint: selected.fingerprint,
    regionScope: "gu",
    regionCode: "11",
  });
  const allCells = [];
  const allCoverage = { 3: 0, 2: 0, 1: 0, excluded: 0 };
  let allDongCohorts = 0;
  let allSmallCohorts = 0;
  for (const lawd of LAWD) {
    const items = allItemsForGu(lawd, guScores, selected.config);
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
    const singleInTop = items.filter((item) => item.rank != null && item.rank <= 5 && item.coverage === 1).length;
    const topCount = items.filter((item) => item.rank != null && item.rank <= 5).length;
    const ranks = items.filter((item) => item.rank != null).map((item) => item.rank!);
    const issues = rankIssues(ranks);
    let status = "PASS";
    if (items.length === 0) status = "HOLD_ALL_EMPTY";
    else if (issues.duplicate > 0 || issues.gaps > 0) status = "HOLD_ALL_RANK_GAP";
    else if (topCount > 0 && singleInTop / topCount > 0.6) status = "HOLD_ALL_SINGLE_BAND";
    allCells.push({ lawd, gu: GU_NAME.get(lawd), status, eligible: items.length, single_in_top5: singleInTop });
    if (status !== "PASS") continue;
    for (const item of items) {
      rankingRows.push(allRow(allRun, built.allFeatureRunId, selected.config.rankingVersion, asOf, "gu", lawd, item));
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
      for (const item of members) {
        rankingRows.push(allRow(allRun, built.allFeatureRunId, selected.config.rankingVersion, asOf, "dong", `${lawd}${bjdong}`, {
          ...item,
          rank: rankById.get(item.complexId) ?? null,
          regionTotal: members.length,
        }));
      }
    }
  }

  console.log(JSON.stringify({ stage: "write", features: built.universe, rankings: rankingRows.length }));
  const featureInserted = await writeFeatures(db, built, asOf);
  await writeFeatures(db, built, asOf);
  const rankingInserted = await writeRankings(db, rankingRows);
  const featureCount = await db.execute("SELECT COUNT(*) AS c FROM ranking_feature_snapshots");
  const rankingCount = await db.execute("SELECT COUNT(*) AS c FROM region_complex_rankings");
  await writeRankings(db, rankingRows);
  const featureCount2 = await db.execute("SELECT COUNT(*) AS c FROM ranking_feature_snapshots");
  const rankingCount2 = await db.execute("SELECT COUNT(*) AS c FROM region_complex_rankings");

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
    ranking_version: config.rankingVersion,
    p1_fingerprint: loaded.fingerprint,
    all_ranking_version: selected.config.rankingVersion,
    all_fingerprint: selected.fingerprint,
    all_ranking_run_id: allRun,
    all_selection: selected.reason,
    ambiguous_name_groups: ambiguous.rows.length,
    universe: built.universe,
    profile_writes: profileWrites,
    profile_count_before: profileBefore,
    profile_count_after: profileAfter,
    profile_resolved: [...resolved.values()].filter((row) => row.household != null && row.household > 0).length,
    profile_missing: [...resolved.values()].filter((row) => row.household == null || row.household <= 0).length,
    conflicts: [...resolved.values()].filter((row) => row.conflict).length,
    dong_band_cohorts: dongBandCohorts,
    dong_small_cohorts: dongSmallCohorts,
    all_dong_cohorts: allDongCohorts,
    all_small_cohorts: allSmallCohorts,
    cells: cellResults,
    all_cells: allCells,
    all_coverage: allCoverage,
    comparison: selected.comparison,
    counts: {
      feature_before_rerun: Number(featureCount.rows[0]!.c),
      feature_after_rerun: Number(featureCount2.rows[0]!.c),
      ranking_before_rerun: Number(rankingCount.rows[0]!.c),
      ranking_after_rerun: Number(rankingCount2.rows[0]!.c),
      feature_inserted_attempt: featureInserted,
      ranking_inserted_attempt: rankingInserted,
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
    all_version: selected.config.rankingVersion,
    feature_rows: manifest.counts.feature_after_rerun,
    ranking_rows: manifest.counts.ranking_after_rerun,
    idempotent: manifest.counts.feature_before_rerun === manifest.counts.feature_after_rerun
      && manifest.counts.ranking_before_rerun === manifest.counts.ranking_after_rerun,
    profile_resolved: manifest.profile_resolved,
    profile_missing: manifest.profile_missing,
    conflicts: manifest.conflicts,
    profile_writes: profileWrites,
  }));
  await postValidate(db, built.allFeatureRunId);
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
    const parcel = master.jibun ? lotIndex.get(`${master.lawd}|${master.bjdong}|${master.jibun}`) : undefined;
    let code: string | null = null;
    if (named && named.size === 1 && parcel && parcel.size === 1 && [...named][0] === [...parcel][0]) code = [...named][0]!;
    else if (parcel && parcel.size === 1) code = [...parcel][0]!;
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
    rankingVersion: config.rankingVersion,
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
      rankingVersion: config.rankingVersion,
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

function selectAll(
  configs: AllPrivateConfig[],
  guScores: Map<string, Map<BandId, Map<string, { score: number; pricePercentile: number; row: FeatureSnapshotRow }>>>,
  lawds: string[],
) {
  const focus = ["11680", "11650", "11710", "11200", "11440", "11350"];
  const boards = configs.map((config) => {
    const tops = new Map<string, string[]>();
    for (const lawd of focus) {
      const items = allItemsForGu(lawd, guScores, config).filter((item) => item.rank != null && item.rank <= 10);
      tops.set(lawd, items.sort((a, b) => a.rank! - b.rank!).map((item) => item.complexId));
    }
    return { config, fingerprint: sha256Hex(JSON.stringify(config)), tops };
  });
  const overlap = (a: string[], b: string[]) => a.filter((id) => b.includes(id)).length;
  const comparison = [];
  for (let i = 0; i < boards.length; i++) {
    for (let j = i + 1; j < boards.length; j++) {
      let top5 = 0;
      let top10 = 0;
      let n = 0;
      for (const lawd of focus) {
        const left = boards[i]!.tops.get(lawd) ?? [];
        const right = boards[j]!.tops.get(lawd) ?? [];
        top5 += overlap(left.slice(0, 5), right.slice(0, 5));
        top10 += overlap(left.slice(0, 10), right.slice(0, 10));
        n += 1;
      }
      comparison.push({
        pair: `${boards[i]!.config.rankingVersion}|${boards[j]!.config.rankingVersion}`,
        mean_top5: Number((top5 / n).toFixed(2)),
        mean_top10: Number((top10 / n).toFixed(2)),
      });
    }
  }
  const simplest = boards.find((board) => board.config.method === "reliability_weighted_mean") ?? boards[0]!;
  const close = comparison.every((row) => row.mean_top5 >= 4 && row.mean_top10 >= 8);
  return {
    config: simplest.config,
    fingerprint: simplest.fingerprint,
    reason: close ? "candidates agree; selected reliability-weighted mean" : "candidates diverged; selected reliability-weighted mean as the launch-safe simple aggregate",
    comparison,
  };
}

function allItemsForGu(
  lawd: string,
  guScores: Map<string, Map<BandId, Map<string, { score: number; pricePercentile: number; row: FeatureSnapshotRow }>>>,
  config: AllPrivateConfig,
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
    const aggregate = aggregateAll(strengths, config);
    if (!aggregate) continue;
    items.push({
      complexId,
      bjdong,
      score: aggregate.score,
      topTier: aggregate.topTier,
      tieBreak,
      coverage: aggregate.coverage,
      coverageClass: aggregate.coverageClass,
      lowCoverage: aggregate.lowCoverage,
      bands: aggregate.bands,
      confidence,
      rank: null as number | null,
      regionTotal: 0,
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
    confidence: item.lowCoverage ? "LOW_COVERAGE" : item.confidence,
    eligible: 1,
    exclusion: null,
    rankingVersion,
    asOf,
    metrics: JSON.stringify({
      valid_band_count: item.coverage,
      available_bands: item.bands.join(","),
      coverage_class: item.coverageClass,
      low_coverage: item.lowCoverage,
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
        ON CONFLICT(feature_run_id, complex_id, area_band, period) DO UPDATE SET
          household_count = excluded.household_count,
          turnover = excluded.turnover,
          profile_source = excluded.profile_source,
          profile_confidence = excluded.profile_confidence,
          eligible_input = excluded.eligible_input,
          exclusion_reason = excluded.exclusion_reason,
          calculated_at = excluded.calculated_at`,
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

async function postValidate(db: Client, allFeatureRunId: string) {
  const groups = await db.execute(`
    SELECT region_scope, region_code, area_band,
           COUNT(*) AS n,
           MIN("rank") AS min_rank,
           MAX("rank") AS max_rank,
           COUNT(DISTINCT "rank") AS distinct_ranks
    FROM region_complex_rankings
    WHERE eligible = 1 AND "rank" IS NOT NULL
    GROUP BY ranking_run_id, region_scope, region_code, area_band
  `);
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
  const missingRank = await db.execute(`SELECT COUNT(*) AS c FROM region_complex_rankings WHERE eligible = 1 AND "rank" IS NULL`);
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
          WHERE area_band = 'ALL' AND (
            public_display_metrics_json NOT LIKE '%valid_band_count%'
            OR public_display_metrics_json LIKE '%median_price_per_sqm%'
            OR feature_run_id != ?
          )`,
    args: [allFeatureRunId],
  });
  const bandCounts = await db.execute(`
    SELECT area_band, region_scope, COUNT(*) AS c
    FROM region_complex_rankings
    GROUP BY area_band, region_scope
  `);
  const focus = ["11680", "11650", "11710", "11200", "11440", "11350"];
  const tops: Record<string, unknown> = {};
  for (const lawd of focus) {
    for (const band of ["ALL", "59", "84", "114"]) {
      if (lawd !== "11710" && band !== "ALL") continue;
      const result = await db.execute({
        sql: `SELECT r."rank" AS rank, r.region_total, r.confidence_bucket, r.public_display_metrics_json, m.apt_name_norm
              FROM region_complex_rankings r
              LEFT JOIN apt_complex_master m ON m.complex_id = r.complex_id
              WHERE r.region_scope = 'gu' AND r.region_code = ? AND r.area_band = ?
                AND r.eligible = 1 AND r."rank" IS NOT NULL AND r."rank" <= 10
              ORDER BY r."rank"`,
        args: [lawd, band],
      });
      tops[`${lawd}:${band}`] = result.rows.map((row) => ({
        rank: Number(row.rank),
        name: row.apt_name_norm,
        total: Number(row.region_total),
        confidence: row.confidence_bucket,
        metrics: JSON.parse(String(row.public_display_metrics_json)),
      }));
    }
  }
  const jamsil = await db.execute({
    sql: `SELECT region_scope, region_code, area_band, "rank" AS rank, region_total, confidence_bucket
          FROM region_complex_rankings
          WHERE complex_id = 'cx_4c63d9a100973c60'
            AND region_code IN ('11710', '1171010100')
            AND area_band IN ('ALL', '84', '59', '114')`,
    args: [],
  });
  const spot = {
    gu_rank_gap_cells: guGap,
    gu_duplicate_rank_cells: guDup,
    dong_slot_gap_cells: dongGap,
    eligible_missing_rank: Number(missingRank.rows[0]!.c),
    feature_duplicate_groups: Number(featureDup.rows[0]!.c),
    invalid_all_rows: Number(badAll.rows[0]!.c),
    ranking_counts: bandCounts.rows,
    tops,
    jamsil: jamsil.rows,
  };
  writeFileSync("/tmp/seoul-launch-spotcheck.json", JSON.stringify(spot, null, 2) + "\n");
  console.log(JSON.stringify({
    stage: "validate",
    gu_rank_gap_cells: guGap,
    gu_duplicate_rank_cells: guDup,
    dong_slot_gap_cells: dongGap,
    eligible_missing_rank: spot.eligible_missing_rank,
    feature_duplicate_groups: spot.feature_duplicate_groups,
    invalid_all_rows: spot.invalid_all_rows,
  }));
}

main();
