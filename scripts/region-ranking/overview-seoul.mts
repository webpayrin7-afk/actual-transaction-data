/**
 * Region-overview boards for Seoul.
 * Does not rescore already published composite cells and does not print private config.
 *
 * Usage: npx tsx scripts/region-ranking/overview-seoul.mts <p1.json> <all-configs.json> [--apply]
 */
import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { SEOUL_REGIONS } from "../../src/lib/constants/regions-registry";
import { AREA_BANDS_V1, type AreaBandDef } from "../../src/lib/region-ranking/area-band";
import { aggregateAll, classifyProductCoverage, type AllBandId, type AllBandStrength, type AllPrivateConfig } from "../../src/lib/region-ranking/all-aggregate";
import { precheckAdditiveCreateSql } from "../../src/lib/region-ranking/migration-precheck";
import { median, PRICE_PER_SQM_MIN_TRADES, rankPricePerSqm, rankTradeVolume, type ObjectiveComplex } from "../../src/lib/region-ranking/objective-rank";
import { loadPrivateConfig, type RankingPrivateConfig } from "../../src/lib/region-ranking/private-config";
import { assessRegionBoard } from "../../src/lib/region-ranking/region-board";
import { rankingRunId, sha256Hex } from "../../src/lib/region-ranking/run-identity";
import { percentileRank, priceGateMode, rankWithTopTierSlots, scoreCohort, type FeatureSnapshotRow } from "../../src/lib/region-ranking/score";
import { windowsFromAsOf } from "../../src/lib/region-ranking/snapshot";

const P1 = "19ba3623e8187a35f763a0a44e6c37ba568c8322e5b6e5c82c761c9a632c7835";
const ALL_FP = "1a028dac168a8fa72bd2fff788500fdbf95d741065a7758e459c30ad9892d5fd";
const VERSION = "seoul-ranking-v2";
const APPLY = process.argv.includes("--apply");
const LAWD = SEOUL_REGIONS.map((region) => region.lawdCodes[0]!);
const GU = new Map(SEOUL_REGIONS.map((region) => [region.lawdCodes[0]!, region.name.replace(/구$/, "")]));
const BANDS = ["59", "84", "114"] as const;
type BandId = (typeof BANDS)[number];

type Deal = { date: string; area: number; amount: number };
type Master = { id: string; name: string; dong: string; lawd: string; bjdong: string };

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

