/**
 * Nationwide / Seoul ALL+12M feature snapshots + gu publications for Ranking V4.
 *
 *   npx tsx scripts/region-ranking/launch-nationwide-all.mts
 *   npx tsx scripts/region-ranking/launch-nationwide-all.mts --apply
 *   npx tsx scripts/region-ranking/launch-nationwide-all.mts --scope=seoul --as-of=2026-07-31
 *   npx tsx scripts/region-ranking/launch-nationwide-all.mts --scope=seoul --as-of=2026-07-31 --apply
 *
 * --scope=nationwide (default): skip Seoul pubs (insert-only for non-Seoul).
 * --only-missing (nationwide only): limit targets to registry lawd codes that have
 *   no gu ALL/12M publication yet (e.g. after a 시군구 code change). Reports go to
 *   nationwide-all-missing-*.json so the original run's reports are kept.
 * --scope=seoul: rebuild Seoul features under a new feature_run_id and UPDATE
 *   Seoul gu ALL/12M publication pointers only. Old Seoul snapshots are kept.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { mkdirSync, writeFileSync } from "node:fs";
import {
  allNationwideLawdCodes,
  districtNameFromCode,
  LAWD_TO_REGION,
} from "../../src/lib/constants/regions-registry";
import { getDb } from "../../src/lib/db/client";
import { lastCompleteVolumeMonth } from "../../src/lib/market/deal-stats";
import type { AreaBandDef } from "../../src/lib/region-ranking/area-band";
import {
  extractFeatures,
  type DealRow,
  type ProfileInput,
} from "../../src/lib/region-ranking/features";
import {
  RANKING_V4_ELIGIBILITY,
  readRankingV4Board,
  scoreRankingV4,
} from "../../src/lib/region-ranking/ranking-v4";
import {
  featureRunId,
  rankingRunId,
  sha256Hex,
} from "../../src/lib/region-ranking/run-identity";
import {
  FEATURE_VERSION,
  windowsFromAsOf,
} from "../../src/lib/region-ranking/snapshot";

const APPLY = process.argv.includes("--apply");
const asOfArg = process.argv.find((a) => a.startsWith("--as-of="))?.slice("--as-of=".length);
const scopeRaw =
  process.argv.find((a) => a.startsWith("--scope="))?.slice("--scope=".length) ?? "nationwide";
const SCOPE = scopeRaw === "seoul" ? "seoul" : "nationwide";
const ONLY_MISSING = process.argv.includes("--only-missing");
if (ONLY_MISSING && SCOPE !== "nationwide") throw new Error("--only-missing is nationwide-only");
const REPORT_DIR = "data/poc/region-ranking";
const RANKING_VERSION = "ziplab-ranking-v4";
const AREA_BAND = "ALL" as const;
const AREA_BAND_VERSION = "NATIONWIDE_ALL_POOL_V1";
const PERIOD = "12M";
const PRIVATE_CONFIG_FP = sha256Hex(
  JSON.stringify({
    rankingVersion: RANKING_VERSION,
    eligibility: RANKING_V4_ELIGIBILITY,
    note: "read-time V4; publication pointer only",
  }),
);

/** ALL band that accepts every exclusive area (pooled 12M trades). */
const ALL_BAND: AreaBandDef = {
  id: "ALL",
  status: "active",
  exclusiveSqmMin: 0,
  exclusiveSqmMax: 1_000_000,
  note: "Pooled ALL for Ranking V4 read path",
};

function lastDayOfYm(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(4, 6));
  const dt = new Date(Date.UTC(y, m, 0));
  return dt.toISOString().slice(0, 10);
}

function resolveAsOf(): string {
  if (asOfArg) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfArg)) throw new Error(`bad --as-of=${asOfArg}`);
    return asOfArg;
  }
  return lastDayOfYm(lastCompleteVolumeMonth());
}

function metroOf(lawd: string): string {
  return LAWD_TO_REGION[lawd]?.metro ?? lawd.slice(0, 2);
}

type MasterRow = {
  complexId: string;
  lawd: string;
  bjdong: string;
  name: string;
  aptNameNorm: string;
  household: number | null;
  confidence: ProfileInput["confidence"];
  profileSource: string | null;
};

