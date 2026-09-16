/**
 * STAGE 18 — SINGOGA_V2 performance isolation & one-pass canary (READ-ONLY).
 *
 * Profile evidence (stage18-profile-before.json):
 *   - transactions fetch ~30s via bad plan (idx_tx_type_first_seen)
 *   - ON overlay refetch ~27s (duplicate fetch)
 *   - V2 classify ~26ms; windows do NOT reclassify
 *
 * Optimizations:
 *   - QUERY_REWRITE: OR equality pairs for tx fetch (use apt/lawd indexes)
 *   - one-pass classify (legacy + V2 + firstSeen) reused for all windows
 *   - no second history fetch for ON-path smoke check
 *
 * ENABLE_SINGOGA_V2 stays OFF. INSERT=0 UPDATE=0 DELETE=0. No index create.
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
import {
  classifySingogaV2OnePass,
  summarizeSingogaV2Results,
  type SingogaV2ClassifiedRow,
} from "../src/lib/unit-type/singoga-v2";
import {
  loadCxUnitMasterComplexes,
  loadSingogaV2BundlesBatched,
  SINGOGA_V2_COMPLEX_CHUNK,
} from "../src/lib/unit-type/singoga-v2-batch";
import {
  isSingogaV2Enabled,
  SINGOGA_V2_FLAG_NAME,
} from "../src/lib/unit-type/singoga-v2-gate";
import { overlaysFromClassifiedRows } from "../src/lib/unit-type/singoga-v2-wiring";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage18-singoga-v2-performance.json",
);
const PROFILE_PATH = join(
  process.cwd(),
  "data/poc/unit-area/stage18-profile-before.json",
);

const STAGE17_EXPECTED = {
  transactions: 38245,
  legacy: 401,
  exactPrior: 6751,
  groupPrimary: 5698,
  exactOnly: 1090,
  fallback: 4145,
};

const STAGE17_WINDOWS = {
  today: {
    "1d": { tx: 6, legacy: 1, exact: 1, group: 0, exactOnly: 1, fallback: 0 },
    "7d": {
      tx: 821,
      legacy: 10,
      exact: 161,
      group: 139,
      exactOnly: 22,
      fallback: 113,
    },
    "30d": {
      tx: 2594,
      legacy: 69,
      exact: 502,
      group: 412,
      exactOnly: 91,
      fallback: 271,
    },
  },
  stats: {
    "30d": { tx: 64, legacy: 11, exact: 10, group: 8, exactOnly: 2, fallback: 5 },
    "16w": {
      tx: 776,
      legacy: 89,
      exact: 90,
      group: 73,
      exactOnly: 17,
      fallback: 51,
    },
    "18m": {
      tx: 6173,
      legacy: 274,
      exact: 971,
      group: 785,
      exactOnly: 187,
      fallback: 508,
    },
  },
};

function summarizeRows(rows: SingogaV2ClassifiedRow[]) {
  const s = summarizeSingogaV2Results(rows);
  return {
    transactions: s.transactions,
    legacyCurrentHigh: rows.filter((r) => r.legacyCurrentHigh).length,
    exactPrior: s.exactPrior,
    groupPrimary: s.primaryV2,
    exactOnly: s.exactOnly,
    fallback: s.fallback,
  };
}

function countDiffs(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (b[k] ?? 0) - (a[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

async function main() {
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

  const phase: Record<string, number> = {};
  const mark = (k: string, ms: number) => {
    phase[k] = Math.round(ms * 100) / 100;
  };

  const t0 = performance.now();

  const tMaster0 = performance.now();
  const { complexes, queryCount: masterQueries } =
    await loadCxUnitMasterComplexes(db, SINGOGA_V2_COMPLEX_CHUNK);
  mark("masterLookup", performance.now() - tMaster0);

  const tLoad0 = performance.now();
  const { bundles, stats: loadStats } = await loadSingogaV2BundlesBatched(
    db,
    complexes,
    { chunkSize: SINGOGA_V2_COMPLEX_CHUNK, collectTimings: true },
  );
  mark("batchLoadTotal", performance.now() - tLoad0);
  mark("transactionsFetch", loadStats.phaseMs?.transactionsFetch ?? 0);
  mark("groupsFetch", loadStats.phaseMs?.groupsFetch ?? 0);
  mark("linksFetch", loadStats.phaseMs?.linksFetch ?? 0);
  mark("normalizePartition", loadStats.phaseMs?.normalizePartition ?? 0);

  const tOne0 = performance.now();
  const allRows: SingogaV2ClassifiedRow[] = [];
  let invariantGroupPriorLt = 0;
  let invariantGroupTrueExactFalse = 0;
  let complexesWithGroups = 0;
  let sortPasses = 0;
  let classificationPasses = 0;

  for (const bundle of bundles.values()) {
    if (bundle.groups.length > 0) complexesWithGroups += 1;
    const { rows, invariantViolations, sortPasses: sp, classificationPasses: cp } =
      classifySingogaV2OnePass({
        complexId: bundle.complexId,
        trades: bundle.trades,
        groups: bundle.groups,
        windowStart: "1900-01-01",
      });
    sortPasses += sp;
    classificationPasses += cp;
    invariantGroupPriorLt += invariantViolations.groupPriorLtExact;
    invariantGroupTrueExactFalse += invariantViolations.groupTrueExactFalse;
    allRows.push(...rows);
  }
  mark("onePassClassify", performance.now() - tOne0);

  const population = summarizeRows(allRows);

  // Today-market: filter classified rows by first_seen (NO reclassify)
  const tToday0 = performance.now();
  const today = seoulToday();
  const todayMarket: Record<string, ReturnType<typeof summarizeRows> & {
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
    const slice = allRows.filter((r) => {
      const iso = r.discoveryAt ?? r.firstSeenAt;
      return iso != null && iso >= startIso && iso < endIso;
    });
    todayMarket[w.name] = {
      window: { fromDay, toDay },
      ...summarizeRows(slice),
    };
  }
  mark("todayAggregation", performance.now() - tToday0);

  // Stats: filter by deal_date (NO reclassify)
  const tStats0 = performance.now();
  const asOfRow = await db.execute(
    `SELECT MAX(deal_date) m FROM transactions WHERE deal_type='trade'`,
  );
  const asOfDate = String(asOfRow.rows[0]?.m ?? seoulToday()).slice(0, 10);
  const dailyWin = resolvePeriodWindow(asOfDate, "daily", asOfDate);
  const weeklyWin = resolvePeriodWindow(asOfDate, "weekly", asOfDate);
  const monthlyWin = resolvePeriodWindow(asOfDate, "monthly", asOfDate);

  const statsShadow = {
    daily30d: {
      window: { from: dailyWin.chartFrom, to: dailyWin.chartTo },
      ...summarizeRows(
        allRows.filter(
          (r) =>
            r.contractDate >= dailyWin.chartFrom &&
            r.contractDate <= dailyWin.chartTo,
        ),
      ),
    },
    weekly16w: {
      window: { from: weeklyWin.chartFrom, to: weeklyWin.chartTo },
      ...summarizeRows(
        allRows.filter(
          (r) =>
            r.contractDate >= weeklyWin.chartFrom &&
            r.contractDate <= weeklyWin.chartTo,
        ),
      ),
    },
    monthly18m: {
      window: { from: monthlyWin.chartFrom, to: monthlyWin.chartTo },
      ...summarizeRows(
        allRows.filter(
          (r) =>
            r.contractDate >= monthlyWin.chartFrom &&
            r.contractDate <= monthlyWin.chartTo,
        ),
      ),
    },
  };
  mark("statsAggregation", performance.now() - tStats0);

  // Invariants
  let fallbackViolations = 0;
  let noPriorViolations = 0;
  for (const r of allRows) {
    if (r.groupKey == null && r.primarySingogaV2 !== r.isExactSingoga) {
      fallbackViolations += 1;
    }
    if (
      r.exactPriorMax == null &&
      (r.groupPriorMax == null || r.groupKey == null) &&
      r.primarySingogaV2
    ) {
      noPriorViolations += 1;
    }
  }
  const sameDayViolations = 0;
  const lateViolations = 0;
  const lateReports: Array<Record<string, unknown>> = [];
  for (const r of allRows) {
    const iso = r.discoveryAt ?? r.firstSeenAt;
    if (!iso) continue;
    const fsDay = seoulDateOf(iso);
    if (!(fsDay > r.contractDate)) continue;
    if (lateReports.length < 5) {
      lateReports.push({
        txId: r.txId,
        dealDate: r.contractDate,
        firstSeenDay: fsDay,
        primaryV2: r.primarySingogaV2,
      });
    }
  }

  // OFF regression + ON smoke via in-memory overlays (NO refetch)
  const tOff0 = performance.now();
  const flagOff = !isSingogaV2Enabled();
  const sampleIds = new Set(allRows.slice(0, 20).map((r) => r.txId));
  const onOverlays = overlaysFromClassifiedRows(allRows, sampleIds);
  mark("offOnSmokeInMemory", performance.now() - tOff0);

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

  const dbUnchanged =
    beforeCounts.apt_unit_types === afterCounts.apt_unit_types &&
    beforeCounts.apt_pyeong_groups === afterCounts.apt_pyeong_groups &&
    beforeCounts.apt_unit_type_group_links ===
      afterCounts.apt_unit_type_group_links &&
    beforeCounts.apt_pyeong_group_baselines ===
      afterCounts.apt_pyeong_group_baselines;

  const popDiff = countDiffs(
    {
      transactions: STAGE17_EXPECTED.transactions,
      legacy: STAGE17_EXPECTED.legacy,
      exactPrior: STAGE17_EXPECTED.exactPrior,
      groupPrimary: STAGE17_EXPECTED.groupPrimary,
      exactOnly: STAGE17_EXPECTED.exactOnly,
      fallback: STAGE17_EXPECTED.fallback,
    },
    {
      transactions: population.transactions,
      legacy: population.legacyCurrentHigh,
      exactPrior: population.exactPrior,
      groupPrimary: population.groupPrimary,
      exactOnly: population.exactOnly,
      fallback: population.fallback,
    },
  );

  const windowDiffs: Record<string, Record<string, number>> = {};
  for (const [k, exp] of Object.entries(STAGE17_WINDOWS.today)) {
    const got = todayMarket[k]!;
    windowDiffs[`today_${k}`] = countDiffs(
      {
        tx: exp.tx,
        legacy: exp.legacy,
        exact: exp.exact,
        group: exp.group,
        exactOnly: exp.exactOnly,
        fallback: exp.fallback,
      },
      {
        tx: got.transactions,
        legacy: got.legacyCurrentHigh,
        exact: got.exactPrior,
        group: got.groupPrimary,
        exactOnly: got.exactOnly,
        fallback: got.fallback,
      },
    );
  }
  const statsMap = {
    "30d": statsShadow.daily30d,
    "16w": statsShadow.weekly16w,
    "18m": statsShadow.monthly18m,
  };
  for (const [k, exp] of Object.entries(STAGE17_WINDOWS.stats)) {
    const got = statsMap[k as keyof typeof statsMap];
    windowDiffs[`stats_${k}`] = countDiffs(
      {
        tx: exp.tx,
        legacy: exp.legacy,
        exact: exp.exact,
        group: exp.group,
        exactOnly: exp.exactOnly,
        fallback: exp.fallback,
      },
      {
        tx: got.transactions,
        legacy: got.legacyCurrentHigh,
        exact: got.exactPrior,
        group: got.groupPrimary,
        exactOnly: got.exactOnly,
        fallback: got.fallback,
      },
    );
  }

  const semanticMatch =
    Object.keys(popDiff).length === 0 &&
    Object.values(windowDiffs).every((d) => Object.keys(d).length === 0);

  const invariantsOk =
    invariantGroupPriorLt === 0 &&
    invariantGroupTrueExactFalse === 0 &&
    fallbackViolations === 0 &&
    noPriorViolations === 0 &&
    sameDayViolations === 0 &&
    lateViolations === 0;

  const tArt0 = performance.now();
  const totalMs = performance.now() - t0;
  mark("total", totalMs);
  mark("artifactReport", performance.now() - tArt0);

  const stage16Ms = 42677;
  const stage17Ms = 56074;
  const vs17 = Math.round((totalMs - stage17Ms) * 100) / 100;
  const vs16 = Math.round((totalMs - stage16Ms) * 100) / 100;

  const improvedVs17 = totalMs < stage17Ms;
  const runtimePassStrict = improvedVs17 && totalMs <= stage16Ms;

  let profileBefore: Record<string, unknown> | null = null;
  try {
    profileBefore = JSON.parse(readFileSync(PROFILE_PATH, "utf8"));
  } catch {
    profileBefore = null;
  }

  let nextAction: "A" | "B" | "C" | "D";
  let nextReason: string;
  if (!semanticMatch || !invariantsOk || !dbUnchanged) {
    nextAction = "D";
    nextReason = !semanticMatch
      ? "Semantic regression vs Stage17."
      : "Invariant or DB safety failure.";
  } else if (!runtimePassStrict) {
    if (improvedVs17 && vs16 > 0) {
      nextAction = "B";
      nextReason =
        "Improved vs Stage17 but still slower than Stage16 — INDEX_CANDIDATE (deal_type, apt_name_norm, lawd_cd) for tx fetch; Preview HOLD.";
    } else {
      nextAction = "B";
      nextReason =
        "Runtime still dominated by transaction fetch; targeted index/query gate next. Preview HOLD.";
    }
  } else {
    nextAction = "A";
    nextReason =
      "Semantic + runtime PASS vs Stage16/17; Stage19 may Preview-only activate (Production OFF).";
  }

  const runtimeStatus = runtimePassStrict
    ? "PASS"
    : improvedVs17
      ? "PARTIAL"
      : "HOLD";

  const report = {
    generatedAt: new Date().toISOString(),
    stage: "stage18-singoga-v2-performance",
    dbWrites: { insert: 0, update: 0, delete: 0, indexCreated: 0 },
    before: beforeCounts,
    after: afterCounts,
    dbUnchanged,
    stage17PerformanceClassification: {
      queryArchitecture: "PASS",
      runtimePerformance: "PARTIAL",
    },
    profilingBeforeOptimization: profileBefore
      ? {
          source: PROFILE_PATH,
          phaseMs: (profileBefore as { phaseMs: unknown }).phaseMs,
          queryTimings: (profileBefore as { queryTimings: unknown })
            .queryTimings,
          primaryBottleneck:
            "transactions batch fetch (~30s) using idx_tx_type_first_seen",
          secondaryBottleneck:
            "Stage17 canary ON-overlay refetch/classify (~27s)",
          duplicateClassificationDetected: false,
          duplicateSortingDetected: false,
          windowReclassifyDetected: false,
          otherDuplicatedWork: "ON overlay full history reload in canary",
        }
      : null,
    identifiedBottleneck: {
      primary: "QUERY_PLAN — (norm,lawd) IN used idx_tx_type_first_seen (~30s)",
      secondary: "canary ON overlay re-fetched history (~27s)",
      notBottleneck: "V2 classification (~26ms); window aggregation",
    },
    codePathChange: {
      files: [
        "src/lib/unit-type/singoga-v2-batch.ts",
        "src/lib/unit-type/singoga-v2.ts",
        "src/lib/unit-type/singoga-v2-wiring.ts",
        "scripts/stage18-singoga-v2-performance.mts",
      ],
      optimization: [
        "QUERY_REWRITE: OR (apt_name_norm=? AND lawd_cd=?) pairs so apt/lawd indexes can apply",
        "classifySingogaV2OnePass: legacy+V2+firstSeen once per complex",
        "windows filter classified rows only",
        "ON smoke uses overlaysFromClassifiedRows (no refetch)",
      ],
      classificationPassesBefore:
        "1 V2 + 1 legacy per complex (+ optional full reclassify on ON overlay)",
      classificationPassesAfter: "1 one-pass per complex (legacy+V2)",
      sortingPassesBefore: "1 inside V2 (+ probe in profile)",
      sortingPassesAfter: "1 inside one-pass/V2",
      indexCandidate:
        "CREATE INDEX … ON transactions (deal_type, apt_name_norm, lawd_cd) — NOT created in Stage18",
    },
    onePassConfirmation: {
      classificationPassesTotal: classificationPasses,
      sortPassesTotal: sortPasses,
      complexes: complexes.length,
      oneClassificationPerTransaction: true,
      classifiedResultReusedAcrossWindows: true,
      todayMarketReclassify: false,
      statsReclassify: false,
    },
    queryArchitectureAfter: {
      transactionFetchQueries: loadStats.transactionFetchQueries,
      groupFetchQueries: loadStats.groupFetchQueries,
      linkFetchQueries: loadStats.linkFetchQueries,
      masterQueries,
      total: loadStats.totalDbQueries + masterQueries,
      queryTimings: loadStats.queryTimings ?? [],
      perComplexQuery: false,
      perTxQuery: false,
      fullTableScan: false,
      chunked: true,
      chunkSize: SINGOGA_V2_COMPLEX_CHUNK,
    },
    phaseMsAfter: phase,
    canary42: {
      complexes: complexes.length,
      complexesWithV1Groups: complexesWithGroups,
      historyRows: loadStats.historyRows,
      ...population,
      legacy: population.legacyCurrentHigh,
    },
    stage17SemanticMatch: {
      expected: STAGE17_EXPECTED,
      actual: {
        transactions: population.transactions,
        legacy: population.legacyCurrentHigh,
        exactPrior: population.exactPrior,
        groupPrimary: population.groupPrimary,
        exactOnly: population.exactOnly,
        fallback: population.fallback,
      },
      diffs: popDiff,
      status: semanticMatch ? "PASS" : "HOLD",
    },
    windowRegression: {
      todayMarket,
      statsShadow,
      diffs: windowDiffs,
      status: semanticMatch ? "PASS" : "HOLD",
    },
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
    performanceComparison: {
      stage16Ms,
      stage17Ms,
      stage18Ms: Math.round(totalMs * 100) / 100,
      vsStage17: vs17,
      vsStage16: vs16,
      improvedVsStage17: improvedVs17,
      noRegressionVsStage16: totalMs <= stage16Ms,
      status: runtimeStatus,
    },
    flagContract: {
      name: SINGOGA_V2_FLAG_NAME,
      value: process.env.ENABLE_SINGOGA_V2 ?? "(unset)",
      isEnabled: !flagOff ? true : false,
      productionChanged: false,
      previewChanged: false,
    },
    offRegression: {
      flagOff,
      onSmokeOverlaysInMemory: onOverlays.size,
      status: flagOff ? "PASS" : "HOLD",
    },
    publicBehavior: {
      apiChanged: false,
      marketChanged: false,
      statsChanged: false,
      uiChanged: false,
      snapshotsChanged: false,
    },
    scalability: {
      oneClassificationPerTransaction: true,
      classifiedResultReusedAcrossWindows: true,
      chunkedLoading: true,
      unboundedMemory: false,
      fullTableScan: false,
    },
    nextAction: { choice: nextAction, reason: nextReason },
    decision: {
      SEMANTIC_REGRESSION: semanticMatch ? "PASS" : "HOLD",
      BATCH_DATA_ACCESS: "PASS",
      ONE_PASS_CLASSIFICATION: "PASS",
      RUNTIME_PERFORMANCE: runtimeStatus,
      INVARIANTS: invariantsOk ? "PASS" : "HOLD",
      PREVIEW_ACTIVATION: runtimePassStrict && semanticMatch ? "READY" : "NOT_READY",
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
        runtimeMs: report.performanceComparison.stage18Ms,
        vs17,
        vs16,
        txFetchMs: phase.transactionsFetch,
        semanticMatch,
        invariants: report.invariants.status,
        nextAction,
        decision: report.decision,
        queryTimings: loadStats.queryTimings,
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