async function main() {
  const p1Path = process.argv[2];
  const allPath = process.argv[3];
  if (!p1Path || !allPath || p1Path.startsWith("--")) throw new Error("config paths required");
  const loaded = loadPrivateConfig(JSON.parse(readFileSync(p1Path, "utf8")));
  if (!loaded.ok || loaded.fingerprint !== P1) {
    console.log(JSON.stringify({ status: "FINGERPRINT_MISMATCH" }));
    process.exit(2);
  }
  const allConfigs = JSON.parse(readFileSync(allPath, "utf8")) as AllPrivateConfig[];
  const allConfig = allConfigs.find((row) => row.method === "reliability_weighted_mean");
  if (!allConfig || sha256Hex(JSON.stringify(allConfig)) !== ALL_FP) {
    console.log(JSON.stringify({ status: "ALL_FINGERPRINT_MISMATCH" }));
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync("data/poc/region-ranking/seoul-launch-manifest.json", "utf8")) as {
    transaction_as_of: string;
    feature_run_id: Record<BandId, string>;
  };
  const asOf = manifest.transaction_as_of.slice(0, 10);
  const windows = windowsFromAsOf(asOf);
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
  const beforeAll = await db.execute("SELECT region_code, active_ranking_run_id FROM region_ranking_publications WHERE region_scope = 'gu' AND area_band = 'ALL' AND period = '12M'");
  const publishedAll = new Set(beforeAll.rows.map((row) => String(row.region_code)));
  const objective = await loadObjective(db, windows.recent3m.startExclusive, windows.recent3m.endInclusive);
  const volumeBoards = boardReport(objective, "volume");
  const priceBoards = boardReport(objective, "price");
  const composite = await judgeComposite(db, manifest.feature_run_id, publishedAll, loaded.config, loaded.fingerprint, allConfig);
  const spot = ["11710", "11680", "11650", "11200", "11440", "11350"];
  const preview: Record<string, unknown> = {};
  for (const lawd of spot) {
    const row = previewGu(lawd, objective, composite);
    if (row.composite_status === "ALREADY_PUBLISHED") {
      row.composite_top = await publishedCompositeTop(db, lawd, objective);
    }
    preview[GU.get(lawd) ?? lawd] = row;
  }
  console.log(JSON.stringify({
    window: { start_exclusive: windows.recent3m.startExclusive, end_inclusive: windows.recent3m.endInclusive },
    min_price_trades: PRICE_PER_SQM_MIN_TRADES,
    composite: {
      before: publishedAll.size,
      newly: composite.filter((row) => row.status === "PASS").map((row) => row.gu),
      remaining: composite.filter((row) => row.status !== "PASS").map((row) => ({ gu: row.gu, status: row.status, eligible: row.eligible })),
    },
    volume: summarize(volumeBoards),
    price: summarize(priceBoards),
    preview,
    apply: APPLY,
  }, null, 2));
  if (!APPLY) {
    db.close();
    return;
  }
  await ensureMetricsTable(db);
  const metricRunId = sha256Hex(JSON.stringify({
    kind: "objective-3m",
    asOf,
    start: windows.recent3m.startExclusive,
    end: windows.recent3m.endInclusive,
    rows: [...objective.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([id, row]) => [id, row.tradeCount3m, row.latestDealDate, row.medianPricePerSqm3m]),
  }));
  await writeMetrics(db, metricRunId, asOf, windows.recent3m.startExclusive, windows.recent3m.endInclusive, objective);
  let publications = 0;
  for (const kind of ["volume", "price"] as const) {
    const boards = kind === "volume" ? volumeBoards : priceBoards;
    const band = kind === "volume" ? "TRADE_VOLUME" : "PRICE_PER_SQM";
    for (const board of boards) {
      if (board.status !== "PASS") continue;
      const runId = rankingRunId({
        featureRunId: metricRunId,
        rankingVersion: VERSION,
        privateConfigFingerprint: sha256Hex(JSON.stringify({ kind: band, min: kind === "price" ? PRICE_PER_SQM_MIN_TRADES : 1 })),
        regionScope: "gu",
        regionCode: board.lawd,
      });
      await insertObjective(db, runId, metricRunId, board.lawd, band, asOf, board.rows);
      await upsertPublication(db, "gu", board.lawd, band, "3M", runId, metricRunId, asOf);
      publications += 1;
    }
  }
  for (const item of composite) {
    if (item.status !== "PASS" || publishedAll.has(item.lawd)) continue;
    await insertComposite(db, item.guRun, item.featureRunId, item.lawd, asOf, item.guRows);
    await upsertPublication(db, "gu", item.lawd, "ALL", "12M", item.guRun, item.featureRunId, asOf);
    publications += 1;
    for (const dong of item.dongs) {
      await insertComposite(db, item.guRun, item.featureRunId, dong.code, asOf, dong.rows, "dong");
      await upsertPublication(db, "dong", dong.code, "ALL", "12M", item.guRun, item.featureRunId, asOf);
      publications += 1;
    }
  }
  const afterAll = await db.execute("SELECT region_code, active_ranking_run_id FROM region_ranking_publications WHERE region_scope = 'gu' AND area_band = 'ALL' AND period = '12M'");
  const moved = beforeAll.rows.filter((row) => {
    const next = afterAll.rows.find((item) => item.region_code === row.region_code);
    return !next || String(next.active_ranking_run_id) !== String(row.active_ranking_run_id);
  }).length;
  console.log(JSON.stringify({ wrote: true, publications, existing_all_pointers_moved: moved }));
  db.close();
}

function boardReport(objective: Map<string, ObjectiveComplex & Master>, kind: "volume" | "price") {
  const boards = [];
  for (const lawd of LAWD) {
    const rows = [...objective.values()].filter((row) => row.lawd === lawd);
    const once = kind === "volume" ? rankTradeVolume(rows) : rankPricePerSqm(rows);
    const again = kind === "volume" ? rankTradeVolume(rows) : rankPricePerSqm(rows);
    const status = assessRegionBoard({
      eligibleCount: once.length,
      ranks: once.map((row) => row.rank),
      deterministic: JSON.stringify(once.map((row) => row.complexId)) === JSON.stringify(again.map((row) => row.complexId)),
    });
    boards.push({ lawd, gu: GU.get(lawd), status, rows: once });
  }
  return boards;
}