type BuiltFeature = {
  complexId: string;
  lawd: string;
  bjdong: string;
  medianPricePerSqm: number | null;
  medianDealAmount: number | null;
  tradeCount: number;
  householdCount: number | null;
  turnover: number | null;
  activeMonthCount: number;
  latestDealDate: string | null;
  recent3mTradeCount: number;
  previous3mTradeCount: number;
  recent3mMedianPricePerSqm: number | null;
  previous3mMedianPricePerSqm: number | null;
  profileSource: string | null;
  profileConfidence: string;
  eligibleInput: 0 | 1;
  exclusionReason: string | null;
};

type TopRow = { rank: number; complexId: string; name: string | null; score: number };

type GuReport = {
  lawd: string;
  name: string;
  metro: string;
  candidates: number;
  eligible: number;
  publish: boolean;
  top: TopRow[];
};

async function mapPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, Math.max(items.length, 1)) }, async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        await fn(items[i]!);
      }
    }),
  );
}

function scoreGu(feats: BuiltFeature[]): { candidates: number; eligible: number; top: TopRow[] } {
  const candidates = feats
    .filter((f) => f.eligibleInput === 1)
    .map((f) => ({
      complexId: f.complexId,
      name: null as string | null,
      dong: null as string | null,
      buildYear: null as number | null,
      price: f.medianPricePerSqm ?? 0,
      amount: f.medianDealAmount,
      trades: f.tradeCount,
      activeMonths: f.activeMonthCount,
      households: f.householdCount,
      latestDealDate: f.latestDealDate,
      confidence: f.profileConfidence,
    }));
  const scored = scoreRankingV4(candidates);
  return {
    candidates: candidates.length,
    eligible: scored.length,
    top: scored.slice(0, 3).map((r) => ({
      rank: r.rank,
      complexId: r.complexId,
      name: r.name,
      score: r.score,
    })),
  };
}

async function loadMasters(db: NonNullable<ReturnType<typeof getDb>>, lawds: string[]) {
  const masters: MasterRow[] = [];
  for (let i = 0; i < lawds.length; i += 40) {
    const slice = lawds.slice(i, i + 40);
    const r = await db.execute({
      sql: `SELECT m.complex_id, m.lawd_cd, m.bjdong_cd, m.apt_name, m.apt_name_norm,
                   p.household_count, p.source,
                   uh.h AS unit_households
            FROM apt_complex_master m
            LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
            LEFT JOIN (
              SELECT complex_id, SUM(household_count) AS h
              FROM unit_type_household_counts
              WHERE household_count IS NOT NULL
              GROUP BY complex_id
            ) uh ON uh.complex_id = m.complex_id
            WHERE m.lawd_cd IN (${slice.map(() => "?").join(",")})`,
      args: slice,
    });
    for (const row of r.rows) {
      const profileHh = row.household_count == null ? null : Number(row.household_count);
      const unitHh = row.unit_households == null ? null : Number(row.unit_households);
      const hh =
        profileHh != null && profileHh > 0
          ? profileHh
          : unitHh != null && unitHh > 0
            ? unitHh
            : null;
      const hasHh = hh != null && hh > 0;
      masters.push({
        complexId: String(row.complex_id),
        lawd: String(row.lawd_cd),
        bjdong: String(row.bjdong_cd ?? ""),
        name: String(row.apt_name ?? ""),
        aptNameNorm: String(row.apt_name_norm ?? ""),
        household: hasHh ? hh : null,
        confidence: hasHh ? "LOW" : "MISSING",
        profileSource:
          row.source == null
            ? unitHh != null && unitHh > 0
              ? "unit_type_household_counts"
              : null
            : String(row.source),
      });
    }
  }
  return masters;
}

