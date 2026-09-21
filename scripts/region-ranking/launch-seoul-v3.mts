/**
 * Materialize seoul-ranking-v3: canonical universe, decade cohorts, no activity hard gates.
 *
 * Usage:
 *   tsx scripts/region-ranking/launch-seoul-v3.mts /tmp/seoul-v3-p1.json
 *   tsx scripts/region-ranking/launch-seoul-v3.mts /tmp/seoul-v3-p1.json --apply
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createClient, type Client } from "@libsql/client";
import { exclusiveCents } from "../../src/lib/unit-type/canonical";
import { marketPyeongLabelInteger } from "../../src/lib/unit-type/supply-label";
import { seoulLawdCodes } from "../../src/lib/region-ranking/price-position-read";
import { evaluateHardIdentityV3 } from "../../src/lib/region-ranking/eligibility-v3";
import { extractFeaturesV3, type LabeledDeal } from "../../src/lib/region-ranking/features-v3";
import { loadPrivateConfigV3 } from "../../src/lib/region-ranking/private-config-v3";
import {
  AREA_BAND_VERSION_V3,
  DECADE_COHORTS_V3,
  FEATURE_VERSION_V3,
  METHODOLOGY_FINGERPRINT_V3,
  RANKING_V3_AS_OF,
  RANKING_V3_PERIOD,
  RANKING_V3_VERSION,
  decadeCohortForLabel,
} from "../../src/lib/region-ranking/ranking-v3";
import {
  featureInputsToSnapshotFields,
  scoreCohortV3,
  type FeatureSnapshotRowV3,
  type PublicRankingRowV3,
} from "../../src/lib/region-ranking/score-v3";
import { windowsFromAsOf } from "../../src/lib/region-ranking/snapshot";
import { featureRunId, rankingRunId, sha256Hex } from "../../src/lib/region-ranking/run-identity";
import type { ProfileInput } from "../../src/lib/region-ranking/features";

const APPLY = process.argv.includes("--apply");
const CONFIG_PATH = process.argv[2] && process.argv[2].endsWith(".json") ? process.argv[2] : "/tmp/seoul-v3-p1.json";
const REPORT = "/tmp/building-hub-bulk/external-evidence/ranking-v3-report.json";
const BATCH = 40;
const PINNED = RANKING_V3_AS_OF;

const PILOTS: Record<string, string> = {
  잠실엘스: "cx_4c63d9a100973c60",
  리센츠: "cx_caf229b5ac63cfbd",
  트리지움: "cx_85cd8a4b2d5dc3d0",
  파크리오: "cx_ed52bf895d064c11",
  헬리오시티: "cx_30d7eea6da810b52",
  반포자이: "cx_1c244e7305d12c44",
  래미안퍼스티지: "cx_3bcf0f87bce7496b",
  은마: "cx_0320fd9e007e1f8c",
  도곡렉슬: "cx_c9ed0235ecca960c",
};

type Master = {
  complexId: string;
  name: string;
  lawd: string;
  bjdong: string;
  aptNameNorm: string;
  identityStatus: string | null;
};

function client(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("missing turso env");
  return createClient({ url, authToken });
}

function num(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const loaded = loadPrivateConfigV3(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  if (!loaded.ok) {
    console.log(JSON.stringify({ status: "CONFIG_FAIL", code: loaded.code }));
    process.exit(2);
  }
  const config = loaded.config;
  const db = client();
  const lawds = seoulLawdCodes();
  const maxRow = await db.execute({
    sql: `SELECT MAX(deal_date) AS m FROM transactions WHERE deal_type='trade' AND lawd_cd IN (${lawds.map(() => "?").join(",")})`,
    args: lawds,
  });
  const warehouseMax = String(maxRow.rows[0]!.m).slice(0, 10);
  const asOf = warehouseMax < PINNED ? warehouseMax : PINNED;
  const windows = windowsFromAsOf(asOf);

  const ambiguous = new Set<string>();
  for (const lawd of lawds) {
    const rows = await db.execute({
      sql: `SELECT apt_name_norm FROM apt_complex_master WHERE lawd_cd=? GROUP BY apt_name_norm HAVING COUNT(*)>1`,
      args: [lawd],
    });
    for (const row of rows.rows) ambiguous.add(`${lawd}|${row.apt_name_norm}`);
  }

  const masters = new Map<string, Master>();
  const hardExcluded = new Map<string, string>();
  const supplyDecades = new Map<string, Set<string>>();
  const deals = new Map<string, LabeledDeal[]>();
  const byName = new Map<string, string>();

  for (const lawd of lawds) {
    const rows = await db.execute({
      sql: `SELECT complex_id, apt_name, apt_name_norm, bjdong_cd, identity_status
            FROM apt_complex_master WHERE lawd_cd=?`,
      args: [lawd],
    });
    for (const row of rows.rows) {
      const id = String(row.complex_id);
      const norm = String(row.apt_name_norm);
      const gate = evaluateHardIdentityV3({
        complexId: id,
        lawdCd: lawd,
        bjdongCd: row.bjdong_cd == null ? null : String(row.bjdong_cd),
        aptNameNorm: norm,
        identityStatus: row.identity_status == null ? null : String(row.identity_status),
        ambiguousName: ambiguous.has(`${lawd}|${norm}`),
      });
      if (!gate.ok) {
        hardExcluded.set(id, gate.reason);
        continue;
      }
      masters.set(id, {
        complexId: id,
        name: String(row.apt_name ?? norm),
        lawd,
        bjdong: String(row.bjdong_cd),
        aptNameNorm: norm,
        identityStatus: row.identity_status == null ? null : String(row.identity_status),
      });
      byName.set(`${lawd}|${norm}`, id);
      supplyDecades.set(id, new Set());
      deals.set(id, []);
    }
    console.log(JSON.stringify({ stage: "masters", lawd, n: rows.rows.length }));
  }

  const floorSupply = new Map<string, number>();
  const floorPath = "/tmp/building-hub-bulk/external-evidence/floor-resolvers.jsonl";
  if (existsSync(floorPath)) {
    const rl = createInterface({ input: createReadStream(floorPath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      const row = JSON.parse(line) as {
        level: string;
        complexId: string;
        exclusiveCents: number;
        floor: string;
        buildingDong: string;
        supplyCents: number;
      };
      if (row.level === "EXACT_FLOOR" && !row.buildingDong && masters.has(row.complexId)) {
        floorSupply.set(`${row.complexId}|${row.exclusiveCents}|${row.floor}`, row.supplyCents / 100);
      }
    }
  }

  for (const lawd of lawds) {
    const ids = [...masters.values()].filter((row) => row.lawd === lawd).map((row) => row.complexId);
    if (!ids.length) continue;
    const supplies = new Map<string, number[]>();
    const exactKeys = new Set<string>();
    const supplyRows = await db.execute({
      sql: `SELECT complex_id, exclusive_cents, supply_area, status
            FROM apt_canonical_unit_types
            WHERE complex_id IN (${ids.map(() => "?").join(",")})
              AND supply_cents >= 0 AND status IN ('EXACT_SINGLE','AMBIGUOUS_MULTI')`,
      args: ids,
    });
    for (const row of supplyRows.rows) {
      const key = `${row.complex_id}|${num(row.exclusive_cents)}`;
      const list = supplies.get(key) ?? [];
      list.push(num(row.supply_area));
      supplies.set(key, list);
      if (String(row.status) === "EXACT_SINGLE") exactKeys.add(key);
      const labels = [
        ...new Set(list.map((area) => marketPyeongLabelInteger(area)).filter((label): label is number => label != null)),
      ];
      if (labels.length === 1) {
        const cohort = decadeCohortForLabel(labels[0]!);
        if (cohort) supplyDecades.get(String(row.complex_id))?.add(cohort.key);
      } else if (String(row.status) === "EXACT_SINGLE" && list.length === 1) {
        const label = marketPyeongLabelInteger(list[0]!);
        const cohort = label == null ? null : decadeCohortForLabel(label);
        if (cohort) supplyDecades.get(String(row.complex_id))?.add(cohort.key);
      }
    }
    // Rebuild exclusive label map carefully for deterministic labels
    const exclusives = new Map<string, Set<number>>();
    for (const row of supplyRows.rows) {
      const key = `${row.complex_id}|${num(row.exclusive_cents)}`;
      const label = marketPyeongLabelInteger(num(row.supply_area));
      if (label == null) continue;
      const set = exclusives.get(key) ?? new Set<number>();
      set.add(label);
      exclusives.set(key, set);
    }
    for (const [key, labels] of exclusives) {
      if (labels.size !== 1) continue;
      const id = key.slice(0, key.indexOf("|"));
      const cohort = decadeCohortForLabel([...labels][0]!);
      if (cohort) supplyDecades.get(id)?.add(cohort.key);
    }

    const lookbackStart = (() => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf)!;
      const dt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
      dt.setUTCMonth(dt.getUTCMonth() - config.priceLookbackMonths);
      return dt.toISOString().slice(0, 10);
    })();
    const tx = await db.execute({
      sql: `SELECT apt_name_norm, exclusive_area, deal_amount, floor, deal_date
            FROM transactions
            WHERE lawd_cd=? AND deal_type='trade' AND deal_amount>0 AND exclusive_area>0
              AND deal_date>? AND deal_date<=?`,
      args: [lawd, lookbackStart, asOf],
    });
    for (const row of tx.rows) {
      const norm = String(row.apt_name_norm);
      if (ambiguous.has(`${lawd}|${norm}`)) continue;
      const complexId = byName.get(`${lawd}|${norm}`);
      if (!complexId || !masters.has(complexId)) continue;
      const exclusiveArea = Number(row.exclusive_area);
      const pair = `${complexId}|${exclusiveCents(exclusiveArea)}`;
      const floorHit = floorSupply.get(`${pair}|${Number(row.floor)}`);
      const areas = supplies.get(pair) ?? [];
      let label: number | null = null;
      if (floorHit != null) label = marketPyeongLabelInteger(floorHit);
      else if (exactKeys.has(pair) && areas.length === 1) label = marketPyeongLabelInteger(areas[0]!);
      else {
        const labels = [
          ...new Set(areas.map((area) => marketPyeongLabelInteger(area)).filter((item): item is number => item != null)),
        ];
        if (labels.length === 1) label = labels[0]!;
      }
      if (label == null || !(label > 0)) continue;
      deals.get(complexId)!.push({
        dealDate: String(row.deal_date),
        exclusiveArea,
        dealAmount: Number(row.deal_amount),
        marketPyeongLabel: label,
      });
    }
    console.log(JSON.stringify({ stage: "trades", lawd, rows: tx.rows.length }));
  }

  // Resolve Trizium id if placeholder
  const trizium = await db.execute({
    sql: `SELECT complex_id FROM apt_complex_master WHERE lawd_cd='11710' AND apt_name_norm LIKE ? LIMIT 1`,
    args: ["%트리지움%"],
  });
  if (trizium.rows[0]) PILOTS.트리지움 = String(trizium.rows[0].complex_id);

  const profiles = new Map<string, ProfileInput>();
  const idList = [...masters.keys()];
  for (let i = 0; i < idList.length; i += 80) {
    const slice = idList.slice(i, i + 80);
    const rows = await db.execute({
      sql: `SELECT complex_id, household_count, source
            FROM apt_complex_profile WHERE complex_id IN (${slice.map(() => "?").join(",")})`,
      args: slice,
    });
    for (const row of rows.rows) {
      const hh = row.household_count == null ? null : Number(row.household_count);
      const source = row.source == null ? null : String(row.source);
      profiles.set(String(row.complex_id), {
        householdCount: hh != null && hh > 0 ? hh : null,
        source,
        sourceKey: null,
        sourceAsOf: null,
        confidence: hh != null && hh > 0 ? (source?.includes("kapt") ? "HIGH" : "MEDIUM") : "MISSING",
      });
    }
  }
  for (const id of masters.keys()) {
    if (!profiles.has(id)) {
      profiles.set(id, {
        householdCount: null,
        source: null,
        sourceKey: null,
        sourceAsOf: null,
        confidence: "MISSING",
      });
    }
  }

  const decadeRows = new Map<string, FeatureSnapshotRowV3[]>();
  const decadeStrengthGu = new Map<string, Map<string, Map<string, number>>>(); // lawd -> decade -> complex -> score
  const rankingRows: PublicRankingRowV3[] = [];
  const publications: Array<{
    regionScope: "gu" | "dong";
    regionCode: string;
    areaBand: string;
    rankingRunId: string;
    featureRunId: string;
  }> = [];
  const coverage: Record<string, unknown> = {};
  const featureIds: Record<string, string> = {};

  for (const cohort of DECADE_COHORTS_V3) {
    const rows: FeatureSnapshotRowV3[] = [];
    for (const master of masters.values()) {
      if (!supplyDecades.get(master.complexId)?.has(cohort.key)) continue;
      const profile = profiles.get(master.complexId)!;
      const features = extractFeaturesV3({
        deals: deals.get(master.complexId) ?? [],
        cohort,
        windows,
        profile,
        priceLookbackMonths: config.priceLookbackMonths,
      });
      rows.push({
        complexId: master.complexId,
        lawdCd: master.lawd,
        bjdongCd: master.bjdong,
        areaBand: cohort.key,
        areaBandVersion: AREA_BAND_VERSION_V3,
        period: RANKING_V3_PERIOD,
        transactionAsOf: asOf,
        sourceWindowStart: windows.base12m.startExclusive,
        sourceWindowEnd: windows.base12m.endInclusive,
        recentWindowStart: windows.recent3m.startExclusive,
        recentWindowEnd: windows.recent3m.endInclusive,
        previousWindowStart: windows.previous3m.startExclusive,
        previousWindowEnd: windows.previous3m.endInclusive,
        featureVersion: FEATURE_VERSION_V3,
        identityStatus: master.identityStatus,
        decadeCompetitiveness: null,
        decadeCompetitivenessAvailability: "MISSING",
        decadeCount: supplyDecades.get(master.complexId)?.size ?? 0,
        ...featureInputsToSnapshotFields(features),
      });
    }
    const runId = featureRunId({
      transactionAsOf: asOf,
      sourceWindowStart: windows.base12m.startExclusive,
      sourceWindowEnd: windows.base12m.endInclusive,
      recentWindowStart: windows.recent3m.startExclusive,
      recentWindowEnd: windows.recent3m.endInclusive,
      previousWindowStart: windows.previous3m.startExclusive,
      previousWindowEnd: windows.previous3m.endInclusive,
      areaBand: cohort.key,
      areaBandVersion: AREA_BAND_VERSION_V3,
      featureVersion: FEATURE_VERSION_V3,
      cohortInputId: sha256Hex(`v3-decade-${cohort.key}-${rows.length}`),
    });
    featureIds[cohort.key] = runId;
    decadeRows.set(cohort.key, rows);

    let missingPrice = 0;
    let missingTrade = 0;
    let ranked = 0;
    for (const lawd of lawds) {
      const cohortRows = rows.filter((row) => row.lawdCd === lawd);
      const scored = scoreCohortV3({
        featureRunId: runId,
        rows: cohortRows,
        regionScope: "gu",
        regionCode: lawd,
        config,
        privateConfigFingerprint: loaded.fingerprint,
        rankingVersion: RANKING_V3_VERSION,
      });
      if (!scored.ok) throw new Error("decade score failed");
      ranked += scored.baseEligible;
      const lawdMap = decadeStrengthGu.get(lawd) ?? new Map();
      const byComplex = new Map<string, number>();
      for (const [id, score] of Object.entries(scored.strengthByComplex)) byComplex.set(id, score);
      lawdMap.set(cohort.key, byComplex);
      decadeStrengthGu.set(lawd, lawdMap);
      publications.push({
        regionScope: "gu",
        regionCode: lawd,
        areaBand: cohort.key,
        rankingRunId: rankingRunId({
          featureRunId: runId,
          rankingVersion: RANKING_V3_VERSION,
          privateConfigFingerprint: loaded.fingerprint,
          regionScope: "gu",
          regionCode: lawd,
        }),
        featureRunId: runId,
      });
      for (const row of scored.rows) {
        rankingRows.push({
          ...row,
          regionCode: lawd,
          publicDisplayMetrics: {
            ...row.publicDisplayMetrics,
            region_pyeong_decade: cohort.label,
          },
        });
      }
      const dongs = [...new Set(cohortRows.map((row) => row.bjdongCd))];
      for (const bjdong of dongs) {
        const members = cohortRows.filter((row) => row.bjdongCd === bjdong);
        const dongCode = `${lawd}${bjdong}`;
        const dong = scoreCohortV3({
          featureRunId: runId,
          rows: members,
          regionScope: "dong",
          regionCode: bjdong,
          config,
          privateConfigFingerprint: loaded.fingerprint,
          rankingVersion: RANKING_V3_VERSION,
        });
        if (!dong.ok) continue;
        publications.push({
          regionScope: "dong",
          regionCode: dongCode,
          areaBand: cohort.key,
          rankingRunId: rankingRunId({
            featureRunId: runId,
            rankingVersion: RANKING_V3_VERSION,
            privateConfigFingerprint: loaded.fingerprint,
            regionScope: "dong",
            regionCode: dongCode,
          }),
          featureRunId: runId,
        });
        for (const row of dong.rows) {
          rankingRows.push({
            ...row,
            regionScope: "dong",
            regionCode: dongCode,
            rankingRunId: rankingRunId({
              featureRunId: runId,
              rankingVersion: RANKING_V3_VERSION,
              privateConfigFingerprint: loaded.fingerprint,
              regionScope: "dong",
              regionCode: dongCode,
            }),
            publicDisplayMetrics: {
              ...row.publicDisplayMetrics,
              region_pyeong_decade: cohort.label,
            },
          });
        }
      }
    }
    for (const row of rows) {
      if (row.priceAvailability === "MISSING") missingPrice += 1;
      if (row.tradeCount === 0) missingTrade += 1;
    }
    coverage[cohort.label] = {
      supplyUniverse: rows.length,
      rankedGuSum: ranked,
      hardExcluded: 0,
      missingPrice,
      missingTradeActivity: missingTrade,
    };
    console.log(JSON.stringify({ stage: "decade", cohort: cohort.label, rows: rows.length }));
  }

  // OVERALL
  const allRows: FeatureSnapshotRowV3[] = [];
  for (const master of masters.values()) {
    const profile = profiles.get(master.complexId)!;
    const complexWide = extractFeaturesV3({
      deals: deals.get(master.complexId) ?? [],
      cohort: null,
      windows,
      profile,
      priceLookbackMonths: config.priceLookbackMonths,
    });
    const decadeScores: number[] = [];
    const lawdMap = decadeStrengthGu.get(master.lawd);
    for (const key of supplyDecades.get(master.complexId) ?? []) {
      const score = lawdMap?.get(key)?.get(master.complexId);
      if (score != null) decadeScores.push(score);
    }
    const decadeMean =
      decadeScores.length > 0 ? decadeScores.reduce((a, b) => a + b, 0) / decadeScores.length : null;
    allRows.push({
      complexId: master.complexId,
      lawdCd: master.lawd,
      bjdongCd: master.bjdong,
      areaBand: "ALL",
      areaBandVersion: AREA_BAND_VERSION_V3,
      period: RANKING_V3_PERIOD,
      transactionAsOf: asOf,
      sourceWindowStart: windows.base12m.startExclusive,
      sourceWindowEnd: windows.base12m.endInclusive,
      recentWindowStart: windows.recent3m.startExclusive,
      recentWindowEnd: windows.recent3m.endInclusive,
      previousWindowStart: windows.previous3m.startExclusive,
      previousWindowEnd: windows.previous3m.endInclusive,
      featureVersion: FEATURE_VERSION_V3,
      identityStatus: master.identityStatus,
      decadeCompetitiveness: decadeMean,
      decadeCompetitivenessAvailability: decadeMean == null ? "MISSING" : "AVAILABLE",
      decadeCount: supplyDecades.get(master.complexId)?.size ?? 0,
      ...featureInputsToSnapshotFields(complexWide),
    });
  }
  const allFeatureRunId = featureRunId({
    transactionAsOf: asOf,
    sourceWindowStart: windows.base12m.startExclusive,
    sourceWindowEnd: windows.base12m.endInclusive,
    recentWindowStart: windows.recent3m.startExclusive,
    recentWindowEnd: windows.recent3m.endInclusive,
    previousWindowStart: windows.previous3m.startExclusive,
    previousWindowEnd: windows.previous3m.endInclusive,
    areaBand: "ALL",
    areaBandVersion: AREA_BAND_VERSION_V3,
    featureVersion: FEATURE_VERSION_V3,
    cohortInputId: sha256Hex(`v3-all-${allRows.length}`),
  });
  featureIds.ALL = allFeatureRunId;

  let overallGuRanked = 0;
  let overallDongRanked = 0;
  for (const lawd of lawds) {
    const cohortRows = allRows.filter((row) => row.lawdCd === lawd);
    const scored = scoreCohortV3({
      featureRunId: allFeatureRunId,
      rows: cohortRows,
      regionScope: "gu",
      regionCode: lawd,
      config,
      privateConfigFingerprint: loaded.fingerprint,
      rankingVersion: RANKING_V3_VERSION,
      useDecadeCompetitiveness: true,
    });
    if (!scored.ok) throw new Error("all score failed");
    overallGuRanked += scored.baseEligible;
    publications.push({
      regionScope: "gu",
      regionCode: lawd,
      areaBand: "ALL",
      rankingRunId: rankingRunId({
        featureRunId: allFeatureRunId,
        rankingVersion: RANKING_V3_VERSION,
        privateConfigFingerprint: loaded.fingerprint,
        regionScope: "gu",
        regionCode: lawd,
      }),
      featureRunId: allFeatureRunId,
    });
    rankingRows.push(...scored.rows.map((row) => ({ ...row, regionCode: lawd })));
    const dongs = [...new Set(cohortRows.map((row) => row.bjdongCd))];
    for (const bjdong of dongs) {
      const members = cohortRows.filter((row) => row.bjdongCd === bjdong);
      const dongCode = `${lawd}${bjdong}`;
      const dong = scoreCohortV3({
        featureRunId: allFeatureRunId,
        rows: members,
        regionScope: "dong",
        regionCode: bjdong,
        config,
        privateConfigFingerprint: loaded.fingerprint,
        rankingVersion: RANKING_V3_VERSION,
        useDecadeCompetitiveness: true,
      });
      if (!dong.ok) continue;
      overallDongRanked += dong.baseEligible;
      publications.push({
        regionScope: "dong",
        regionCode: dongCode,
        areaBand: "ALL",
        rankingRunId: rankingRunId({
          featureRunId: allFeatureRunId,
          rankingVersion: RANKING_V3_VERSION,
          privateConfigFingerprint: loaded.fingerprint,
          regionScope: "dong",
          regionCode: dongCode,
        }),
        featureRunId: allFeatureRunId,
      });
      for (const row of dong.rows) {
        rankingRows.push({
          ...row,
          regionScope: "dong",
          regionCode: dongCode,
          rankingRunId: rankingRunId({
            featureRunId: allFeatureRunId,
            rankingVersion: RANKING_V3_VERSION,
            privateConfigFingerprint: loaded.fingerprint,
            regionScope: "dong",
            regionCode: dongCode,
          }),
        });
      }
    }
  }

  const jamsilDong = "1171010100";
  const songpa = "11710";
  const jamsilAudit = await auditRegion(db, {
    lawd: songpa,
    bjdong: "10100",
    dongCode: jamsilDong,
    masters,
    supplyDecades,
    rankingRows,
    hardExcluded,
  });
  const songpaAudit = await auditRegion(db, {
    lawd: songpa,
    bjdong: null,
    dongCode: null,
    masters,
    supplyDecades,
    rankingRows,
    hardExcluded,
  });

  const pilotRanks: Record<string, unknown> = {};
  for (const [name, id] of Object.entries(PILOTS)) {
    const overall = rankingRows.find(
      (row) => row.complexId === id && row.areaBand === "ALL" && row.regionScope === "gu" && row.regionCode === masters.get(id)?.lawd,
    );
    const decades = rankingRows.filter(
      (row) => row.complexId === id && row.areaBand !== "ALL" && row.regionScope === "gu" && row.regionCode === masters.get(id)?.lawd,
    );
    pilotRanks[name] = {
      overallGu: overall?.rank ?? null,
      coverage: overall?.publicDisplayMetrics.coverage_status ?? null,
      priceAvailability: overall?.publicDisplayMetrics.price_availability ?? null,
      tradeCount: overall?.publicDisplayMetrics.trade_count ?? null,
      decades: decades.map((row) => ({
        band: row.areaBand,
        rank: row.rank,
        trades: row.publicDisplayMetrics.trade_count,
        price: row.publicDisplayMetrics.price_availability,
      })),
      decadeCount: supplyDecades.get(id)?.size ?? 0,
    };
  }

  const pathological: string[] = [];
  for (const [name, info] of Object.entries(pilotRanks)) {
    const row = info as {
      overallGu: number | null;
      tradeCount: number | null;
      priceAvailability: string | null;
      decadeCount: number;
    };
    if (row.overallGu === 1 && row.tradeCount === 0 && row.priceAvailability === "MISSING") {
      pathological.push(`${name}:#1_no_price_no_trade`);
    }
  }
  const els = pilotRanks.잠실엘스 as
    | { overallGu: number | null; decadeCount: number }
    | undefined;
  if (els && els.decadeCount <= 3 && els.overallGu == null) pathological.push("잠실엘스:missing_overall");

  const duplicateKeys = (() => {
    const seen = new Set<string>();
    let dup = 0;
    for (const row of rankingRows) {
      const key = `${row.rankingRunId}|${row.regionScope}|${row.regionCode}|${row.complexId}|${row.areaBand}|${row.period}`;
      if (seen.has(key)) dup += 1;
      seen.add(key);
    }
    return dup;
  })();

  const report = {
    apply: APPLY,
    version: RANKING_V3_VERSION,
    methodologyFingerprint: METHODOLOGY_FINGERPRINT_V3,
    configFingerprint: loaded.fingerprint,
    asOf,
    seoulMasterCanonical: masters.size + hardExcluded.size,
    overallCandidates: masters.size,
    hardExcluded: hardExcluded.size,
    hardExcludedReasons: countReasons(hardExcluded),
    coverage,
    overall: { guRankedSum: overallGuRanked, dongRankedSum: overallDongRanked },
    jamsil: jamsilAudit,
    songpa: songpaAudit,
    pilots: pilotRanks,
    pathological,
    duplicateKeys,
    rankingRowCount: rankingRows.length,
    publicationCount: publications.length,
    featureIds,
    gatesPass: duplicateKeys === 0 && pathological.length === 0 && masters.size > 0,
  };
  mkdirSync("/tmp/building-hub-bulk/external-evidence", { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: REPORT, gatesPass: report.gatesPass, pathological, duplicateKeys, rows: rankingRows.length }));

  if (!report.gatesPass) {
    process.exitCode = 2;
    return;
  }
  if (!APPLY) {
    console.log("dry-run only");
    return;
  }

  const beforeV2 = num(
    (await db.execute(`SELECT COUNT(*) n FROM region_complex_rankings WHERE ranking_version='seoul-ranking-v2'`)).rows[0]?.n,
  );
  const beforeV3 = num(
    (await db.execute(`SELECT COUNT(*) n FROM region_complex_rankings WHERE ranking_version=?`, [RANKING_V3_VERSION])).rows[0]?.n,
  );
  const now = new Date().toISOString();

  // Features
  const featureStmts = [];
  for (const [band, rows] of [["ALL", allRows] as const, ...[...decadeRows.entries()].map((entry) => entry as [string, FeatureSnapshotRowV3[]])]) {
    const runId = featureIds[band]!;
    for (const row of rows) {
      featureStmts.push({
        sql: `INSERT INTO ranking_feature_snapshots (
                feature_run_id, complex_id, lawd_cd, bjdong_cd, area_band, area_band_version, period,
                transaction_as_of, source_window_start, source_window_end, recent_window_start, recent_window_end,
                previous_window_start, previous_window_end, median_price_per_sqm, median_deal_amount, trade_count,
                household_count, turnover, active_month_count, latest_deal_date, recent_3m_trade_count,
                previous_3m_trade_count, recent_3m_median_price_per_sqm, previous_3m_median_price_per_sqm,
                feature_version, profile_source, profile_confidence, eligible_input, exclusion_reason, calculated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(feature_run_id, complex_id, area_band, period) DO NOTHING`,
        args: [
          runId,
          row.complexId,
          row.lawdCd,
          row.bjdongCd,
          row.areaBand,
          row.areaBandVersion,
          row.period,
          row.transactionAsOf,
          row.sourceWindowStart,
          row.sourceWindowEnd,
          row.recentWindowStart,
          row.recentWindowEnd,
          row.previousWindowStart,
          row.previousWindowEnd,
          row.medianPricePerMarketPyeong,
          row.medianDealAmount,
          row.tradeCount,
          row.householdCount,
          row.turnover,
          row.activeMonthCount,
          row.latestDealDate,
          row.recent3mTradeCount,
          row.previous3mTradeCount,
          null,
          null,
          row.featureVersion,
          row.profileSource,
          row.profileConfidence,
          1,
          null,
          now,
        ],
      });
    }
  }
  await runBatches(db, featureStmts, "features");

  const rankStmts = rankingRows.map((row) => ({
    sql: `INSERT INTO region_complex_rankings (
            ranking_run_id, region_scope, region_code, complex_id, area_band, period, feature_run_id,
            "rank", region_total, confidence_bucket, eligible, exclusion_reason, ranking_version,
            transaction_as_of, calculated_at, public_display_metrics_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(ranking_run_id, region_scope, region_code, complex_id, area_band, period) DO NOTHING`,
    args: [
      row.rankingRunId,
      row.regionScope,
      row.regionCode,
      row.complexId,
      row.areaBand,
      row.period,
      row.featureRunId,
      row.rank,
      row.regionTotal,
      row.confidenceBucket,
      row.eligible ? 1 : 0,
      row.exclusionReason,
      row.rankingVersion,
      row.transactionAsOf,
      now,
      JSON.stringify(row.publicDisplayMetrics),
    ],
  }));
  await runBatches(db, rankStmts, "rankings");

  const pubStmts = publications.map((row) => ({
    sql: `INSERT INTO region_ranking_publications (
            region_scope, region_code, area_band, period, active_ranking_run_id, feature_run_id,
            ranking_version, transaction_as_of, published_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      RANKING_V3_PERIOD,
      row.rankingRunId,
      row.featureRunId,
      RANKING_V3_VERSION,
      asOf,
      now,
    ],
  }));
  await runBatches(db, pubStmts, "publications");

  const afterV2 = num(
    (await db.execute(`SELECT COUNT(*) n FROM region_complex_rankings WHERE ranking_version='seoul-ranking-v2'`)).rows[0]?.n,
  );
  const afterV3 = num(
    (await db.execute({ sql: `SELECT COUNT(*) n FROM region_complex_rankings WHERE ranking_version=?`, args: [RANKING_V3_VERSION] })).rows[0]?.n,
  );
  const delta = {
    v3Rows: afterV3 - beforeV3,
    v2Rows: afterV2 - beforeV2,
    afterV3,
    publications: publications.length,
  };
  writeFileSync(REPORT, JSON.stringify({ ...report, delta }, null, 2));
  console.log(JSON.stringify({ delta }));
  if (delta.v2Rows !== 0) throw new Error("v2 rankings mutated");
}

function countReasons(map: Map<string, string>) {
  const out: Record<string, number> = {};
  for (const reason of map.values()) out[reason] = (out[reason] ?? 0) + 1;
  return out;
}

async function runBatches(db: Client, statements: Array<{ sql: string; args: Array<string | number | null> }>, stage: string) {
  for (let i = 0; i < statements.length; i += BATCH) {
    const slice = statements.slice(i, i + BATCH);
    let last: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await db.batch(slice, "write");
        last = null;
        break;
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
    if (last) throw last;
    if ((i + BATCH) % 800 === 0 || i + BATCH >= statements.length) {
      console.log(JSON.stringify({ stage, done: Math.min(i + BATCH, statements.length), total: statements.length }));
    }
  }
}

async function auditRegion(
  db: Client,
  params: {
    lawd: string;
    bjdong: string | null;
    dongCode: string | null;
    masters: Map<string, Master>;
    supplyDecades: Map<string, Set<string>>;
    rankingRows: PublicRankingRowV3[];
    hardExcluded: Map<string, string>;
  },
) {
  const canonical = [...params.masters.values()].filter(
    (row) => row.lawd === params.lawd && (params.bjdong == null || row.bjdong === params.bjdong),
  );
  const supply30 = canonical.filter((row) => params.supplyDecades.get(row.complexId)?.has("30")).length;
  const overall = params.rankingRows.filter(
    (row) =>
      row.areaBand === "ALL" &&
      row.eligible &&
      row.rank != null &&
      ((params.dongCode && row.regionScope === "dong" && row.regionCode === params.dongCode) ||
        (!params.dongCode && row.regionScope === "gu" && row.regionCode === params.lawd)),
  );
  const decade30 = params.rankingRows.filter(
    (row) =>
      row.areaBand === "30" &&
      row.eligible &&
      row.rank != null &&
      ((params.dongCode && row.regionScope === "dong" && row.regionCode === params.dongCode) ||
        (!params.dongCode && row.regionScope === "gu" && row.regionCode === params.lawd)),
  );
  const old = await db.execute({
    sql: `SELECT p.area_band, COUNT(*) c
          FROM region_ranking_publications p
          JOIN region_complex_rankings r ON r.ranking_run_id = p.active_ranking_run_id
          WHERE p.region_scope=? AND p.region_code=? AND p.period='12M' AND p.ranking_version='seoul-ranking-v2'
            AND r.eligible=1 AND r."rank" IS NOT NULL
          GROUP BY p.area_band`,
    args: [params.dongCode ? "dong" : "gu", params.dongCode ?? params.lawd],
  });
  const oldByBand = Object.fromEntries(old.rows.map((row) => [String(row.area_band), Number(row.c)]));
  const ranks = overall
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .slice(0, 15)
    .map((row) => ({
      complexId: row.complexId,
      rank: row.rank,
      trades: row.publicDisplayMetrics.trade_count,
      price: row.publicDisplayMetrics.price_availability,
      coverage: row.publicDisplayMetrics.coverage_status,
    }));
  return {
    canonical: canonical.length,
    overallRanked: overall.length,
    oldOverall: oldByBand.ALL ?? 0,
    supply30,
    decade30Ranked: decade30.length,
    old84: oldByBand["84"] ?? 0,
    hardExcluded: 0,
    ranks,
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