function summarize(boards: Array<{ gu?: string; status: string; rows: unknown[] }>) {
  return {
    published: boards.filter((row) => row.status === "PASS").length,
    ranked: boards.reduce((sum, row) => sum + (row.status === "PASS" ? row.rows.length : 0), 0),
    insufficient: boards.filter((row) => row.status !== "PASS").map((row) => `${row.gu}:${row.status}:${row.rows.length}`),
  };
}

async function publishedCompositeTop(
  db: Client,
  lawd: string,
  objective: Map<string, ObjectiveComplex & Master>,
) {
  const pub = await db.execute({
    sql: `SELECT active_ranking_run_id FROM region_ranking_publications
          WHERE region_scope = 'gu' AND region_code = ? AND area_band = 'ALL' AND period = '12M'`,
    args: [lawd],
  });
  const runId = pub.rows[0]?.active_ranking_run_id;
  if (runId == null) return [];
  const result = await db.execute({
    sql: `SELECT r."rank" AS rank, r.complex_id, r.public_display_metrics_json, m.apt_name, m.legal_dong_name
          FROM region_complex_rankings r
          JOIN apt_complex_master m ON m.complex_id = r.complex_id
          WHERE r.ranking_run_id = ? AND r.region_scope = 'gu' AND r.region_code = ?
            AND r.area_band = 'ALL' AND r.period = '12M' AND r.eligible = 1 AND r."rank" IS NOT NULL
          ORDER BY r."rank" ASC
          LIMIT 10`,
    args: [String(runId), lawd],
  });
  return result.rows.map((row) => {
    const metrics = JSON.parse(String(row.public_display_metrics_json)) as { coverage_status?: string };
    const extra = objective.get(String(row.complex_id));
    return {
      name: row.apt_name == null ? String(row.complex_id) : String(row.apt_name),
      dong: row.legal_dong_name == null ? "" : String(row.legal_dong_name),
      coverage: metrics.coverage_status ?? null,
      trade_count_3m: extra?.tradeCount3m ?? 0,
      median_price_per_sqm_3m: extra?.medianPricePerSqm3m == null ? null : Math.round(extra.medianPricePerSqm3m * 10) / 10,
    };
  });
}

function previewGu(
  lawd: string,
  objective: Map<string, ObjectiveComplex & Master>,
  composite: Array<{ lawd: string; status: string; top: Array<{ name: string; dong: string; coverage: string; complexId: string }> }>,
) {
  const rows = [...objective.values()].filter((row) => row.lawd === lawd);
  const volume = rankTradeVolume(rows).slice(0, 10).map((row) => ({
    rank: row.rank,
    name: row.name,
    dong: row.dong,
    trade_count_3m: row.tradeCount3m,
    latest_deal_date: row.latestDealDate,
  }));
  const price = rankPricePerSqm(rows).slice(0, 10).map((row) => ({
    rank: row.rank,
    name: row.name,
    dong: row.dong,
    median_price_per_sqm_3m: row.medianPricePerSqm3m == null ? null : Math.round(row.medianPricePerSqm3m * 10) / 10,
    trade_count_3m: row.tradeCount3m,
  }));
  const found = composite.find((row) => row.lawd === lawd);
  const compositeTop = (found?.top ?? []).map((row) => {
    const metric = objective.get(row.complexId);
    return {
      name: row.name,
      dong: row.dong,
      coverage: row.coverage,
      trade_count_3m: metric?.tradeCount3m ?? 0,
      median_price_per_sqm_3m: metric?.medianPricePerSqm3m == null ? null : Math.round(metric.medianPricePerSqm3m * 10) / 10,
    };
  });
  return {
    composite_status: found?.status ?? "ALREADY_PUBLISHED",
    composite_top: compositeTop,
    volume_top: volume,
    price_top: price,
  };
}