async function buildFeatures(
  db: NonNullable<ReturnType<typeof getDb>>,
  masters: MasterRow[],
  windows: ReturnType<typeof windowsFromAsOf>,
) {
  const byLawd = new Map<string, MasterRow[]>();
  for (const m of masters) {
    const list = byLawd.get(m.lawd) ?? [];
    list.push(m);
    byLawd.set(m.lawd, list);
  }
  const built: BuiltFeature[] = [];
  const lawdList = [...byLawd.keys()].sort();
  let doneLawds = 0;
  await mapPool(lawdList, 4, async (lawd) => {
    const rows = byLawd.get(lawd)!;
    const sinceYm = windows.base12m.startExclusive.slice(0, 7).replace("-", "");
    const untilYm = windows.base12m.endInclusive.slice(0, 7).replace("-", "");
    const dealsByNorm = new Map<string, DealRow[]>();
    const uniqueNorms = [...new Set(rows.map((r) => r.aptNameNorm).filter(Boolean))];
    for (let i = 0; i < uniqueNorms.length; i += 80) {
      const slice = uniqueNorms.slice(i, i + 80);
      const tx = await db.execute({
        sql: `SELECT apt_name_norm, deal_date, exclusive_area, deal_amount
              FROM transactions
              WHERE lawd_cd=? AND deal_type='trade'
                AND year_month >= ? AND year_month <= ?
                AND apt_name_norm IN (${slice.map(() => "?").join(",")})`,
        args: [lawd, sinceYm, untilYm, ...slice],
      });
      for (const t of tx.rows) {
        const norm = String(t.apt_name_norm);
        const list = dealsByNorm.get(norm) ?? [];
        list.push({
          dealDate: String(t.deal_date).slice(0, 10),
          exclusiveArea: Number(t.exclusive_area) || 0,
          dealAmount: Number(t.deal_amount) || 0,
        });
        dealsByNorm.set(norm, list);
      }
    }
    for (const m of rows) {
      const deals = dealsByNorm.get(m.aptNameNorm) ?? [];
      const profile: ProfileInput = {
        householdCount: m.household,
        source: m.profileSource,
        sourceKey: null,
        sourceAsOf: null,
        confidence: m.confidence,
      };
      const feat = extractFeatures({ deals, band: ALL_BAND, windows, profile });
      const eligible = feat.medianPricePerSqm != null && feat.tradeCount > 0 ? 1 : 0;
      built.push({
        complexId: m.complexId,
        lawd: m.lawd,
        bjdong: m.bjdong,
        medianPricePerSqm: feat.medianPricePerSqm,
        medianDealAmount: feat.medianDealAmount,
        tradeCount: feat.tradeCount,
        householdCount: feat.householdCount,
        turnover: feat.turnover,
        activeMonthCount: feat.activeMonthCount,
        latestDealDate: feat.latestDealDate,
        recent3mTradeCount: feat.recent3mTradeCount,
        previous3mTradeCount: feat.previous3mTradeCount,
        recent3mMedianPricePerSqm: feat.recent3mMedianPricePerSqm,
        previous3mMedianPricePerSqm: feat.previous3mMedianPricePerSqm,
        profileSource: m.profileSource,
        profileConfidence: m.confidence,
        eligibleInput: eligible as 0 | 1,
        exclusionReason: eligible ? null : feat.tradeCount === 0 ? "no_trades_12m" : "no_price",
      });
    }
    doneLawds += 1;
    if (doneLawds % 10 === 0 || doneLawds === lawdList.length) {
      console.log(
        JSON.stringify({
          phase: "features-progress",
          doneLawds,
          totalLawds: lawdList.length,
          built: built.length,
        }),
      );
    }
  });
  return built;
}

