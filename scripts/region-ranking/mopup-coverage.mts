/**
 * Targeted coverage mop-up. Does not rescore already published cells.
 * Usage: npx tsx scripts/region-ranking/mopup-coverage.mts [--apply]
 */
import { readFileSync, existsSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { SEOUL_REGIONS } from "../../src/lib/constants/regions-registry";
import { classifyProductCoverage, aggregateAll, type AllBandId, type AllBandStrength, type AllPrivateConfig } from "../../src/lib/region-ranking/all-aggregate";
import { householdFromTitleRows, type TitleRow } from "../../src/lib/region-ranking/ledger-household";
import { loadPrivateConfig, type RankingPrivateConfig } from "../../src/lib/region-ranking/private-config";
import { featureRunId, rankingRunId, cohortInputId, sha256Hex } from "../../src/lib/region-ranking/run-identity";
import { percentileRank, priceGateMode, rankWithTopTierSlots, scoreCohort, type FeatureSnapshotRow } from "../../src/lib/region-ranking/score";
import { AREA_BAND_VERSION, AREA_BANDS_V1, type AreaBandDef } from "../../src/lib/region-ranking/area-band";

const P1 = "19ba3623e8187a35f763a0a44e6c37ba568c8322e5b6e5c82c761c9a632c7835";
const VERSION = "seoul-ranking-v2";
const APPLY = process.argv.includes("--apply");
const LAWD = SEOUL_REGIONS.map((region) => region.lawdCodes[0]!);
const GU = new Map(SEOUL_REGIONS.map((region) => [region.lawdCodes[0]!, region.name]));
const HOLD_84 = ["11110", "11140", "11200", "11230", "11260", "11290", "11380", "11410", "11440", "11470", "11500", "11530", "11560", "11620", "11740"];
const ALL_HOLD = ["11110", "11200", "11440", "11560", "11650"];
const BANDS = ["59", "84", "114"] as const;
type BandId = (typeof BANDS)[number];

type Fill = { household: number; source: string; confidence: "HIGH" | "MEDIUM"; key: string };

function norm(value: string): string {
  return value.replace(/\s+/g, "").replace(/아파트$/, "");
}
function daysSince(deal: string, asOf: string): number {
  return Math.round((Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`) - Date.parse(`${deal.slice(0, 10)}T00:00:00Z`)) / 86400000);
}
function likely(row: FeatureSnapshotRow, config: RankingPrivateConfig): boolean {
  if (row.tradeCount < config.minTradeCount) return false;
  if (row.activeMonthCount < config.minActiveMonths) return false;
  if (!row.latestDealDate) return false;
  if (daysSince(row.latestDealDate, row.transactionAsOf) > config.maxRecencyDays) return false;
  return true;
}
function padLot(jibun: string) {
  const mountain = /^\s*산/.test(jibun);
  const raw = jibun.replace(/^산\s*/, "").trim();
  if (!raw) return null;
  const [bun, ji] = raw.split("-");
  if (!bun || !/^[0-9]+$/.test(bun)) return null;
  if (ji != null && ji !== "" && !/^[0-9]+$/.test(ji)) return null;
  return { plat: mountain ? "1" : "0", bun: String(Number(bun)).padStart(4, "0"), ji: String(Number(ji || 0)).padStart(4, "0") };
}
function rankIssues(ranks: number[]) {
  const sorted = [...ranks].sort((a, b) => a - b);
  return sorted.length > 0 && sorted.every((rank, index) => rank === index + 1) && new Set(sorted).size === sorted.length;
}

function snapshot(row: Record<string, unknown>, identity: string | null): FeatureSnapshotRow {
  const household = row.household_count == null ? null : Number(row.household_count);
  return {
    complexId: String(row.complex_id),
    lawdCd: String(row.lawd_cd),
    bjdongCd: String(row.bjdong_cd),
    areaBand: String(row.area_band),
    areaBandVersion: String(row.area_band_version),
    period: "12M",
    transactionAsOf: String(row.transaction_as_of).slice(0, 10),
    sourceWindowStart: String(row.source_window_start),
    sourceWindowEnd: String(row.source_window_end),
    recentWindowStart: String(row.recent_window_start),
    recentWindowEnd: String(row.recent_window_end),
    previousWindowStart: String(row.previous_window_start),
    previousWindowEnd: String(row.previous_window_end),
    medianPricePerSqm: row.median_price_per_sqm == null ? null : Number(row.median_price_per_sqm),
    medianDealAmount: row.median_deal_amount == null ? null : Number(row.median_deal_amount),
    tradeCount: Number(row.trade_count),
    householdCount: household != null && household > 0 ? household : null,
    turnover: row.turnover == null ? null : Number(row.turnover),
    activeMonthCount: Number(row.active_month_count),
    latestDealDate: row.latest_deal_date == null ? null : String(row.latest_deal_date).slice(0, 10),
    recent3mTradeCount: Number(row.recent_3m_trade_count),
    previous3mTradeCount: Number(row.previous_3m_trade_count),
    recent3mMedianPricePerSqm: row.recent_3m_median_price_per_sqm == null ? null : Number(row.recent_3m_median_price_per_sqm),
    previous3mMedianPricePerSqm: row.previous_3m_median_price_per_sqm == null ? null : Number(row.previous_3m_median_price_per_sqm),
    featureVersion: String(row.feature_version),
    profileSource: row.profile_source == null ? null : String(row.profile_source),
    profileConfidence: (row.profile_confidence == null ? "MISSING" : String(row.profile_confidence)) as FeatureSnapshotRow["profileConfidence"],
    identityStatus: identity,
  };
}

function applyFill(row: FeatureSnapshotRow, fill: Fill | undefined): FeatureSnapshotRow {
  if (!fill || (row.householdCount != null && row.householdCount > 0)) return row;
  return {
    ...row,
    householdCount: fill.household,
    turnover: fill.household > 0 ? row.tradeCount / fill.household : null,
    profileSource: fill.source,
    profileConfidence: fill.confidence,
  };
}

async function main() {
  const loaded = loadPrivateConfig(JSON.parse(readFileSync("/tmp/seoul-p1.json", "utf8")));
  if (!loaded.ok || loaded.fingerprint !== P1) {
    console.log(JSON.stringify({ status: "FINGERPRINT_MISMATCH" }));
    process.exit(2);
  }
  const allConfigs = JSON.parse(readFileSync("/tmp/seoul-all-configs.json", "utf8")) as AllPrivateConfig[];
  const allConfig = allConfigs.find((row) => row.method === "reliability_weighted_mean");
  if (!allConfig) throw new Error("ALL_CONFIG");
  const manifest = JSON.parse(readFileSync("data/poc/region-ranking/seoul-launch-manifest.json", "utf8")) as {
    feature_run_id: Record<BandId, string>;
  };
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const runs = manifest.feature_run_id;
  const rows = await loadRows(db, Object.values(runs));
  const masters = await loadMasters(db, [...new Set(rows.map((row) => row.complexId))]);
  const blockers = rows.filter((row) => {
    if (ALL_HOLD.includes(row.lawdCd)) return true;
    return HOLD_LAWDS[row.areaBand as BandId]?.includes(row.lawdCd) ?? false;
  });
  const targeted = new Set(
    blockers
      .filter((row) => likely(row, loaded.config) && !(row.householdCount != null && row.householdCount > 0))
      .map((row) => row.complexId),
  );
  const fills = resolveFills(blockers, masters, loaded.config);
  const overlay = new Map<string, Fill>();
  let conflicts = 0;
  for (const [id, candidates] of fills) {
    const households = new Set(candidates.map((item) => item.household));
    if (households.size > 1) {
      conflicts += 1;
      continue;
    }
    overlay.set(id, candidates[0]!);
  }
  const byBand = new Map<BandId, FeatureSnapshotRow[]>();
  for (const band of BANDS) byBand.set(band, rows.filter((row) => row.areaBand === band).map((row) => applyFill(row, overlay.get(row.complexId))));
  const published = await publishedSet(db);
  const bandReport: Record<string, { before: number; after: number; newly: string[]; hold: string[] }> = {};
  const toPublish: Array<{ band: BandId; lawd: string; rows: FeatureSnapshotRow[] }> = [];
  for (const band of BANDS) {
    const holdLawds = HOLD_LAWDS[band];
    const before = holdLawds.filter((lawd) => !published.has(`${lawd}|${band}`));
    const newly: string[] = [];
    const hold: string[] = [];
    for (const lawd of before) {
      const cohort = byBand.get(band)!.filter((row) => row.lawdCd === lawd);
      const afterCov = coverage(cohort, loaded.config);
      if (afterCov < 0.95) {
        hold.push(GU.get(lawd) ?? lawd);
        continue;
      }
      const scored = scoreGu(cohort, runs[band], lawd, loaded.config, loaded.fingerprint);
      const again = scoreGu(cohort, runs[band], lawd, loaded.config, loaded.fingerprint);
      const ranks = scored.ok ? scored.constrainedOrder.map((item) => item.rank) : [];
      if (
        !scored.ok
        || !again.ok
        || JSON.stringify(scored.constrainedOrder) !== JSON.stringify(again.constrainedOrder)
        || !rankIssues(ranks)
        || scored.constrainedOrder.length !== scored.baseEligible
      ) {
        hold.push(GU.get(lawd) ?? lawd);
        continue;
      }
      newly.push(GU.get(lawd) ?? lawd);
      toPublish.push({ band, lawd, rows: cohort });
    }
    bandReport[band] = {
      before: 25 - before.length,
      after: 25 - before.length + newly.length,
      newly,
      hold,
    };
  }
  const allFingerprint = sha256Hex(JSON.stringify(allConfig));
  const allReport = await judgeAll(db, byBand, loaded.config, loaded.fingerprint, allConfig, allFingerprint, masters);
  const fillSources = { kapt: 0, ledger: 0 };
  for (const fill of overlay.values()) {
    if (fill.source === "AptBasisInfoServiceV5") fillSources.kapt += 1;
    else fillSources.ledger += 1;
  }
  console.log(JSON.stringify({
    targeted: targeted.size,
    newly_resolved: overlay.size,
    unresolved: targeted.size - overlay.size - conflicts,
    conflicts,
    fill_sources: fillSources,
    band: bandReport,
    all: allReport.map((row) => ({ gu: row.gu, status: row.status, reason: row.reason })),
    apply: APPLY,
  }, null, 2));
  if (!APPLY) {
    db.close();
    return;
  }
  const profileWrites = await writeProfiles(db, overlay, masters);
  let publications = 0;
  const newRuns: string[] = [];
  for (const band of BANDS) {
    const cells = toPublish.filter((row) => row.band === band);
    if (cells.length === 0) continue;
    const cohort = cells.flatMap((row) => row.rows);
    const runId = featureRunId({
      transactionAsOf: cohort[0]!.transactionAsOf,
      sourceWindowStart: cohort[0]!.sourceWindowStart,
      sourceWindowEnd: cohort[0]!.sourceWindowEnd,
      recentWindowStart: cohort[0]!.recentWindowStart,
      recentWindowEnd: cohort[0]!.recentWindowEnd,
      previousWindowStart: cohort[0]!.previousWindowStart,
      previousWindowEnd: cohort[0]!.previousWindowEnd,
      areaBand: band,
      areaBandVersion: AREA_BAND_VERSION,
      featureVersion: cohort[0]!.featureVersion,
      cohortInputId: cohortInputId(cohort.map((row) => ({
        complexId: row.complexId,
        householdCount: row.householdCount,
        profileConfidence: row.profileConfidence,
        cohortOrigin: "SEOUL_COVERAGE_MOPUP",
      }))),
    });
    const again = scoreGu(cells[0]!.rows, runId, cells[0]!.lawd, loaded.config, loaded.fingerprint);
    const once = scoreGu(cells[0]!.rows, runId, cells[0]!.lawd, loaded.config, loaded.fingerprint);
    if (!once.ok || !again.ok || JSON.stringify(once.constrainedOrder) !== JSON.stringify(again.constrainedOrder)) {
      throw new Error("DETERMINISM_FAIL");
    }
    await insertFeatures(db, runId, cohort);
    for (const cell of cells) {
      const scored = scoreGu(cell.rows, runId, cell.lawd, loaded.config, loaded.fingerprint);
      if (!scored.ok) continue;
      await insertRankings(db, scored.rows, runId, "gu", cell.lawd, band, cell.rows[0]!.transactionAsOf);
      await upsertPublication(db, "gu", cell.lawd, band, scored.rankingRunId, runId, cell.rows[0]!.transactionAsOf);
      publications += 1;
      newRuns.push(scored.rankingRunId);
      const dongs = [...new Set(cell.rows.map((row) => row.bjdongCd))];
      for (const bjdong of dongs) {
        const members = cell.rows.filter((row) => row.bjdongCd === bjdong);
        const dong = scoreCohort({
          featureRunId: runId,
          rows: members,
          regionScope: "dong",
          regionCode: bjdong,
          config: loaded.config,
          privateConfigFingerprint: loaded.fingerprint,
          rankingVersion: VERSION,
        });
        if (!dong.ok) continue;
        const ranks = dong.constrainedOrder.map((item) => item.rank);
        if (!rankIssues(ranks)) continue;
        const code = `${cell.lawd}${bjdong}`;
        const dongRun = rankingRunId({
          featureRunId: runId,
          rankingVersion: VERSION,
          privateConfigFingerprint: loaded.fingerprint,
          regionScope: "dong",
          regionCode: code,
        });
        await insertRankings(db, dong.rows.map((row) => ({ ...row, rankingRunId: dongRun, regionCode: code })), runId, "dong", code, band, members[0]!.transactionAsOf);
        await upsertPublication(db, "dong", code, band, dongRun, runId, members[0]!.transactionAsOf);
        publications += 1;
      }
    }
  }
  for (const item of allReport) {
    if (item.status !== "PASS" || published.has(`${item.lawd}|ALL`)) continue;
    const guRanks = item.guRows.map((row) => row.rank).filter((rank): rank is number => rank != null);
    if (!rankIssues(guRanks) || guRanks.length !== item.guRows.length) throw new Error("ALL_RANK_FAIL");
    await insertRankings(db, item.guRows, item.featureRunId, "gu", item.lawd, "ALL", "2026-09-17", item.guRun);
    await upsertPublication(db, "gu", item.lawd, "ALL", item.guRun, item.featureRunId, "2026-09-17");
    publications += 1;
    newRuns.push(item.guRun);
    for (const dong of item.dongs) {
      const dongRanks = dong.rows.map((row) => row.rank).filter((rank): rank is number => rank != null);
      if (!rankIssues(dongRanks) || dongRanks.length !== dong.rows.length) continue;
      await insertRankings(db, dong.rows, item.featureRunId, "dong", dong.code, "ALL", "2026-09-17", item.guRun);
      await upsertPublication(db, "dong", dong.code, "ALL", item.guRun, item.featureRunId, "2026-09-17");
      publications += 1;
    }
  }
  console.log(JSON.stringify({ wrote: true, profileWrites, publications, runs: newRuns.length }));
  db.close();
}

const HOLD_LAWDS: Record<BandId, string[]> = {
  "59": ["11140", "11170", "11200", "11215", "11230", "11260", "11290", "11350", "11380", "11410", "11440", "11470", "11500", "11530", "11560", "11620", "11740"],
  "84": HOLD_84,
  "114": ["11140", "11200", "11530", "11620", "11680"],
};

function coverage(rows: FeatureSnapshotRow[], config: RankingPrivateConfig): number {
  const set = rows.filter((row) => likely(row, config));
  if (set.length === 0) return 1;
  return set.filter((row) => row.householdCount != null && row.householdCount > 0).length / set.length;
}

function scoreGu(rows: FeatureSnapshotRow[], featureId: string, lawd: string, config: RankingPrivateConfig, fingerprint: string) {
  return scoreCohort({
    featureRunId: featureId,
    rows,
    regionScope: "gu",
    regionCode: lawd,
    config,
    privateConfigFingerprint: fingerprint,
    rankingVersion: VERSION,
  });
}

async function loadRows(db: Client, runIds: string[]) {
  const out: FeatureSnapshotRow[] = [];
  for (const runId of runIds) {
    const result = await db.execute({
      sql: `SELECT f.*, m.identity_status
            FROM ranking_feature_snapshots f
            JOIN apt_complex_master m ON m.complex_id = f.complex_id
            WHERE f.feature_run_id = ?`,
      args: [runId],
    });
    for (const row of result.rows) out.push(snapshot(row, row.identity_status == null ? null : String(row.identity_status)));
  }
  return out;
}

async function loadMasters(db: Client, ids: string[]) {
  const out = new Map<string, { name: string; lawd: string; bjdong: string; jibun: string }>();
  for (let i = 0; i < ids.length; i += 80) {
    const slice = ids.slice(i, i + 80);
    const result = await db.execute({
      sql: `SELECT complex_id, apt_name_norm, lawd_cd, bjdong_cd, jibun FROM apt_complex_master
            WHERE complex_id IN (${slice.map(() => "?").join(",")})`,
      args: slice,
    });
    for (const row of result.rows) {
      out.set(String(row.complex_id), {
        name: String(row.apt_name_norm),
        lawd: String(row.lawd_cd),
        bjdong: String(row.bjdong_cd),
        jibun: row.jibun == null ? "" : String(row.jibun),
      });
    }
  }
  return out;
}

function resolveFills(
  blockers: FeatureSnapshotRow[],
  masters: Map<string, { name: string; lawd: string; bjdong: string; jibun: string }>,
  config: RankingPrivateConfig,
) {
  const nameIndex = new Map<string, Set<string>>();
  const lotIndex = new Map<string, Set<string>>();
  const officialNames = new Map<string, string>();
  if (existsSync("/tmp/national-inputs/kapt-complex-universe.jsonl")) {
    for (const line of readFileSync("/tmp/national-inputs/kapt-complex-universe.jsonl", "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { lawd_cd?: string; bjdong_code?: string; apt_name?: string; kapt_code?: string; parcel_address?: string };
      if (!row.kapt_code || !row.lawd_cd || !LAWD.includes(row.lawd_cd)) continue;
      officialNames.set(row.kapt_code, row.apt_name ?? "");
      const key = `${row.lawd_cd}|${row.bjdong_code}|${norm(row.apt_name ?? "")}`;
      const set = nameIndex.get(key) ?? new Set<string>();
      set.add(row.kapt_code);
      nameIndex.set(key, set);
      const re = /(?:동[0-9]*가|동|리)\s+([0-9]+(?:-[0-9]+)?)/g;
      for (const match of String(row.parcel_address ?? "").matchAll(re)) {
        const lotKey = `${row.lawd_cd}|${row.bjdong_code}|${match[1]}`;
        const lots = lotIndex.get(lotKey) ?? new Set<string>();
        lots.add(row.kapt_code);
        lotIndex.set(lotKey, lots);
      }
    }
  }
  const cache = existsSync("/tmp/seoul-kapt-basis-cache.json")
    ? JSON.parse(readFileSync("/tmp/seoul-kapt-basis-cache.json", "utf8")) as Record<string, { household: number | null; field?: string }>
    : {};
  const ledger = existsSync("/tmp/seoul-ledger-cache.json")
    ? JSON.parse(readFileSync("/tmp/seoul-ledger-cache.json", "utf8")) as Record<string, { complete: boolean; rows: TitleRow[] }>
    : {};
  const parcelOwners = new Map<string, number>();
  for (const master of masters.values()) {
    const lot = padLot(master.jibun);
    if (!lot) continue;
    const key = `${master.lawd}|${master.bjdong}|${lot.plat}|${lot.bun}|${lot.ji}`;
    parcelOwners.set(key, (parcelOwners.get(key) ?? 0) + 1);
  }
  const codeOwners = new Map<string, number>();
  for (const master of masters.values()) {
    const code = kaptCode(master, nameIndex, lotIndex, officialNames);
    if (code) codeOwners.set(code, (codeOwners.get(code) ?? 0) + 1);
  }
  const out = new Map<string, Fill[]>();
  for (const row of blockers) {
    if (row.householdCount != null && row.householdCount > 0) continue;
    if (out.has(row.complexId)) continue;
    if (!likely(row, config)) continue;
    const master = masters.get(row.complexId);
    if (!master) continue;
    const list: Fill[] = [];
    const code = kaptCode(master, nameIndex, lotIndex, officialNames);
    if (code && (codeOwners.get(code) ?? 0) === 1 && cache[code]?.household) {
      list.push({
        household: cache[code]!.household!,
        source: "AptBasisInfoServiceV5",
        confidence: cache[code]!.field === "hoCnt" ? "MEDIUM" : "HIGH",
        key: code,
      });
    }
    const lot = padLot(master.jibun);
    const parcel = lot ? `${master.lawd}|${master.bjdong}|${lot.plat}|${lot.bun}|${lot.ji}` : null;
    const entry = parcel ? ledger[parcel] : undefined;
    if (parcel && parcelOwners.get(parcel) === 1 && entry?.complete) {
      const household = householdFromTitleRows(entry.rows, master.name);
      if (household != null) {
        list.push({ household, source: "BldRgstHubService", confidence: "MEDIUM", key: parcel.replace(/\|/g, "") });
      }
    }
    if (list.length) out.set(row.complexId, list);
  }
  return out;
}

function kaptCode(
  master: { name: string; lawd: string; bjdong: string; jibun: string },
  nameIndex: Map<string, Set<string>>,
  lotIndex: Map<string, Set<string>>,
  officialNames: Map<string, string>,
): string | null {
  const named = nameIndex.get(`${master.lawd}|${master.bjdong}|${norm(master.name)}`);
  const lots = new Set<string>();
  if (master.jibun) for (const code of lotIndex.get(`${master.lawd}|${master.bjdong}|${master.jibun}`) ?? []) lots.add(code);
  let code: string | null = null;
  if (named && named.size === 1 && lots.size === 1 && [...named][0] === [...lots][0]) code = [...named][0]!;
  else if (lots.size === 1 && (!named || named.size === 0)) code = [...lots][0]!;
  else if (named && named.size === 1 && lots.size === 0) code = [...named][0]!;
  if (!code) return null;
  const official = norm(officialNames.get(code) ?? "");
  const self = norm(master.name);
  const combined = ((official.includes("1차") && official.includes("2차")) || official.includes("1,2"))
    && !((self.includes("1차") && self.includes("2차")) || self.includes("1,2"));
  return combined ? null : code;
}

async function publishedSet(db: Client) {
  const result = await db.execute("SELECT region_code, area_band FROM region_ranking_publications WHERE region_scope = 'gu'");
  return new Set(result.rows.map((row) => `${row.region_code}|${row.area_band}`));
}

async function judgeAll(
  db: Client,
  byBand: Map<BandId, FeatureSnapshotRow[]>,
  config: RankingPrivateConfig,
  fingerprint: string,
  allConfig: AllPrivateConfig,
  allFingerprint: string,
  masters: Map<string, { name: string; lawd: string; bjdong: string; jibun: string }>,
) {
  const expected = await expectedBands(db, ALL_HOLD);
  const reports = [];
  for (const lawd of ALL_HOLD) {
    const strengths = new Map<string, AllBandStrength[]>();
    const meta = new Map<string, FeatureSnapshotRow>();
    const exclusion = new Map<string, string | null>();
    for (const band of BANDS) {
      const cohort = byBand.get(band)!.filter((row) => row.lawdCd === lawd);
      const scored = scoreGu(cohort, "analysis", lawd, config, fingerprint);
      if (!scored.ok) continue;
      for (const item of scored.rows) exclusion.set(`${band}|${item.complexId}`, item.exclusionReason);
      const eligible = cohort.filter((row) => scored.rows.find((item) => item.complexId === row.complexId)?.eligible);
      const prices = eligible.map((row) => row.medianPricePerSqm ?? Number.NEGATIVE_INFINITY);
      for (const row of eligible) {
        const list = strengths.get(row.complexId) ?? [];
        list.push({
          band,
          score: scored.strengthByComplex[row.complexId] ?? 0,
          tradeCount: row.tradeCount,
          activeMonthCount: row.activeMonthCount,
          pricePercentile: percentileRank(row.medianPricePerSqm ?? Number.NEGATIVE_INFINITY, prices),
        });
        strengths.set(row.complexId, list);
        meta.set(row.complexId, row);
      }
    }
    const items = [];
    for (const [complexId, bands] of strengths) {
      const expect = expected.get(complexId) ?? null;
      const usable = expect == null ? bands : bands.filter((band) => expect.includes(band.band));
      const aggregate = aggregateAll(usable, allConfig);
      if (!aggregate) continue;
      const product = classifyProductCoverage(usable.map((band) => band.band), expect);
      const row = meta.get(complexId)!;
      items.push({
        complexId,
        name: masters.get(complexId)?.name ?? complexId,
        bjdong: row.bjdongCd,
        score: aggregate.score,
        topTier: aggregate.topTier,
        tieBreak: row.tradeCount,
        confidence: row.profileConfidence,
        product,
      });
    }
    const mode = priceGateMode("gu", items.length);
    const ranked = rankWithTopTierSlots(items.map((item) => ({
      id: item.complexId,
      score: item.score,
      topTier: item.topTier,
      tieBreak: item.tieBreak,
    })), mode);
    const again = rankWithTopTierSlots(items.map((item) => ({
      id: item.complexId,
      score: item.score,
      topTier: item.topTier,
      tieBreak: item.tieBreak,
    })), mode);
    const rankById = new Map(ranked.map((item) => [item.id, item.rank]));
    const ranks = ranked.map((item) => item.rank);
    const top = items.filter((item) => (rankById.get(item.complexId) ?? 99) <= 5);
    const partial = top.filter((item) => item.product.coverageStatus === "PARTIAL_PRODUCT_COVERAGE").length;
    let status = "PASS";
    if (items.length === 0) status = "HOLD_ALL_EMPTY";
    else if (JSON.stringify(ranked) !== JSON.stringify(again) || !rankIssues(ranks)) status = "HOLD_ALL_RANK_GAP";
    else if (top.length > 0 && partial / top.length > 0.6) status = "HOLD_ALL_PARTIAL_DATA";
    const blockerOf = (complexId: string, band: AllBandId) => {
      const reason = exclusion.get(`${band}|${complexId}`);
      if (reason === "PROFILE_HOUSEHOLD_MISSING") return `${band}:PROFILE`;
      if (reason === "IDENTITY_BELOW_FLOOR") return `${band}:IDENTITY`;
      return `${band}:SAMPLE`;
    };
    const reasons = top
      .filter((item) => item.product.coverageStatus === "PARTIAL_PRODUCT_COVERAGE")
      .map((item) => ({
        name: item.name,
        expected: item.product.expectedBands,
        valid: item.product.validBands,
        missing: (item.product.expectedBands ?? [])
          .filter((band) => !item.product.validBands.includes(band))
          .map((band) => blockerOf(item.complexId, band)),
      }));
    const featureRun = sha256Hex(JSON.stringify({
      kind: "band-aggregate-mopup",
      lawd,
      bands: BANDS.map((band) => byBand.get(band)!
        .filter((row) => row.lawdCd === lawd)
        .map((row) => `${row.complexId}:${row.householdCount ?? "null"}:${row.profileConfidence}`)
        .sort()),
    }));
    const guRun = rankingRunId({
      featureRunId: featureRun,
      rankingVersion: VERSION,
      privateConfigFingerprint: allFingerprint,
      regionScope: "gu",
      regionCode: lawd,
    });
    const coverageMetrics = (product: (typeof items)[number]["product"]) => ({
      expected_band_count: product.expectedBandCount,
      valid_band_count: product.validBandCount,
      expected_bands: product.expectedBands == null ? null : product.expectedBands.join(","),
      valid_bands: product.validBands.join(","),
      coverage_completeness: product.coverageCompleteness,
      coverage_status: product.coverageStatus,
      single_product_band: product.singleProductBand,
    });
    const toRow = (item: (typeof items)[number], rank: number | null, regionTotal: number) => ({
      complexId: item.complexId,
      rank,
      regionTotal,
      confidenceBucket: item.product.coverageStatus === "PARTIAL_PRODUCT_COVERAGE" ? "DATA_COVERAGE_INCOMPLETE" : item.confidence,
      eligible: true,
      exclusionReason: null,
      publicDisplayMetrics: {
        median_price_per_sqm: null,
        median_deal_amount: null,
        trade_count: 0,
        latest_deal_date: null,
      },
      metrics: coverageMetrics(item.product),
    });
    const dongs: Array<{ code: string; rows: ReturnType<typeof toRow>[] }> = [];
    if (status === "PASS") {
      const byDong = new Map<string, typeof items>();
      for (const item of items) {
        const list = byDong.get(item.bjdong) ?? [];
        list.push(item);
        byDong.set(item.bjdong, list);
      }
      for (const [bjdong, members] of byDong) {
        const dongMode = priceGateMode("dong", members.length);
        const dongRanked = rankWithTopTierSlots(members.map((item) => ({
          id: item.complexId,
          score: item.score,
          topTier: dongMode === "NOT_EVALUATED_FOR_SMALL_COHORT" ? false : item.topTier,
          tieBreak: item.tieBreak,
        })), dongMode);
        const dongRanks = dongRanked.map((item) => item.rank);
        if (!rankIssues(dongRanks) || dongRanked.length !== members.length) continue;
        const dongRankById = new Map(dongRanked.map((item) => [item.id, item.rank]));
        dongs.push({
          code: `${lawd}${bjdong}`,
          rows: members.map((item) => toRow(item, dongRankById.get(item.complexId) ?? null, members.length)),
        });
      }
    }
    reports.push({
      lawd,
      gu: GU.get(lawd),
      status,
      reason: status === "PASS" ? [] : reasons,
      featureRunId: featureRun,
      guRun,
      guRows: items.map((item) => toRow(item, rankById.get(item.complexId) ?? null, items.length)),
      dongs,
    });
  }
  return reports;
}

function bandsForSpan(min: number, max: number): AllBandId[] {
  const hits: AllBandId[] = [];
  for (const band of BANDS) {
    const def = AREA_BANDS_V1.find((row) => row.id === band) as AreaBandDef | undefined;
    if (!def || def.exclusiveSqmMin == null || def.exclusiveSqmMax == null) continue;
    if (max >= def.exclusiveSqmMin && min <= def.exclusiveSqmMax) hits.push(band);
  }
  return hits;
}

async function expectedBands(db: Client, lawds: string[]) {
  const expected = new Map<string, Set<AllBandId>>();
  const fromCatalog = new Set<string>();
  const remember = (complexId: string, min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    const set = expected.get(complexId) ?? new Set<AllBandId>();
    for (const band of bandsForSpan(min, max)) set.add(band);
    if (set.size > 0) expected.set(complexId, set);
  };
  for (const lawd of lawds) {
    const unit = await db.execute({
      sql: `SELECT c.complex_id, u.exclusive_area_min, u.exclusive_area_max
            FROM apt_complex_master m
            JOIN apt_complex_classifications c ON c.complex_id = m.complex_id
            JOIN apt_unit_types u ON u.complex_key = c.complex_key
            WHERE m.lawd_cd = ?`,
      args: [lawd],
    });
    for (const row of unit.rows) {
      const id = String(row.complex_id);
      remember(id, Number(row.exclusive_area_min), Number(row.exclusive_area_max));
      if (expected.has(id)) fromCatalog.add(id);
    }
    const groups = await db.execute({
      sql: `SELECT p.complex_id, p.exclusive_area_min, p.exclusive_area_max
            FROM apt_pyeong_groups p
            JOIN apt_complex_master m ON m.complex_id = p.complex_id
            WHERE m.lawd_cd = ?`,
      args: [lawd],
    });
    for (const row of groups.rows) {
      if (row.complex_id == null) continue;
      const id = String(row.complex_id);
      if (fromCatalog.has(id)) continue;
      remember(id, Number(row.exclusive_area_min), Number(row.exclusive_area_max));
      if (expected.has(id)) fromCatalog.add(id);
    }
    const hist = await db.execute({
      sql: `SELECT m.complex_id,
              MAX(CASE WHEN t.exclusive_area >= 55 AND t.exclusive_area <= 65 THEN 1 ELSE 0 END) AS b59,
              MAX(CASE WHEN t.exclusive_area >= 80 AND t.exclusive_area <= 90 THEN 1 ELSE 0 END) AS b84,
              MAX(CASE WHEN t.exclusive_area >= 110 AND t.exclusive_area <= 120 THEN 1 ELSE 0 END) AS b114
            FROM apt_complex_master m
            JOIN transactions t ON t.lawd_cd = m.lawd_cd AND t.apt_name_norm = m.apt_name_norm
            WHERE m.lawd_cd = ? AND t.deal_type = 'trade'
            GROUP BY m.complex_id`,
      args: [lawd],
    });
    for (const row of hist.rows) {
      const id = String(row.complex_id);
      if (fromCatalog.has(id)) continue;
      const set = new Set<AllBandId>();
      if (Number(row.b59) === 1) set.add("59");
      if (Number(row.b84) === 1) set.add("84");
      if (Number(row.b114) === 1) set.add("114");
      if (set.size > 0) expected.set(id, set);
    }
  }
  return new Map([...expected.entries()].map(([id, set]) => [id, [...set].sort() as AllBandId[]]));
}

async function writeProfiles(db: Client, overlay: Map<string, Fill>, masters: Map<string, unknown>) {
  void masters;
  const now = new Date().toISOString();
  let wrote = 0;
  for (const [id, fill] of overlay) {
    const existing = await db.execute({
      sql: "SELECT household_count FROM apt_complex_profile WHERE complex_id = ?",
      args: [id],
    });
    const current = existing.rows[0]?.household_count;
    if (current != null && Number(current) > 0) continue;
    if (existing.rows.length === 0) {
      await db.execute({
        sql: `INSERT INTO apt_complex_profile (complex_id, household_count, source, source_version, raw_meta_json, updated_at)
              VALUES (?, ?, ?, 'seoul-ranking-mopup', ?, ?)`,
        args: [id, fill.household, fill.source, JSON.stringify({ source_key: fill.key }), now],
      });
    } else {
      await db.execute({
        sql: `UPDATE apt_complex_profile
              SET household_count = ?, source = ?, source_version = 'seoul-ranking-mopup', updated_at = ?
              WHERE complex_id = ? AND (household_count IS NULL OR household_count <= 0)`,
        args: [fill.household, fill.source, now, id],
      });
    }
    wrote += 1;
  }
  return wrote;
}

async function insertFeatures(db: Client, runId: string, rows: FeatureSnapshotRow[]) {
  const now = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 40) {
    const slice = rows.slice(i, i + 40).map((row) => ({
      sql: `INSERT INTO ranking_feature_snapshots (
        feature_run_id, complex_id, lawd_cd, bjdong_cd, area_band, area_band_version, period,
        transaction_as_of, source_window_start, source_window_end, recent_window_start, recent_window_end,
        previous_window_start, previous_window_end, median_price_per_sqm, median_deal_amount, trade_count,
        household_count, turnover, active_month_count, latest_deal_date, recent_3m_trade_count, previous_3m_trade_count,
        recent_3m_median_price_per_sqm, previous_3m_median_price_per_sqm, feature_version, profile_source,
        profile_confidence, eligible_input, exclusion_reason, calculated_at
      ) VALUES (${Array(31).fill("?").join(",")})
      ON CONFLICT(feature_run_id, complex_id, area_band, period) DO NOTHING`,
      args: [
        runId, row.complexId, row.lawdCd, row.bjdongCd, row.areaBand, row.areaBandVersion, "12M",
        row.transactionAsOf, row.sourceWindowStart, row.sourceWindowEnd, row.recentWindowStart, row.recentWindowEnd,
        row.previousWindowStart, row.previousWindowEnd, row.medianPricePerSqm, row.medianDealAmount, row.tradeCount,
        row.householdCount, row.turnover, row.activeMonthCount, row.latestDealDate, row.recent3mTradeCount, row.previous3mTradeCount,
        row.recent3mMedianPricePerSqm, row.previous3mMedianPricePerSqm, row.featureVersion, row.profileSource,
        row.profileConfidence, row.householdCount != null && row.householdCount > 0 ? 1 : 0,
        row.householdCount != null && row.householdCount > 0 ? null : "HOUSEHOLD_PROFILE_MISSING",
        now,
      ],
    }));
    await db.batch(slice, "write");
  }
}

async function insertRankings(
  db: Client,
  rows: Array<{ complexId: string; rank: number | null; regionTotal: number; confidenceBucket: string; eligible: boolean; exclusionReason: string | null; publicDisplayMetrics: { median_price_per_sqm: number | null; median_deal_amount: number | null; trade_count: number; latest_deal_date: string | null }; metrics?: unknown }>,
  featureId: string,
  scope: "gu" | "dong",
  regionCode: string,
  band: string,
  asOf: string,
  explicitRunId?: string,
) {
  if (band === "ALL" && !explicitRunId) throw new Error("ALL_RUN_REQUIRED");
  const now = new Date().toISOString();
  const runId = explicitRunId ?? rankingRunId({
    featureRunId: featureId,
    rankingVersion: VERSION,
    privateConfigFingerprint: P1,
    regionScope: scope,
    regionCode,
  });
  for (let i = 0; i < rows.length; i += 40) {
    const slice = rows.slice(i, i + 40).map((row) => ({
      sql: `INSERT INTO region_complex_rankings (
        ranking_run_id, region_scope, region_code, complex_id, area_band, period, feature_run_id,
        "rank", region_total, confidence_bucket, eligible, exclusion_reason, ranking_version,
        transaction_as_of, calculated_at, public_display_metrics_json
      ) VALUES (?, ?, ?, ?, ?, '12M', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ranking_run_id, region_scope, region_code, complex_id, area_band, period) DO NOTHING`,
      args: [
        runId, scope, regionCode, row.complexId, band, featureId, row.rank, row.regionTotal,
        row.confidenceBucket, row.eligible ? 1 : 0, row.exclusionReason, VERSION, asOf, now,
        JSON.stringify(row.metrics ?? row.publicDisplayMetrics),
      ],
    }));
    await db.batch(slice, "write");
  }
  return runId;
}

async function upsertPublication(db: Client, scope: string, code: string, band: string, runId: string, featureId: string, asOf: string) {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO region_ranking_publications (
            region_scope, region_code, area_band, period, active_ranking_run_id, feature_run_id,
            ranking_version, transaction_as_of, published_at
          ) VALUES (?, ?, ?, '12M', ?, ?, ?, ?, ?)
          ON CONFLICT(region_scope, region_code, area_band, period) DO UPDATE SET
            active_ranking_run_id = excluded.active_ranking_run_id,
            feature_run_id = excluded.feature_run_id,
            ranking_version = excluded.ranking_version,
            transaction_as_of = excluded.transaction_as_of,
            published_at = excluded.published_at`,
    args: [scope, code, band, runId, featureId, VERSION, asOf, now],
  });
}

main();