async function loadObjective(db: Client, startExclusive: string, endInclusive: string) {
  const ambiguous = await db.execute({
    sql: `SELECT lawd_cd, apt_name_norm FROM apt_complex_master
          WHERE lawd_cd IN (${LAWD.map(() => "?").join(",")})
          GROUP BY lawd_cd, apt_name_norm HAVING COUNT(*) > 1`,
    args: LAWD,
  });
  const ambiguousKeys = new Set(ambiguous.rows.map((row) => `${row.lawd_cd}|${row.apt_name_norm}`));
  const grouped = new Map<string, { master: Master; deals: Deal[] }>();
  for (const lawd of LAWD) {
    const result = await db.execute({
      sql: `SELECT m.complex_id, m.apt_name, m.apt_name_norm, m.legal_dong_name, m.bjdong_cd,
                   t.deal_date, t.exclusive_area, t.deal_amount
            FROM apt_complex_master m
            JOIN transactions t ON t.lawd_cd = m.lawd_cd AND t.apt_name_norm = m.apt_name_norm
            WHERE m.lawd_cd = ? AND t.deal_type = 'trade'
              AND t.deal_date > ? AND t.deal_date <= ?`,
      args: [lawd, startExclusive, endInclusive],
    });
    for (const row of result.rows) {
      const name = String(row.apt_name_norm);
      if (ambiguousKeys.has(`${lawd}|${name}`)) continue;
      const area = Number(row.exclusive_area);
      const amount = Number(row.deal_amount);
      if (!Number.isFinite(area) || !Number.isFinite(amount) || area <= 0 || amount <= 0) continue;
      const id = String(row.complex_id);
      const got = grouped.get(id) ?? {
        master: {
          id,
          name: row.apt_name == null ? name : String(row.apt_name),
          dong: row.legal_dong_name == null ? "" : String(row.legal_dong_name),
          lawd,
          bjdong: row.bjdong_cd == null ? "" : String(row.bjdong_cd),
        },
        deals: [],
      };
      got.deals.push({ date: String(row.deal_date).slice(0, 10), area, amount });
      grouped.set(id, got);
    }
  }
  const out = new Map<string, ObjectiveComplex & Master>();
  for (const [id, group] of grouped) {
    const latest = group.deals.reduce((max, row) => (max == null || row.date > max ? row.date : max), null as string | null);
    out.set(id, {
      ...group.master,
      complexId: id,
      tradeCount3m: group.deals.length,
      latestDealDate: latest,
      medianPricePerSqm3m: median(group.deals.map((row) => row.amount / row.area)),
    });
  }
  return out;
}

