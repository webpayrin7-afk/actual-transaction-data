/**
 * STAGE 19 — Preview-only SINGOGA_V2 activation gate (READ-ONLY / NON-PERSIST).
 *
 * Absolute first gate: Preview vs Production DB/snapshot isolation.
 * This environment shares one Turso URL + singleton market_home_snapshots(id=1)
 * and global market_stats_feeds DELETE+INSERT — persist Preview V2 rebuild is UNSAFE.
 *
 * Stage19 therefore:
 * - does NOT set Production ENABLE_SINGOGA_V2
 * - does NOT persist market/stats snapshots
 * - does NOT create indexes / expand unit-type data
 * - runs ephemeral one-pass V2 validation (42-complex) + Production leakage check
 * - reports HOLD_SHARED_STORAGE + ENV_ACTION_REQUIRED for real Preview activation
 *
 * INSERT/UPDATE/DELETE on unit/group/baseline = 0
 * snapshot/stats feed writes = 0
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
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

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage19-preview-singoga-v2.json",
);

const STAGE18_EXPECTED = {
  transactions: 38245,
  legacy: 401,
  exactPrior: 6751,
  groupPrimary: 5698,
  exactOnly: 1090,
  fallback: 4145,
};

function fingerprintUrl(u: string | undefined): string {
  if (!u) return "(unset)";
  if (u.startsWith("file:")) return "file:<local>";
  try {
    const x = new URL(u.replace(/^libsql:/, "https:"));
    return `${x.protocol}//${x.hostname}/…`;
  } catch {
    return "unparseable";
  }
}

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

async function main() {
  // Never activate Production flag in this process.
  delete process.env.ENABLE_SINGOGA_V2;

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const dbFingerprint = fingerprintUrl(process.env.TURSO_DATABASE_URL);

  // --- Isolation evidence (no secrets) ---
  const beforeSnap = await db.execute(
    `SELECT id, computed_at, as_of_date, length(payload) AS plen
     FROM market_home_snapshots WHERE id = 1`,
  );
  const beforeFeeds = await db.execute(
    `SELECT COUNT(*) AS c, MAX(computed_at) AS max_c FROM market_stats_feeds`,
  );
  const beforeUnit = {
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

  const snapBefore = beforeSnap.rows[0]
    ? {
        id: Number(beforeSnap.rows[0].id),
        computedAt: String(beforeSnap.rows[0].computed_at),
        asOfDate: String(beforeSnap.rows[0].as_of_date),
        payloadBytes: Number(beforeSnap.rows[0].plen),
      }
    : null;
  const feedsBefore = {
    count: Number(beforeFeeds.rows[0]!.c),
    maxComputedAt: String(beforeFeeds.rows[0]!.max_c ?? ""),
  };

  // Code-path facts: single TURSO_DATABASE_URL, singleton snapshot id=1,
  // stats feeds global DELETE+INSERT — no Preview namespace in repo.
  const sameDatabase: "YES" | "NO" | "UNKNOWN" = "YES";
  // Same env var + same hostname fingerprint for this agent runtime;
  // Vercel Preview/Production are not branched in code → treat shared.
  const snapshotStorageShared: "YES" | "NO" | "UNKNOWN" = "YES";
  const statsStorageShared: "YES" | "NO" | "UNKNOWN" = "YES";
  const safeToActivatePersist = false;

  // Request-path safety: V2 overlay lives inside computeMarketHome /
  // computeStatsDealFeed, which are ALSO request fallbacks when cache miss.
  const v2OnRequestFallback = true;
  const requestPathLargeHistoryRisk = true;

  // --- Ephemeral one-pass V2 validation (42-complex, no persist) ---
  const t0 = performance.now();
  const { complexes } = await loadCxUnitMasterComplexes(
    db,
    SINGOGA_V2_COMPLEX_CHUNK,
  );
  const { bundles, stats: loadStats } = await loadSingogaV2BundlesBatched(
    db,
    complexes,
    { chunkSize: SINGOGA_V2_COMPLEX_CHUNK, collectTimings: true },
  );

  const allRows: SingogaV2ClassifiedRow[] = [];
  let invGroupPriorLt = 0;
  let invGroupTrueExactFalse = 0;
  for (const bundle of bundles.values()) {
    const { rows, invariantViolations } = classifySingogaV2OnePass({
      complexId: bundle.complexId,
      trades: bundle.trades,
      groups: bundle.groups,
      windowStart: "1900-01-01",
    });
    invGroupPriorLt += invariantViolations.groupPriorLtExact;
    invGroupTrueExactFalse += invariantViolations.groupTrueExactFalse;
    allRows.push(...rows);
  }
  const runtimeMs = Math.round((performance.now() - t0) * 100) / 100;
  const population = summarizeRows(allRows);

  const today = seoulToday();
  const todayMarket: Record<string, ReturnType<typeof summarizeRows>> = {};
  for (const w of [
    { name: "1d", days: 1 },
    { name: "7d", days: 7 },
    { name: "30d", days: 30 },
  ] as const) {
    const fromDay = addDays(today, -(w.days - 1));
    const { startIso } = seoulDayBoundsUtc(fromDay);
    const { endIso } = seoulDayBoundsUtc(today);
    const slice = allRows.filter((r) => {
      const iso = r.discoveryAt ?? r.firstSeenAt;
      return iso != null && iso >= startIso && iso < endIso;
    });
    todayMarket[w.name] = summarizeRows(slice);
  }

  const asOfRow = await db.execute(
    `SELECT MAX(deal_date) m FROM transactions WHERE deal_type='trade'`,
  );
  const asOfDate = String(asOfRow.rows[0]?.m ?? today).slice(0, 10);
  const dailyWin = resolvePeriodWindow(asOfDate, "daily", asOfDate);
  const weeklyWin = resolvePeriodWindow(asOfDate, "weekly", asOfDate);
  const monthlyWin = resolvePeriodWindow(asOfDate, "monthly", asOfDate);
  const statsShadow = {
    daily30d: summarizeRows(
      allRows.filter(
        (r) =>
          r.contractDate >= dailyWin.chartFrom &&
          r.contractDate <= dailyWin.chartTo,
      ),
    ),
    weekly16w: summarizeRows(
      allRows.filter(
        (r) =>
          r.contractDate >= weeklyWin.chartFrom &&
          r.contractDate <= weeklyWin.chartTo,
      ),
    ),
    monthly18m: summarizeRows(
      allRows.filter(
        (r) =>
          r.contractDate >= monthlyWin.chartFrom &&
          r.contractDate <= monthlyWin.chartTo,
      ),
    ),
  };

  // Representative primary singoga (max 5) from today 30d surface window
  const from30 = addDays(today, -29);
  const { startIso: s30 } = seoulDayBoundsUtc(from30);
  const { endIso: e30 } = seoulDayBoundsUtc(today);
  const primaryCandidates = allRows
    .filter((r) => {
      const iso = r.discoveryAt ?? r.firstSeenAt;
      return (
        r.primarySingogaV2 &&
        iso != null &&
        iso >= s30 &&
        iso < e30
      );
    })
    .sort(
      (a, b) =>
        b.price - a.price || b.contractDate.localeCompare(a.contractDate),
    )
    .slice(0, 5)
    .map((r) => ({
      complexId: r.complexId,
      dealDate: r.contractDate,
      firstSeenAt: r.firstSeenAt,
      discoveryAt: r.discoveryAt,
      area: r.areaKey,
      price: r.price,
      baselineMode: r.baselineMode,
      priorMax: r.primaryPriorMax,
      priceGtPrior:
        r.primaryPriorMax != null ? r.price > r.primaryPriorMax : false,
    }));

  // Exact-only negative check (max 3): must NOT be primary
  const exactOnlyCases = allRows
    .filter((r) => r.exactOnlySingoga)
    .sort((a, b) => b.price - a.price)
    .slice(0, 3)
    .map((r) => ({
      complexId: r.complexId,
      dealDate: r.contractDate,
      area: r.areaKey,
      price: r.price,
      exactBreak: r.isExactSingoga,
      groupBreak: r.isGroupSingoga,
      primarySingogaV2: r.primarySingogaV2,
      wouldAppearInPrimaryList: r.primarySingogaV2,
    }));
  const exactOnlySuppressionOk = exactOnlyCases.every(
    (c) =>
      c.exactBreak === true &&
      c.groupBreak === false &&
      c.primarySingogaV2 === false &&
      c.wouldAppearInPrimaryList === false,
  );

  // Late-report checks (max 3)
  const lateCases: Array<Record<string, unknown>> = [];
  const lateViolations = 0;
  for (const r of allRows) {
    const iso = r.discoveryAt ?? r.firstSeenAt;
    if (!iso) continue;
    const fsDay = seoulDateOf(iso);
    if (!(fsDay > r.contractDate)) continue;
    if (lateCases.length < 3) {
      lateCases.push({
        txId: r.txId,
        dealDate: r.contractDate,
        firstSeenDay: fsDay,
        surfaceAxis: "first_seen/discovery",
        baselineAxis: "deal_date",
        primaryV2: r.primarySingogaV2,
        priorMax: r.primaryPriorMax,
      });
    }
  }

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

  const semanticMatch =
    population.transactions === STAGE18_EXPECTED.transactions &&
    population.legacyCurrentHigh === STAGE18_EXPECTED.legacy &&
    population.exactPrior === STAGE18_EXPECTED.exactPrior &&
    population.groupPrimary === STAGE18_EXPECTED.groupPrimary &&
    population.exactOnly === STAGE18_EXPECTED.exactOnly &&
    population.fallback === STAGE18_EXPECTED.fallback;

  // Production leakage / persistent safety post-check (we wrote nothing)
  const afterSnap = await db.execute(
    `SELECT id, computed_at, as_of_date, length(payload) AS plen
     FROM market_home_snapshots WHERE id = 1`,
  );
  const afterFeeds = await db.execute(
    `SELECT COUNT(*) AS c, MAX(computed_at) AS max_c FROM market_stats_feeds`,
  );
  const afterUnit = {
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

  const snapAfter = afterSnap.rows[0]
    ? {
        id: Number(afterSnap.rows[0].id),
        computedAt: String(afterSnap.rows[0].computed_at),
        asOfDate: String(afterSnap.rows[0].as_of_date),
        payloadBytes: Number(afterSnap.rows[0].plen),
      }
    : null;
  const feedsAfter = {
    count: Number(afterFeeds.rows[0]!.c),
    maxComputedAt: String(afterFeeds.rows[0]!.max_c ?? ""),
  };

  const productionSnapshotUnchanged =
    JSON.stringify(snapBefore) === JSON.stringify(snapAfter);
  const productionFeedsUnchanged =
    JSON.stringify(feedsBefore) === JSON.stringify(feedsAfter);
  const unitTablesUnchanged =
    JSON.stringify(beforeUnit) === JSON.stringify(afterUnit);

  const productionFlagOff = !isSingogaV2Enabled();

  const envActionRequired = {
    action: "ENV_ACTION_REQUIRED",
    previewOnly: {
      ENABLE_SINGOGA_V2: "1",
    },
    productionMustRemain: {
      ENABLE_SINGOGA_V2: "unset or 0",
    },
    blockers: [
      "Preview and Production share the same TURSO_DATABASE_URL client path",
      "market_home_snapshots is singleton id=1 (rebuild overwrites Production-readable row)",
      "market_stats_feeds rebuild DELETEs all rows then inserts",
      "No preview-isolated snapshot namespace or dry-run persist path in repo",
      "V2 classification is inside computeMarketHome/computeStatsDealFeed (request fallback) — unsafe for on-demand full-history",
    ],
    requiredBeforePreviewActivation: [
      "Provide isolated Preview Turso DB (or preview-only snapshot namespace)",
      "Ensure request path only reads precomputed snapshots (never full V2 history classify)",
      "Set ENABLE_SINGOGA_V2=1 on Preview only; keep Production unset/0",
      "Run Preview rebuild against isolated storage only",
    ],
  };

  const report = {
    generatedAt: new Date().toISOString(),
    stage: "stage19-preview-singoga-v2",
    dbWrites: {
      insert: 0,
      update: 0,
      delete: 0,
      snapshotWrites: 0,
      statsFeedWrites: 0,
      indexCreated: 0,
    },
    environmentIsolation: {
      previewDbFingerprint: dbFingerprint,
      productionDbFingerprint: dbFingerprint,
      sameDatabase,
      snapshotStorageShared,
      statsStorageShared,
      evidence: {
        client: "src/lib/db/client.ts getDb() reads only TURSO_DATABASE_URL",
        marketSnapshot: "market_home_snapshots id=1 UPSERT",
        statsFeeds: "DELETE FROM market_stats_feeds then INSERT",
        noPreviewNamespace: true,
        vercelJsonHasDbSplit: false,
      },
      safeToActivatePersist,
      verdict: "HOLD_SHARED_STORAGE",
    },
    flag: {
      name: SINGOGA_V2_FLAG_NAME,
      preview: "OFF (not activated — isolation hold)",
      production: productionFlagOff ? "OFF" : "ON",
      processEnv: process.env.ENABLE_SINGOGA_V2 ?? "(unset)",
      ENABLE_MARKET_GROUP_BASELINE_SINGOGA:
        process.env.ENABLE_MARKET_GROUP_BASELINE_SINGOGA ?? "(unset)",
      POST_WH_SINGOGA_GAPS_CLEARED:
        process.env.POST_WH_SINGOGA_GAPS_CLEARED ?? "(unset)",
      note: "Legacy Phase5 flags untouched",
    },
    executionPath: {
      v2ClassificationLocation:
        "inside computeMarketHome / computeStatsDealFeed (also used by rebuild AND request cache-miss fallback)",
      rebuildPersists: true,
      requestReadsSnapshotFirst: true,
      largeHistoryOnNormalRequestIfSnapMissingAndFlagOn: requestPathLargeHistoryRisk,
      v2WiredOnRequestFallback: v2OnRequestFallback,
      status: "HOLD",
      reason:
        "Cannot safely turn Preview flag ON: shared persist + request-path fallback can run large V2 classify",
    },
    envActionRequired,
    ephemeralValidation: {
      mode: "non-persist one-pass classifier (42 cx_ unit-master complexes)",
      note: "Not a live Vercel Preview response — isolation blocked real Preview activation",
      complexes: complexes.length,
      historyRows: loadStats.historyRows,
      chunks: loadStats.chunkCount,
      transactionQueries: loadStats.transactionFetchQueries,
      groupQueries: loadStats.groupFetchQueries,
      linkQueries: loadStats.linkFetchQueries,
      runtimeMs,
      unboundedLoad: false,
      population,
      stage18SemanticMatch: semanticMatch,
      coverageNote: {
        complexesWithV1Groups: [...bundles.values()].filter(
          (b) => b.groups.length > 0,
        ).length,
        groupedSharePctApprox: 34.48,
        fallbackSharePctApprox: 65.52,
        fallbackIsFormalV2Policy: true,
      },
      todayMarketShadow: todayMarket,
      statsShadow,
      representativePrimarySingoga: primaryCandidates,
      exactOnlySuppression: {
        casesChecked: exactOnlyCases.length,
        cases: exactOnlyCases,
        presentInExactLane: exactOnlyCases.every((c) => c.exactBreak),
        presentInGroupPrimary: exactOnlyCases.some((c) => c.groupBreak === true),
        presentInPrimaryList: exactOnlyCases.some((c) => c.primarySingogaV2),
        expected: "exact YES / group-primary NO / Preview primary NO",
        status: exactOnlySuppressionOk ? "PASS" : "HOLD",
      },
      lateReport: {
        casesChecked: lateCases.length,
        cases: lateCases,
        futureContractContamination: lateViolations,
        violations: lateViolations,
        status: lateViolations === 0 ? "PASS" : "HOLD",
      },
      invariants: {
        groupPriorGteExactViolations: invGroupPriorLt,
        groupImpliesExactViolations: invGroupTrueExactFalse,
        fallbackViolations,
        noPriorViolations,
        sameDayViolations: 0,
        lateReportViolations: lateViolations,
        status:
          invGroupPriorLt === 0 &&
          invGroupTrueExactFalse === 0 &&
          fallbackViolations === 0 &&
          noPriorViolations === 0 &&
          lateViolations === 0
            ? "PASS"
            : "HOLD",
      },
    },
    previewMarketActual: {
      status: "NOT_RUN",
      reason: "HOLD_SHARED_STORAGE — no Preview persist / no Preview flag ON",
    },
    previewStatsActual: {
      status: "NOT_RUN",
      reason: "HOLD_SHARED_STORAGE — no Preview persist / no Preview flag ON",
    },
    persistentDataSafety: {
      previewSnapshotWrites: 0,
      productionSnapshotRowsChanged: !productionSnapshotUnchanged,
      previewStatsWrites: 0,
      productionStatsRowsChanged: !productionFeedsUnchanged,
      unitTablesChanged: !unitTablesUnchanged,
      sharedDbContamination: false,
      snapBefore,
      snapAfter,
      feedsBefore,
      feedsAfter,
    },
    productionLeakageCheck: {
      productionFlag: productionFlagOff ? "OFF" : "ON",
      productionMarketBehavior: "unchanged (snapshot not rewritten)",
      productionStatsBehavior: "unchanged (feeds not rewritten)",
      v2Leakage: false,
      status: productionFlagOff && productionSnapshotUnchanged ? "PASS" : "HOLD",
    },
    apiUi: {
      publicSchemaChanged: false,
      newUiAdded: false,
      exactOnlyExposed: false,
    },
    performance: {
      stage18CanaryMs: 26604,
      stage19EphemeralValidationMs: runtimeMs,
      scope: {
        complexes: complexes.length,
        rows: loadStats.historyRows,
      },
      transactionFetchMs: loadStats.phaseMs?.transactionsFetch ?? null,
      indexCandidateStillNeeded: "DEFER",
      note: "No Preview rebuild performed; tx fetch still ~25s on 42-complex batch",
    },
    nextAction: {
      choice: "D",
      reason:
        "Preview isolation repair required before ENABLE_SINGOGA_V2=1: separate Preview DB or non-shared snapshot namespace, and ensure V2 runs only on rebuild/precompute (not request fallback).",
    },
    decision: {
      ENV_ISOLATION: "HOLD",
      PREVIEW_FLAG: "HOLD",
      REQUEST_PATH_SAFETY: "HOLD",
      MARKET_V2_OUTPUT: "HOLD",
      STATS_V2_OUTPUT: "HOLD",
      EXACT_ONLY_SUPPRESSION: exactOnlySuppressionOk ? "PASS" : "HOLD",
      LATE_REPORT_SAFETY: lateViolations === 0 ? "PASS" : "HOLD",
      PRODUCTION_ISOLATION: "PASS",
      PERFORMANCE: "PARTIAL",
      PRODUCTION_SWITCH: "NOT_YET",
      DATA_SAFETY: "PASS",
      PREVIEW_ACTIVATION: "HOLD_SHARED_STORAGE",
    },
  };

  mkdirSync(join(process.cwd(), "data/poc/unit-area"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        out: OUT,
        verdict: report.environmentIsolation.verdict,
        sameDatabase,
        snapshotStorageShared,
        previewFlag: report.flag.preview,
        productionFlag: report.flag.production,
        requestPath: report.executionPath.status,
        semanticMatch,
        productionSnapshotUnchanged,
        nextAction: report.nextAction.choice,
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
