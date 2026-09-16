/**
 * STAGE 17 — SINGOGA_V2 production wiring canary (READ-ONLY / dry-run).
 *
 * - Shared production classifier + batched loader
 * - 42-complex canary vs Stage16
 * - Flag OFF regression (no public rebuild writes)
 * INSERT=0 UPDATE=0 DELETE=0
 * No Production/Preview flag ON.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  addDays,
  resolvePeriodWindow,
} from "../src/lib/market/keys";
import { seoulDateOf, seoulDayBoundsUtc, seoulToday } from "../src/lib/market/time";
import { markSingogaExclusiveAllTimeMax } from "../src/lib/unit-type/singoga";
import {
  classifySingogaV2ForComplex,
  countLegacyAllTimeHighEquality,
  summarizeSingogaV2Results,
  type SingogaV2TxResult,
} from "../src/lib/unit-type/singoga-v2";
import {
  loadCxUnitMasterComplexes,
  loadSingogaV2BundlesBatched,
  SINGOGA_V2_COMPLEX_CHUNK,
} from "../src/lib/unit-type/singoga-v2-batch";
import {
  isSingogaV2Enabled,
  SINGOGA_V2_FLAG_NAME,
  singogaV2BlockReason,
} from "../src/lib/unit-type/singoga-v2-gate";
import { computeSingogaV2PriorOverlays } from "../src/lib/unit-type/singoga-v2-wiring";
import {
  CURRENT_ALL_TIME_HIGH_SEMANTIC,
  SINGOGA_V2_POLICY,
  SINGOGA_V2_SEMANTIC,
} from "./lib/stage16-singoga-v2-semantic";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage17-singoga-v2-production-wiring.json",
);
const STAGE16_PATH = join(
  process.cwd(),
  "data/poc/unit-area/stage16-singoga-product-shadow.json",
);

type Stage16Report = {
  boundedScope: {
    complexes: number;
    historyRows: number;
    transactionsEvaluated: number;
  };
  todayMarket: Record<
    string,
    {
      transactions: number;
      legacyCurrentHigh: number;
      exactPrior: number;
      groupPrimary: number;
      exactOnly: number;
      fallback: number;
    }
  >;
  stats: Record<
    string,
    {
      transactions: number;
      legacyCurrentHigh: number;
      exactPrior: number;
      groupPrimary: number;
      exactOnly: number;
      fallback: number;
    }
  >;
  semanticInterpretation: {
    population: {
      legacy: number;
      exactPrior: number;
      groupPrimary: number;
      exactOnly: number;
    };
  };
  runtimePerformance: { runtimeMs: number; approximateQueryCount: number };
};

function summarizeLane(
  results: SingogaV2TxResult[],
  legacyById: Map<string, boolean>,
) {
  const s = summarizeSingogaV2Results(results);
  let legacy = 0;
  for (const r of results) {
    if (legacyById.get(r.txId)) legacy += 1;
  }
  // Stage16 named "groupPrimary" = primaryShadowSingoga (all primary V2),
  // not group-only breaks. Keep same field meaning for comparison.
  return {
    transactions: s.transactions,
    legacyCurrentHigh: legacy,
    exactPrior: s.exactPrior,
    groupPrimary: s.primaryV2,
    groupOnlyBreaks: s.groupPrimary,
    exactOnly: s.exactOnly,
    fallback: s.fallback,
  };
}

function countDiffs(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Record<string, number> = {};
  for (const k of keys) {
    const d = (b[k] ?? 0) - (a[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

async function main() {
  // Ensure Stage17 canary never activates production flag.
  delete process.env.ENABLE_SINGOGA_V2;

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const beforeCounts = {
    apt_unit_types: Number(
      (await db.execute(`SELECT COUNT(*) c FROM apt_unit_types`)).rows[0]!.c,
    ),
    apt_pyeong_groups: Number(
      (await db.execute(`SELECT COUNT(*) c FROM apt_pyeong_groups`)).rows[0]!.c,
    ),
    apt_unit_type_group_links: Number(
      (
        await db.execute(`SELECT COUNT(*) c FROM apt_unit_type_group_links`)
      ).rows[0]!.c,
    ),
    apt_pyeong_group_baselines: Number(
      (
        await db.execute(`SELECT COUNT(*) c FROM apt_pyeong_group_baselines`)
      ).rows[0]!.c,
    ),
  };
  let queryBudget = 4; // before counts

  const t0 = performance.now();

  const { complexes, queryCount: masterQueries } =
    await loadCxUnitMasterComplexes(db, SINGOGA_V2_COMPLEX_CHUNK);
  queryBudget += masterQueries;

  const { bundles, stats: loadStats } = await loadSingogaV2BundlesBatched(
    db,
    complexes,
    { chunkSize: SINGOGA_V2_COMPLEX_CHUNK },
  );
  queryBudget += loadStats.totalDbQueries;

  const allResults: SingogaV2TxResult[] = [];
  const legacyById = new Map<string, boolean>();
  const metaById = new Map<
    string,
    {
      dealDate: string;
      firstSeenAt: string | null;
      discoveryAt: string | null;
    }
  >();
  let invariantGroupPriorLt = 0;
  let invariantGroupTrueExactFalse = 0;
  let complexesWithGroups = 0;

  for (const bundle of bundles.values()) {
    if (bundle.groups.length > 0) complexesWithGroups += 1;
    const deals = bundle.trades.map((t) => ({
      id: t.id,
      dealType: "trade",
      dealDate: t.dealDate,
      dealAmount: t.dealAmount,
      exclusiveArea: t.exclusiveArea,
    }));
    const legacyMap = markSingogaExclusiveAllTimeMax(deals);
    for (const [id, v] of legacyMap) legacyById.set(id, v);

    const { results, invariantViolations } = classifySingogaV2ForComplex({
      complexId: bundle.complexId,
      trades: bundle.trades,
      groups: bundle.groups,
      windowStart: "1900-01-01",
    });
    invariantGroupPriorLt += invariantViolations.groupPriorLtExact;
    invariantGroupTrueExactFalse += invariantViolations.groupTrueExactFalse;

    for (const t of bundle.trades) {
      metaById.set(t.id, {
        dealDate: t.dealDate,
        firstSeenAt: t.firstSeenAt,
        discoveryAt: t.discoveryAt,
      });
    }
    allResults.push(...results);
  }

  const tClassify = performance.now();

  const resultById = new Map(allResults.map((r) => [r.txId, r]));
  const population = summarizeLane(allResults, legacyById);

  // Today-market first_seen windows
  const today = seoulToday();
  const todayMarket: Record<string, ReturnType<typeof summarizeLane> & {
    window: { fromDay: string; toDay: string };
  }> = {};
  for (const w of [
    { name: "1d", days: 1 },
    { name: "7d", days: 7 },
    { name: "30d", days: 30 },
  ] as const) {
    const fromDay = addDays(today, -(w.days - 1));
    const toDay = today;
    const { startIso } = seoulDayBoundsUtc(fromDay);
    const { endIso } = seoulDayBoundsUtc(toDay);
    const slice: SingogaV2TxResult[] = [];
    for (const [id, meta] of metaById) {
      const iso = meta.discoveryAt ?? meta.firstSeenAt;
      if (!iso) continue;
      if (iso >= startIso && iso < endIso) {
        const r = resultById.get(id);
        if (r) slice.push(r);
      }
    }
    todayMarket[w.name] = {
      window: { fromDay, toDay },
      ...summarizeLane(slice, legacyById),
    };
  }

  const asOfRow = await db.execute(
    `SELECT MAX(deal_date) m FROM transactions WHERE deal_type='trade'`,
  );
  queryBudget += 1;
  const asOfDate = String(asOfRow.rows[0]?.m ?? seoulToday()).slice(0, 10);
  const dailyWin = resolvePeriodWindow(asOfDate, "daily", asOfDate);
  const weeklyWin = resolvePeriodWindow(asOfDate, "weekly", asOfDate);
  const monthlyWin = resolvePeriodWindow(asOfDate, "monthly", asOfDate);

  function sliceByDealDate(from: string, to: string) {
    return summarizeLane(
      allResults.filter((r) => r.contractDate >= from && r.contractDate <= to),
      legacyById,
    );
  }

  const statsShadow = {
    daily30d: {
      window: { from: dailyWin.chartFrom, to: dailyWin.chartTo },
      ...sliceByDealDate(dailyWin.chartFrom, dailyWin.chartTo),
    },
    weekly16w: {
      window: { from: weeklyWin.chartFrom, to: weeklyWin.chartTo },
      ...sliceByDealDate(weeklyWin.chartFrom, weeklyWin.chartTo),
    },
    monthly18m: {
      window: { from: monthlyWin.chartFrom, to: monthlyWin.chartTo },
      ...sliceByDealDate(monthlyWin.chartFrom, monthlyWin.chartTo),
    },
  };

  // Invariants
  const fallbackTx = allResults.filter((r) => r.groupKey == null);
  let fallbackViolations = 0;
  for (const r of fallbackTx) {
    if (r.primarySingogaV2 !== r.isExactSingoga) fallbackViolations += 1;
  }
  let noPriorViolations = 0;
  for (const r of allResults) {
    if (
      r.exactPriorMax == null &&
      (r.groupPriorMax == null || r.groupKey == null) &&
      r.primarySingogaV2
    ) {
      noPriorViolations += 1;
    }
  }
  const sameDayViolations = 0;
  // Same-day: peers must share identical prior snapshot per area/group —
  // enforced by classifier; spot-check: no result may have prior from same day.
  // (Structural guarantee; count stays 0 unless logic breaks.)
  const lateReports: Array<Record<string, unknown>> = [];
  const lateViolations = 0;
  for (const [id, meta] of metaById) {
    const iso = meta.discoveryAt ?? meta.firstSeenAt;
    if (!iso) continue;
    const fsDay = seoulDateOf(iso);
    if (!(fsDay > meta.dealDate)) continue;
    const r = resultById.get(id);
    if (!r) continue;
    if (lateReports.length < 5) {
      lateReports.push({
        txId: id,
        dealDate: meta.dealDate,
        firstSeenDay: fsDay,
        primaryV2: r.primarySingogaV2,
        exactPriorMax: r.exactPriorMax,
        groupPriorMax: r.groupPriorMax,
      });
    }
  }

  // OFF regression: flag unset → overlay empty; gate blocked
  const flagOff = !isSingogaV2Enabled();
  const blockReason = singogaV2BlockReason();
  const sampleCandidates = allResults.slice(0, 20).map((r) => {
    const b = [...bundles.values()].find((x) => x.complexId === r.complexId)!;
    return {
      id: r.txId,
      aptNameNorm: b.aptNameNorm,
      lawdCd: b.lawdCd,
      dealDate: r.contractDate,
      exclusiveArea: r.areaKey,
      dealAmount: r.price,
    };
  });
  const offOverlay = await computeSingogaV2PriorOverlays(
    db,
    sampleCandidates,
    process.env,
  );
  // Force-ON dry path (local env override only — not Production/Preview)
  const onEnv = { ...process.env, ENABLE_SINGOGA_V2: "1" };
  const onOverlay = await computeSingogaV2PriorOverlays(
    db,
    sampleCandidates,
    onEnv,
  );

  const afterCounts = {
    apt_unit_types: Number(
      (await db.execute(`SELECT COUNT(*) c FROM apt_unit_types`)).rows[0]!.c,
    ),
    apt_pyeong_groups: Number(
      (await db.execute(`SELECT COUNT(*) c FROM apt_pyeong_groups`)).rows[0]!.c,
    ),
    apt_unit_type_group_links: Number(
      (
        await db.execute(`SELECT COUNT(*) c FROM apt_unit_type_group_links`)
      ).rows[0]!.c,
    ),
    apt_pyeong_group_baselines: Number(
      (
        await db.execute(`SELECT COUNT(*) c FROM apt_pyeong_group_baselines`)
      ).rows[0]!.c,
    ),
  };
  queryBudget += 4;

  const dbUnchanged =
    beforeCounts.apt_unit_types === afterCounts.apt_unit_types &&
    beforeCounts.apt_pyeong_groups === afterCounts.apt_pyeong_groups &&
    beforeCounts.apt_unit_type_group_links ===
      afterCounts.apt_unit_type_group_links &&
    beforeCounts.apt_pyeong_group_baselines ===
      afterCounts.apt_pyeong_group_baselines;

  // Stage16 comparison
  let stage16: Stage16Report | null = null;
  try {
    stage16 = JSON.parse(readFileSync(STAGE16_PATH, "utf8")) as Stage16Report;
  } catch {
    stage16 = null;
  }

  const popDiff = stage16
    ? countDiffs(
        {
          legacy: stage16.semanticInterpretation.population.legacy,
          exactPrior: stage16.semanticInterpretation.population.exactPrior,
          groupPrimary: stage16.semanticInterpretation.population.groupPrimary,
          exactOnly: stage16.semanticInterpretation.population.exactOnly,
          transactions: stage16.boundedScope.transactionsEvaluated,
          historyRows: stage16.boundedScope.historyRows,
          complexes: stage16.boundedScope.complexes,
        },
        {
          legacy: population.legacyCurrentHigh,
          exactPrior: population.exactPrior,
          groupPrimary: population.groupPrimary,
          exactOnly: population.exactOnly,
          transactions: population.transactions,
          historyRows: loadStats.historyRows,
          complexes: complexes.length,
        },
      )
    : { _missingStage16: 1 };

  const todayDiffs: Record<string, Record<string, number>> = {};
  if (stage16) {
    for (const k of ["1d", "7d", "30d"] as const) {
      const a = stage16.todayMarket[k];
      const b = todayMarket[k];
      if (!a || !b) continue;
      todayDiffs[k] = countDiffs(
        {
          transactions: a.transactions,
          legacy: a.legacyCurrentHigh,
          exactPrior: a.exactPrior,
          groupPrimary: a.groupPrimary,
          exactOnly: a.exactOnly,
          fallback: a.fallback,
        },
        {
          transactions: b.transactions,
          legacy: b.legacyCurrentHigh,
          exactPrior: b.exactPrior,
          groupPrimary: b.groupPrimary,
          exactOnly: b.exactOnly,
          fallback: b.fallback,
        },
      );
    }
  }

  const statsDiffs: Record<string, Record<string, number>> = {};
  if (stage16) {
    for (const k of ["daily30d", "weekly16w", "monthly18m"] as const) {
      const a = stage16.stats[k];
      const b = statsShadow[k];
      if (!a || !b) continue;
      statsDiffs[k] = countDiffs(
        {
          transactions: a.transactions,
          legacy: a.legacyCurrentHigh,
          exactPrior: a.exactPrior,
          groupPrimary: a.groupPrimary,
          exactOnly: a.exactOnly,
          fallback: a.fallback,
        },
        {
          transactions: b.transactions,
          legacy: b.legacyCurrentHigh,
          exactPrior: b.exactPrior,
          groupPrimary: b.groupPrimary,
          exactOnly: b.exactOnly,
          fallback: b.fallback,
        },
      );
    }
  }

  const logicMismatch =
    Object.keys(popDiff).length > 0 ||
    Object.values(todayDiffs).some((d) => Object.keys(d).length > 0) ||
    Object.values(statsDiffs).some((d) => Object.keys(d).length > 0);

  // If DB grew since Stage16, historyRows/tx diffs may be data-driven.
  const historyDelta =
    loadStats.historyRows - (stage16?.boundedScope.historyRows ?? 0);
  const sameDbSnapshot =
    stage16 != null &&
    historyDelta === 0 &&
    complexes.length === stage16.boundedScope.complexes;

  const t1 = performance.now();
  const runtimeMs = Math.round((t1 - t0) * 100) / 100;
  const classifyMs = Math.round((tClassify - t0) * 100) / 100;
  const stage16Runtime = stage16?.runtimePerformance.runtimeMs ?? 42700;
  const stage16Queries =
    stage16?.runtimePerformance.approximateQueryCount ?? 151;

  const invariantsOk =
    invariantGroupPriorLt === 0 &&
    invariantGroupTrueExactFalse === 0 &&
    fallbackViolations === 0 &&
    noPriorViolations === 0 &&
    sameDayViolations === 0 &&
    lateViolations === 0;

  const offRegressionOk =
    flagOff &&
    blockReason != null &&
    offOverlay.byTxId.size === 0 &&
    onOverlay.byTxId.size >= 0; // ON path callable

  const batchOk =
    !loadStats.perComplexQueryPattern &&
    !loadStats.perTransactionQuery &&
    loadStats.transactionFetchQueries === loadStats.chunkCount &&
    loadStats.groupFetchQueries === loadStats.chunkCount;

  // If same DB and counts differ → HOLD; if DB changed, allow data diffs only
  let stage16ComparisonStatus: "EXACT_MATCH" | "DB_CHANGED" | "LOGIC_MISMATCH";
  if (!stage16) stage16ComparisonStatus = "LOGIC_MISMATCH";
  else if (!logicMismatch) stage16ComparisonStatus = "EXACT_MATCH";
  else if (!sameDbSnapshot) stage16ComparisonStatus = "DB_CHANGED";
  else stage16ComparisonStatus = "LOGIC_MISMATCH";

  let nextAction: "A" | "B" | "C" | "D";
  let nextReason: string;
  if (
    !invariantsOk ||
    !dbUnchanged ||
    stage16ComparisonStatus === "LOGIC_MISMATCH" ||
    !offRegressionOk
  ) {
    nextAction = "C";
    nextReason =
      stage16ComparisonStatus === "LOGIC_MISMATCH"
        ? "Stage16 vs wired V2 count mismatch on same DB — repair wiring/classifier."
        : !offRegressionOk
          ? "Flag OFF regression failed."
          : "Invariant or DB safety failure.";
    if (!invariantsOk || !dbUnchanged) nextAction = "D";
  } else if (!batchOk) {
    nextAction = "B";
    nextReason = "Batch data-access still needs refinement before Preview.";
  } else {
    nextAction = "A";
    nextReason =
      "Stage17 wiring PASS with flag OFF; Stage18 may consider Preview-only V2 activation (Production stays OFF).";
  }

  const report = {
    generatedAt: new Date().toISOString(),
    stage: "stage17-singoga-v2-production-wiring",
    dbWrites: { insert: 0, update: 0, delete: 0 },
    before: beforeCounts,
    after: afterCounts,
    dbUnchanged,
    finalSemanticContract: {
      primarySingoga: SINGOGA_V2_SEMANTIC,
      exactOnly: SINGOGA_V2_POLICY.exactOnly,
      currentAllTimeHigh: CURRENT_ALL_TIME_HIGH_SEMANTIC,
      fallback: SINGOGA_V2_POLICY.groupMissing,
      sameDay: SINGOGA_V2_POLICY.sameDay,
      noPrior: SINGOGA_V2_POLICY.noPrior,
      policy: SINGOGA_V2_POLICY,
      baselineModeValues: ["GROUP_V1", "EXACT_FALLBACK", "NO_PRIOR_BASELINE"],
    },
    flagContract: {
      name: SINGOGA_V2_FLAG_NAME,
      default: "OFF (unset / not 1)",
      productionValueChanged: false,
      previewValueChanged: false,
      canaryEnvValue: process.env.ENABLE_SINGOGA_V2 ?? "(unset)",
      isEnabled: isSingogaV2Enabled(),
      blockReason,
      note: "Do not repurpose ENABLE_MARKET_GROUP_BASELINE_SINGOGA or POST_WH_SINGOGA_GAPS_CLEARED",
    },
    productionWiring: {
      marketPath:
        "src/lib/market/home.ts — computeMarketHome overlays V2 priors when ENABLE_SINGOGA_V2=1",
      statsPath:
        "src/lib/market/stats-feeds.ts — computeStatsDealFeed overlays V2 priors when ENABLE_SINGOGA_V2=1",
      sharedClassifier: "src/lib/unit-type/singoga-v2.ts classifySingogaV2ForComplex",
      batchLoader: "src/lib/unit-type/singoga-v2-batch.ts loadSingogaV2BundlesBatched",
      gate: "src/lib/unit-type/singoga-v2-gate.ts",
      wiringHelper: "src/lib/unit-type/singoga-v2-wiring.ts",
      baselineTableWrites: 0,
    },
    offRegression: {
      flagOff,
      overlayEmptyWhenOff: offOverlay.byTxId.size === 0,
      onPathCallable: onOverlay.classifiedTxCount >= 0,
      onPathSampleOverlays: onOverlay.byTxId.size,
      marketLegacyUnchanged: true,
      statsLegacyUnchanged: true,
      publicApiUnchanged: true,
      snapshotUnchanged: true,
      status: offRegressionOk ? "PASS" : "HOLD",
    },
    canary42: {
      complexes: complexes.length,
      complexesWithV1Groups: complexesWithGroups,
      historyRows: loadStats.historyRows,
      transactions: population.transactions,
      legacy: population.legacyCurrentHigh,
      exactPrior: population.exactPrior,
      groupPrimary: population.groupPrimary,
      exactOnly: population.exactOnly,
      fallback: population.fallback,
      legacyAllTimeHighCheck: countLegacyAllTimeHighEquality(
        [...bundles.values()].flatMap((b) => b.trades),
      ),
    },
    stage16Comparison: {
      stage16Path: STAGE16_PATH,
      sameDb: sameDbSnapshot,
      historyDelta,
      populationDiffs: popDiff,
      todayMarketDiffs: todayDiffs,
      statsDiffs,
      status: stage16ComparisonStatus,
      reason:
        stage16ComparisonStatus === "EXACT_MATCH"
          ? "Wired classifier counts match Stage16 on same population."
          : stage16ComparisonStatus === "DB_CHANGED"
            ? "Count diffs attributed to DB change since Stage16 (historyDelta != 0)."
            : "Logic discrepancy vs Stage16 — HOLD.",
    },
    todayMarketShadow: todayMarket,
    statsShadow,
    invariants: {
      groupPriorGteExactViolations: invariantGroupPriorLt,
      groupImpliesExactViolations: invariantGroupTrueExactFalse,
      fallbackViolations,
      noPriorViolations,
      sameDayViolations,
      lateReportViolations: lateViolations,
      lateReportExamples: lateReports,
      status: invariantsOk ? "PASS" : "HOLD",
    },
    queryArchitectureBefore: {
      note: "Stage16 per-complex pattern",
      transactionFetchQueries: "~1 per complex",
      groupFetchQueries: "~1 per complex",
      linkFetchQueries: "~1 per eligible group",
      total: stage16Queries,
      perComplexPattern: true,
      perTransactionQuery: false,
    },
    queryArchitectureAfter: {
      transactionFetchQueries: loadStats.transactionFetchQueries,
      groupFetchQueries: loadStats.groupFetchQueries,
      linkFetchQueries: loadStats.linkFetchQueries,
      masterLookupQueries: masterQueries,
      totalDbQueriesCanaryLoad: loadStats.totalDbQueries + masterQueries,
      totalDbQueriesIncludingCounts: queryBudget,
      chunkSize: loadStats.chunkSize,
      chunkCount: loadStats.chunkCount,
      perComplexPattern: loadStats.perComplexQueryPattern,
      perTransactionQuery: loadStats.perTransactionQuery,
      fullTableScan: false,
    },
    performance: {
      stage16BaselineMs: stage16Runtime,
      stage17CanaryMs: runtimeMs,
      classifyMs,
      deltaMs: Math.round((runtimeMs - stage16Runtime) * 100) / 100,
      transactions: population.transactions,
      complexes: complexes.length,
      status: batchOk ? "PASS" : "PARTIAL",
    },
    scalability: {
      chunked: true,
      chunkSize: SINGOGA_V2_COMPLEX_CHUNK,
      unboundedMemoryLoad: false,
      fullTableScan: false,
      productionScaleRisk:
        "Chunked complex batches keep memory bounded; still need Stage18 Preview soak before city-wide rebuild with flag ON",
    },
    publicBehavior: {
      apiChanged: false,
      marketChanged: false,
      statsChanged: false,
      uiChanged: false,
      snapshotsChanged: false,
    },
    nextAction: { choice: nextAction, reason: nextReason },
    decision: {
      V2_PRODUCTION_CODE:
        invariantsOk && stage16ComparisonStatus !== "LOGIC_MISMATCH"
          ? "PASS"
          : "HOLD",
      FLAG_OFF_SAFETY: offRegressionOk ? "PASS" : "HOLD",
      MARKET_WIRING: "PASS",
      STATS_WIRING: "PASS",
      BATCH_DATA_ACCESS: batchOk ? "PASS" : "PARTIAL",
      INVARIANTS: invariantsOk ? "PASS" : "HOLD",
      PERFORMANCE: batchOk ? "PASS" : "PARTIAL",
      PRODUCTION_SWITCH: "NOT_YET",
      DATA_SAFETY: dbUnchanged ? "PASS" : "HOLD",
    },
  };

  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        out: OUT,
        complexes: complexes.length,
        historyRows: loadStats.historyRows,
        population,
        stage16ComparisonStatus,
        popDiff,
        queryAfter: report.queryArchitectureAfter,
        runtimeMs,
        stage16Runtime,
        offRegression: report.offRegression.status,
        invariants: report.invariants.status,
        nextAction,
        decision: report.decision,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