async function judgeComposite(
  db: Client,
  manifestRuns: Record<BandId, string>,
  publishedAll: Set<string>,
  config: RankingPrivateConfig,
  fingerprint: string,
  allConfig: AllPrivateConfig,
) {
  const hold = LAWD.filter((lawd) => !publishedAll.has(lawd));
  const pubs = await db.execute("SELECT region_code, area_band, feature_run_id FROM region_ranking_publications WHERE region_scope = 'gu' AND period = '12M' AND area_band IN ('59','84','114')");
  const featureByCell = new Map(pubs.rows.map((row) => [`${row.region_code}|${row.area_band}`, String(row.feature_run_id)]));
  const runIds = [...new Set([...Object.values(manifestRuns), ...featureByCell.values()])];
  const loaded = await loadFeatures(db, runIds);
  const expected = await expectedBands(db, hold);
  const reports = [];
  for (const lawd of hold) {
    const strengths = new Map<string, AllBandStrength[]>();
    const meta = new Map<string, FeatureSnapshotRow>();
    for (const band of BANDS) {
      const runId = featureByCell.get(`${lawd}|${band}`) ?? manifestRuns[band];
      const cohort = loaded.filter((row) => row.featureRunId === runId && row.areaBand === band && row.lawdCd === lawd);
      const scored = scoreCohort({
        featureRunId: "analysis",
        rows: cohort,
        regionScope: "gu",
        regionCode: lawd,
        config,
        privateConfigFingerprint: fingerprint,
        rankingVersion: VERSION,
      });
      if (!scored.ok) continue;
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
        bjdong: row.bjdongCd,
        name: complexId,
        score: aggregate.score,
        topTier: aggregate.topTier,
        tieBreak: row.tradeCount,
        confidence: row.profileConfidence,
        product,
      });
    }
    const mode = priceGateMode("gu", items.length);
    const rankInput = items.map((item) => ({ id: item.complexId, score: item.score, topTier: item.topTier, tieBreak: item.tieBreak }));
    const ranked = rankWithTopTierSlots(rankInput, mode);
    const again = rankWithTopTierSlots(rankInput, mode);
    const rankById = new Map(ranked.map((item) => [item.id, item.rank]));
    const status = assessRegionBoard({
      eligibleCount: items.length,
      ranks: ranked.map((item) => item.rank),
      deterministic: JSON.stringify(ranked) === JSON.stringify(again),
    });
    const names = await namesFor(db, items.map((item) => item.complexId));
    const featureRunId = sha256Hex(JSON.stringify({
      kind: "region-overview-composite",
      lawd,
      bands: BANDS.map((band) => {
        const runId = featureByCell.get(`${lawd}|${band}`) ?? manifestRuns[band];
        return `${band}:${runId}`;
      }),
    }));
    const guRun = rankingRunId({
      featureRunId,
      rankingVersion: VERSION,
      privateConfigFingerprint: sha256Hex(JSON.stringify(allConfig)),
      regionScope: "gu",
      regionCode: lawd,
    });
    const toRow = (item: (typeof items)[number], rank: number | null, regionTotal: number, scope: "gu" | "dong", code: string) => ({
      complexId: item.complexId,
      rank,
      regionTotal,
      scope,
      code,
      confidenceBucket: item.product.coverageStatus === "PARTIAL_PRODUCT_COVERAGE" ? "DATA_COVERAGE_INCOMPLETE" : item.confidence,
      metrics: {
        expected_band_count: item.product.expectedBandCount,
        valid_band_count: item.product.validBandCount,
        expected_bands: item.product.expectedBands == null ? null : item.product.expectedBands.join(","),
        valid_bands: item.product.validBands.join(","),
        coverage_completeness: item.product.coverageCompleteness,
        coverage_status: item.product.coverageStatus,
        single_product_band: item.product.singleProductBand,
      },
    });
    const dongs = [];
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
        const sorted = [...dongRanked.map((item) => item.rank)].sort((a, b) => a - b);
        if (dongRanked.length === members.length && sorted.every((rank, index) => rank === index + 1) && new Set(sorted).size === sorted.length) {
          const byId = new Map(dongRanked.map((item) => [item.id, item.rank]));
          dongs.push({
            code: `${lawd}${bjdong}`,
            rows: members.map((item) => toRow(item, byId.get(item.complexId) ?? null, members.length, "dong", `${lawd}${bjdong}`)),
          });
        }
      }
    }
    const top = items
      .map((item) => ({ item, rank: rankById.get(item.complexId) ?? 99 }))
      .filter((row) => row.rank <= 10)
      .sort((a, b) => a.rank - b.rank)
      .map((row) => ({
        complexId: row.item.complexId,
        name: names.get(row.item.complexId)?.name ?? row.item.complexId,
        dong: names.get(row.item.complexId)?.dong ?? "",
        coverage: row.item.product.coverageStatus,
      }));
    reports.push({
      lawd,
      gu: GU.get(lawd),
      status,
      eligible: items.length,
      featureRunId,
      guRun,
      guRows: items.map((item) => toRow(item, rankById.get(item.complexId) ?? null, items.length, "gu", lawd)),
      dongs,
      top,
    });
  }
  return reports;
}

async function loadFeatures(db: Client, runIds: string[]) {
  const out: Array<FeatureSnapshotRow & { featureRunId: string }> = [];
  for (const runId of runIds) {
    const result = await db.execute({
      sql: `SELECT f.*, m.identity_status
            FROM ranking_feature_snapshots f
            JOIN apt_complex_master m ON m.complex_id = f.complex_id
            WHERE f.feature_run_id = ?`,
      args: [runId],
    });
    for (const row of result.rows) {
      out.push({ ...snapshot(row, row.identity_status == null ? null : String(row.identity_status)), featureRunId: runId });
    }
  }
  return out;
}