async function writeFeatures(
  db: NonNullable<ReturnType<typeof getDb>>,
  built: BuiltFeature[],
  runId: string,
  asOf: string,
  windows: ReturnType<typeof windowsFromAsOf>,
) {
  const calculatedAt = new Date().toISOString();
  const CHUNK = 40;
  let done = 0;
  for (let i = 0; i < built.length; i += CHUNK) {
    const slice = built.slice(i, i + CHUNK);
    await db.batch(
      slice.map((f) => ({
        sql: `INSERT INTO ranking_feature_snapshots (
            feature_run_id, complex_id, lawd_cd, bjdong_cd, area_band, area_band_version, period,
            transaction_as_of, source_window_start, source_window_end,
            recent_window_start, recent_window_end, previous_window_start, previous_window_end,
            median_price_per_sqm, median_deal_amount, trade_count, household_count, turnover,
            active_month_count, latest_deal_date, recent_3m_trade_count, previous_3m_trade_count,
            recent_3m_median_price_per_sqm, previous_3m_median_price_per_sqm,
            feature_version, profile_source, profile_confidence, eligible_input, exclusion_reason, calculated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(feature_run_id, complex_id, area_band, period) DO NOTHING`,
        args: [
          runId,
          f.complexId,
          f.lawd,
          f.bjdong,
          AREA_BAND,
          AREA_BAND_VERSION,
          PERIOD,
          asOf,
          windows.base12m.startExclusive,
          windows.base12m.endInclusive,
          windows.recent3m.startExclusive,
          windows.recent3m.endInclusive,
          windows.previous3m.startExclusive,
          windows.previous3m.endInclusive,
          f.medianPricePerSqm,
          f.medianDealAmount,
          f.tradeCount,
          f.householdCount,
          f.turnover,
          f.activeMonthCount,
          f.latestDealDate,
          f.recent3mTradeCount,
          f.previous3mTradeCount,
          f.recent3mMedianPricePerSqm,
          f.previous3mMedianPricePerSqm,
          FEATURE_VERSION,
          f.profileSource,
          f.profileConfidence,
          f.eligibleInput,
          f.exclusionReason,
          calculatedAt,
        ],
      })),
      "write",
    );
    done += slice.length;
    if (i === 0 || done % 800 === 0 || done === built.length) {
      console.log(JSON.stringify({ phase: "write-features", done, total: built.length }));
    }
  }
  return calculatedAt;
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("no db");
  const asOf = resolveAsOf();
  const windows = windowsFromAsOf(asOf);
  const allLawds = allNationwideLawdCodes();
  const seoulLawds = allLawds.filter((c) => c.startsWith("11")).sort();
  const nonSeoulLawds = allLawds.filter((c) => !c.startsWith("11")).sort();
  let targetLawds = SCOPE === "seoul" ? seoulLawds : nonSeoulLawds;
  if (ONLY_MISSING) {
    const pubs = await db.execute({
      sql: `SELECT region_code FROM region_ranking_publications
            WHERE region_scope='gu' AND area_band=? AND period=?`,
      args: [AREA_BAND, PERIOD],
    });
    const published = new Set(pubs.rows.map((r) => String(r.region_code)));
    targetLawds = targetLawds.filter((c) => !published.has(c));
  }

  console.log(
    JSON.stringify({
      phase: "start",
      apply: APPLY,
      scope: SCOPE,
      asOf,
      windows,
      rankingVersion: RANKING_VERSION,
      areaBand: AREA_BAND,
      period: PERIOD,
      targetLawds: targetLawds.length,
      onlyMissing: ONLY_MISSING,
    }),
  );

  // Before snapshot for Seoul (current published boards)
  type BeforeGu = {
    lawd: string;
    name: string;
    asOf: string | null;
    rankingVersion: string | null;
    featureRunId: string | null;
    eligible: number;
    top: TopRow[];
  };
  const before: BeforeGu[] = [];
  if (SCOPE === "seoul") {
    for (const lawd of seoulLawds) {
      const pub = await db.execute({
        sql: `SELECT ranking_version, transaction_as_of, feature_run_id
              FROM region_ranking_publications
              WHERE region_scope='gu' AND region_code=? AND area_band=? AND period=?`,
        args: [lawd, AREA_BAND, PERIOD],
      });
      const board = await readRankingV4Board(db, {
        regionCode: lawd,
        areaBand: "ALL",
        period: "12M",
      });
      before.push({
        lawd,
        name: districtNameFromCode(lawd) || lawd,
        asOf: pub.rows[0] ? String(pub.rows[0].transaction_as_of) : board.transactionAsOf,
        rankingVersion: pub.rows[0] ? String(pub.rows[0].ranking_version) : null,
        featureRunId: pub.rows[0] ? String(pub.rows[0].feature_run_id) : board.featureRunId,
        eligible: board.rows.length,
        top: board.rows.slice(0, 3).map((r) => ({
          rank: r.rank,
          complexId: r.complexId,
          name: r.name,
          score: r.score,
        })),
      });
    }
    console.log(
      JSON.stringify({
        phase: "seoul-before",
        guCount: before.length,
        asOfSample: [...new Set(before.map((b) => b.asOf))],
        rankingVersions: [...new Set(before.map((b) => b.rankingVersion))],
      }),
    );
  }

  const masters = await loadMasters(db, targetLawds);
  const nameById = new Map(masters.map((m) => [m.complexId, m.name]));
  const cohortId = sha256Hex(
    JSON.stringify(
      [...masters]
        .sort((a, b) => a.complexId.localeCompare(b.complexId))
        .map((m) => ({
          complex_id: m.complexId,
          household_count: m.household,
          profile_confidence: m.confidence,
          cohort_origin: "apt_complex_profile",
          scope: SCOPE,
        })),
    ) + (ONLY_MISSING ? ":only-missing" : ""),
  );
  const runId = featureRunId({
    transactionAsOf: asOf,
    sourceWindowStart: windows.base12m.startExclusive,
    sourceWindowEnd: windows.base12m.endInclusive,
    recentWindowStart: windows.recent3m.startExclusive,
    recentWindowEnd: windows.recent3m.endInclusive,
    previousWindowStart: windows.previous3m.startExclusive,
    previousWindowEnd: windows.previous3m.endInclusive,
    areaBand: AREA_BAND,
    areaBandVersion: AREA_BAND_VERSION,
    featureVersion: FEATURE_VERSION,
    cohortInputId: cohortId,
  });

  console.log(
    JSON.stringify({
      phase: "masters",
      masters: masters.length,
      withHousehold: masters.filter((m) => m.household != null).length,
      featureRunId: runId,
      cohortInputId: cohortId,
    }),
  );

  const built = await buildFeatures(db, masters, windows);

  // Attach names for reporting
  for (const f of built) {
    /* names resolved via nameById at report time */
  }

  const byGu = new Map<string, BuiltFeature[]>();
  for (const f of built) {
    const list = byGu.get(f.lawd) ?? [];
    list.push(f);
    byGu.set(f.lawd, list);
  }

  const guReports: GuReport[] = [];
  for (const lawd of [...byGu.keys()].sort()) {
    const scored = scoreGu(byGu.get(lawd)!);
    guReports.push({
      lawd,
      name: districtNameFromCode(lawd) || lawd,
      metro: metroOf(lawd),
      candidates: scored.candidates,
      eligible: scored.eligible,
      publish: scored.eligible > 0,
      top: scored.top.map((t) => ({
        ...t,
        name: nameById.get(t.complexId) ?? t.name,
      })),
    });
  }

  const byMetro = new Map<
    string,
    { publishGus: number; emptyGus: number; eligibleComplexes: number }
  >();
  for (const g of guReports) {
    const row = byMetro.get(g.metro) ?? {
      publishGus: 0,
      emptyGus: 0,
      eligibleComplexes: 0,
    };
    if (g.publish) row.publishGus += 1;
    else row.emptyGus += 1;
    row.eligibleComplexes += g.eligible;
    byMetro.set(g.metro, row);
  }

  // Seoul before/after diff
  let seoulDiff: unknown = null;
  if (SCOPE === "seoul") {
    const changed: Array<{
      lawd: string;
      name: string;
      eligibleBefore: number;
      eligibleAfter: number;
      topBefore: TopRow[];
      topAfter: TopRow[];
    }> = [];
    const unchanged: string[] = [];
    for (const g of guReports) {
      const b = before.find((x) => x.lawd === g.lawd);
      const beforeIds = (b?.top ?? []).map((t) => t.complexId).join("|");
      const afterIds = g.top.map((t) => t.complexId).join("|");
      const eligChanged = (b?.eligible ?? 0) !== g.eligible;
      if (beforeIds !== afterIds || eligChanged) {
        changed.push({
          lawd: g.lawd,
          name: g.name,
          eligibleBefore: b?.eligible ?? 0,
          eligibleAfter: g.eligible,
          topBefore: b?.top ?? [],
          topAfter: g.top,
        });
      } else {
        unchanged.push(`${g.lawd}:${g.name}`);
      }
    }
    seoulDiff = {
      changedGuCount: changed.length,
      unchangedGuCount: unchanged.length,
      changed,
      allGuEligible: guReports.map((g) => {
        const b = before.find((x) => x.lawd === g.lawd);
        return {
          lawd: g.lawd,
          name: g.name,
          eligibleBefore: b?.eligible ?? 0,
          eligibleAfter: g.eligible,
          topBefore: b?.top ?? [],
          topAfter: g.top,
        };
      }),
    };
  }

  const dryReport = {
    apply: APPLY,
    scope: SCOPE,
    asOf,
    featureRunId: runId,
    featureRows: built.length,
    featureEligibleInput: built.filter((f) => f.eligibleInput === 1).length,
    guTotal: guReports.length,
    guPublish: guReports.filter((g) => g.publish).length,
    guEmpty: guReports.filter((g) => !g.publish).length,
    byMetro: Object.fromEntries([...byMetro.entries()].sort()),
    emptyGuAll: guReports.filter((g) => !g.publish).map((g) => `${g.lawd}:${g.name}`),
    seoulDiff,
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  const dryPath =
    SCOPE === "seoul"
      ? `${REPORT_DIR}/seoul-all-asof-align-dry-run.json`
      : ONLY_MISSING
        ? `${REPORT_DIR}/nationwide-all-missing-dry-run.json`
        : `${REPORT_DIR}/nationwide-all-dry-run.json`;
  writeFileSync(dryPath, JSON.stringify({ ...dryReport, guReports, before }, null, 2));
  console.log(JSON.stringify({ phase: "dry-run-report", ...dryReport }, null, 2));

  if (!APPLY) {
    console.log(JSON.stringify({ phase: "done", wrote: false }));
    return;
  }

  const calculatedAt = await writeFeatures(db, built, runId, asOf, windows);

  let pubInserted = 0;
  let pubUpdated = 0;
  let pubSkipped = 0;
  for (const g of guReports.filter((x) => x.publish)) {
    const existing = await db.execute({
      sql: `SELECT ranking_version, transaction_as_of, feature_run_id
            FROM region_ranking_publications
            WHERE region_scope='gu' AND region_code=? AND area_band=? AND period=?`,
      args: [g.lawd, AREA_BAND, PERIOD],
    });
    const rRun = rankingRunId({
      featureRunId: runId,
      rankingVersion: RANKING_VERSION,
      privateConfigFingerprint: PRIVATE_CONFIG_FP,
      regionScope: "gu",
      regionCode: g.lawd,
    });

    if (SCOPE === "nationwide") {
      if (existing.rows.length > 0) {
        pubSkipped += 1;
        continue;
      }
      await db.execute({
        sql: `INSERT INTO region_ranking_publications (
                region_scope, region_code, area_band, period,
                active_ranking_run_id, feature_run_id, ranking_version,
                transaction_as_of, published_at
              ) VALUES ('gu', ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(region_scope, region_code, area_band, period) DO NOTHING`,
        args: [g.lawd, AREA_BAND, PERIOD, rRun, runId, RANKING_VERSION, asOf, calculatedAt],
      });
      pubInserted += 1;
      continue;
    }

    // Seoul: update pointer only (keep old feature snapshots)
    if (existing.rows.length === 0) {
      await db.execute({
        sql: `INSERT INTO region_ranking_publications (
                region_scope, region_code, area_band, period,
                active_ranking_run_id, feature_run_id, ranking_version,
                transaction_as_of, published_at
              ) VALUES ('gu', ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [g.lawd, AREA_BAND, PERIOD, rRun, runId, RANKING_VERSION, asOf, calculatedAt],
      });
      pubInserted += 1;
    } else {
      const row = existing.rows[0]!;
      if (
        String(row.feature_run_id) === runId &&
        String(row.transaction_as_of) === asOf &&
        String(row.ranking_version) === RANKING_VERSION
      ) {
        pubSkipped += 1;
        continue;
      }
      await db.execute({
        sql: `UPDATE region_ranking_publications
              SET active_ranking_run_id=?, feature_run_id=?, ranking_version=?,
                  transaction_as_of=?, published_at=?
              WHERE region_scope='gu' AND region_code=? AND area_band=? AND period=?`,
        args: [rRun, runId, RANKING_VERSION, asOf, calculatedAt, g.lawd, AREA_BAND, PERIOD],
      });
      pubUpdated += 1;
    }
  }

  // Verify old Seoul feature run still present (not deleted)
  let oldSeoulFeatureKept: boolean | null = null;
  if (SCOPE === "seoul" && before[0]?.featureRunId) {
    const old = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM ranking_feature_snapshots
            WHERE feature_run_id=? AND area_band=? AND period=?`,
      args: [before[0].featureRunId, AREA_BAND, PERIOD],
    });
    oldSeoulFeatureKept = Number(old.rows[0]?.n) > 0;
  }

  const applyReport = {
    apply: true,
    scope: SCOPE,
    asOf,
    featureRunId: runId,
    featureRowsAttempted: built.length,
    publicationsInserted: pubInserted,
    publicationsUpdated: pubUpdated,
    publicationsSkippedUnchanged: pubSkipped,
    oldSeoulFeatureKept,
  };
  const applyPath =
    SCOPE === "seoul"
      ? `${REPORT_DIR}/seoul-all-asof-align-apply.json`
      : ONLY_MISSING
        ? `${REPORT_DIR}/nationwide-all-missing-apply.json`
        : `${REPORT_DIR}/nationwide-all-apply.json`;
  writeFileSync(applyPath, JSON.stringify(applyReport, null, 2));
  console.log(JSON.stringify({ phase: "apply-done", ...applyReport }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