async function namesFor(db: Client, ids: string[]) {
  const out = new Map<string, { name: string; dong: string }>();
  for (let i = 0; i < ids.length; i += 80) {
    const slice = ids.slice(i, i + 80);
    if (slice.length === 0) continue;
    const result = await db.execute({
      sql: `SELECT complex_id, apt_name, apt_name_norm, legal_dong_name FROM apt_complex_master WHERE complex_id IN (${slice.map(() => "?").join(",")})`,
      args: slice,
    });
    for (const row of result.rows) {
      out.set(String(row.complex_id), {
        name: row.apt_name == null ? String(row.apt_name_norm) : String(row.apt_name),
        dong: row.legal_dong_name == null ? "" : String(row.legal_dong_name),
      });
    }
  }
  return out;
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
  const remember = (id: string, min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    const set = expected.get(id) ?? new Set<AllBandId>();
    for (const band of bandsForSpan(min, max)) set.add(band);
    if (set.size > 0) expected.set(id, set);
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
      if (row.complex_id == null || fromCatalog.has(String(row.complex_id))) continue;
      const id = String(row.complex_id);
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

async function ensureMetricsTable(db: Client) {
  const sql = readFileSync("src/lib/db/migrations/20260921_region_objective_metrics.sql", "utf8");
  const precheck = precheckAdditiveCreateSql(sql);
  if (!precheck.ok) throw new Error(precheck.reason);
  for (const statement of precheck.statements) await db.execute(statement);
}

async function writeMetrics(
  db: Client,
  runId: string,
  asOf: string,
  start: string,
  end: string,
  rows: Map<string, ObjectiveComplex & Master>,
) {
  const now = new Date().toISOString();
  const list = [...rows.values()];
  for (let i = 0; i < list.length; i += 40) {
    const slice = list.slice(i, i + 40).map((row) => ({
      sql: `INSERT INTO region_objective_metrics (
              metric_run_id, complex_id, lawd_cd, transaction_as_of, window_start, window_end,
              trade_count_3m, latest_deal_date, median_price_per_sqm_3m, calculated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(metric_run_id, complex_id) DO NOTHING`,
      args: [runId, row.complexId, row.lawd, asOf, start, end, row.tradeCount3m, row.latestDealDate, row.medianPricePerSqm3m, now],
    }));
    await db.batch(slice, "write");
  }
}

async function insertObjective(
  db: Client,
  runId: string,
  featureId: string,
  lawd: string,
  band: string,
  asOf: string,
  rows: Array<{ complexId: string; rank: number; regionTotal: number; tradeCount3m: number; latestDealDate: string | null; medianPricePerSqm3m: number | null }>,
) {
  const now = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 40) {
    const slice = rows.slice(i, i + 40).map((row) => ({
      sql: `INSERT INTO region_complex_rankings (
              ranking_run_id, region_scope, region_code, complex_id, area_band, period, feature_run_id,
              "rank", region_total, confidence_bucket, eligible, exclusion_reason, ranking_version,
              transaction_as_of, calculated_at, public_display_metrics_json
            ) VALUES (?, 'gu', ?, ?, ?, '3M', ?, ?, ?, 'PUBLIC', 1, NULL, ?, ?, ?, ?)
            ON CONFLICT(ranking_run_id, region_scope, region_code, complex_id, area_band, period) DO NOTHING`,
      args: [
        runId, lawd, row.complexId, band, featureId, row.rank, row.regionTotal, VERSION, asOf, now,
        JSON.stringify(band === "TRADE_VOLUME"
          ? { trade_count_3m: row.tradeCount3m, latest_deal_date: row.latestDealDate }
          : { median_price_per_sqm_3m: row.medianPricePerSqm3m, trade_count_3m: row.tradeCount3m }),
      ],
    }));
    await db.batch(slice, "write");
  }
}

async function insertComposite(
  db: Client,
  runId: string,
  featureId: string,
  code: string,
  asOf: string,
  rows: Array<{ complexId: string; rank: number | null; regionTotal: number; confidenceBucket: string; metrics: unknown }>,
  scope: "gu" | "dong" = "gu",
) {
  const now = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 40) {
    const slice = rows.slice(i, i + 40).map((row) => ({
      sql: `INSERT INTO region_complex_rankings (
              ranking_run_id, region_scope, region_code, complex_id, area_band, period, feature_run_id,
              "rank", region_total, confidence_bucket, eligible, exclusion_reason, ranking_version,
              transaction_as_of, calculated_at, public_display_metrics_json
            ) VALUES (?, ?, ?, ?, 'ALL', '12M', ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)
            ON CONFLICT(ranking_run_id, region_scope, region_code, complex_id, area_band, period) DO NOTHING`,
      args: [runId, scope, code, row.complexId, featureId, row.rank, row.regionTotal, row.confidenceBucket, VERSION, asOf, now, JSON.stringify(row.metrics)],
    }));
    await db.batch(slice, "write");
  }
}

async function upsertPublication(
  db: Client,
  scope: string,
  code: string,
  band: string,
  period: string,
  runId: string,
  featureId: string,
  asOf: string,
) {
  const now = new Date().toISOString();
  await db.execute({
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
    args: [scope, code, band, period, runId, featureId, VERSION, asOf, now],
  });
}

main();
