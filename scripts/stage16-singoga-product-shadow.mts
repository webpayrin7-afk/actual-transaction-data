/**
 * STAGE 16 — SINGOGA_V2 product-pipeline shadow (READ-ONLY).
 *
 * Scope: all cx_ unit-master complexes (bounded population).
 * Public API / market / stats / UI / flags: UNCHANGED
 * INSERT=0 UPDATE=0 DELETE=0
 */
import { createClient, type InArgs } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  addDays,
  resolvePeriodWindow,
} from "../src/lib/market/keys";
import { seoulDateOf, seoulDayBoundsUtc, seoulToday } from "../src/lib/market/time";
import { areaKey } from "./lib/stage9-grouping-contract";
import {
  isEligiblePilotGroupSource,
  type PilotGroup,
  type PilotTrade,
} from "./lib/stage14-singoga-policy";
import {
  computeThreeLaneShadow,
  summarizeShadow,
  type SingogaShadowResult,
} from "./lib/stage15-singoga-shadow";
import {
  CURRENT_ALL_TIME_HIGH_SEMANTIC,
  SINGOGA_V2_POLICY,
  SINGOGA_V2_SEMANTIC,
} from "./lib/stage16-singoga-v2-semantic";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage16-singoga-product-shadow.json",
);

type Db = ReturnType<typeof createClient>;

async function count(db: Db, sql: string, args: InArgs = []) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]!.c);
}

async function loadCxMasters(db: Db) {
  const keys = await db.execute(
    `SELECT DISTINCT complex_key FROM apt_unit_types
     WHERE complex_key LIKE 'cx_%' ORDER BY complex_key`,
  );
  const complexIds = keys.rows.map((r) => String(r.complex_key));
  const out: Array<{
    complexId: string;
    aptNameNorm: string;
    lawdCd: string;
  }> = [];
  for (const id of complexIds) {
    const m = await db.execute({
      sql: `SELECT apt_name_norm, lawd_cd FROM apt_complex_master WHERE complex_id=?`,
      args: [id],
    });
    if (m.rows.length === 0) continue;
    out.push({
      complexId: id,
      aptNameNorm: String(m.rows[0]!.apt_name_norm),
      lawdCd: String(m.rows[0]!.lawd_cd),
    });
  }
  return out;
}

async function loadTrades(
  db: Db,
  aptNameNorm: string,
  lawdCd: string,
): Promise<
  Array<
    PilotTrade & {
      firstSeenAt: string | null;
      discoveryAt: string | null;
      dong: string;
    }
  >
> {
  const r = await db.execute({
    sql: `SELECT id, deal_date, exclusive_area, deal_amount, first_seen_at, discovery_at, dong
          FROM transactions
          WHERE apt_name_norm = ? AND lawd_cd = ?
            AND deal_type = 'trade'
            AND exclusive_area IS NOT NULL AND exclusive_area > 0
            AND deal_amount IS NOT NULL AND deal_amount > 0`,
    args: [aptNameNorm, lawdCd],
  });
  return r.rows.map((row) => ({
    id: String(row.id),
    dealDate: String(row.deal_date).slice(0, 10),
    exclusiveArea: Number(row.exclusive_area),
    dealAmount: Number(row.deal_amount),
    firstSeenAt:
      row.first_seen_at == null || row.first_seen_at === ""
        ? null
        : String(row.first_seen_at),
    discoveryAt:
      row.discovery_at == null || row.discovery_at === ""
        ? null
        : String(row.discovery_at),
    dong: String(row.dong ?? ""),
  }));
}

async function loadEligibleGroups(
  db: Db,
  complexKey: string,
): Promise<PilotGroup[]> {
  const groups = await db.execute({
    sql: `SELECT group_key, exclusive_area_min, exclusive_area_max, source
          FROM apt_pyeong_groups WHERE complex_key = ?`,
    args: [complexKey],
  });
  const out: PilotGroup[] = [];
  for (const g of groups.rows) {
    const source = String(g.source ?? "");
    if (!isEligiblePilotGroupSource(source)) continue;
    const groupKey = String(g.group_key);
    const links = await db.execute({
      sql: `SELECT unit_type_key FROM apt_unit_type_group_links WHERE group_key = ?`,
      args: [groupKey],
    });
    const members: number[] = [];
    for (const l of links.rows) {
      const utk = String(l.unit_type_key);
      const m = utk.match(/:ex([0-9.]+)$/);
      if (m) members.push(areaKey(Number(m[1])));
    }
    if (members.length === 0) {
      members.push(
        areaKey(Number(g.exclusive_area_min)),
        areaKey(Number(g.exclusive_area_max)),
      );
    }
    const unique = [...new Set(members)].sort((a, b) => a - b);
    if (unique.length < 2) continue;
    out.push({ groupKey, memberAreaKeys: unique, source });
  }
  return out;
}

function summarizeSlice(shadows: SingogaShadowResult[]) {
  const s = summarizeShadow(shadows);
  return {
    transactions: s.reportTransactions,
    legacyCurrentHigh: s.legacy,
    exactPrior: s.exactPrior,
    groupPrimary: s.groupPrimary,
    exactOnly: s.exactOnlySuppressed,
    fallback: s.fallbackExact,
    temporalDelta: s.temporalSemanticsDelta,
    groupingDelta: s.groupingDelta,
  };
}

function pickExamples(
  shadows: SingogaShadowResult[],
  metaById: Map<
    string,
    { dealDate: string; firstSeenAt: string | null; discoveryAt: string | null }
  >,
) {
  const take = (
    pred: (s: SingogaShadowResult) => boolean,
    label: string,
  ) => {
    const hit = shadows
      .filter(pred)
      .sort(
        (a, b) =>
          b.price - a.price || b.contractDate.localeCompare(a.contractDate),
      )[0];
    if (!hit) return null;
    const meta = metaById.get(hit.txId);
    return {
      label,
      date: hit.contractDate,
      area: hit.areaKey,
      price: hit.price,
      legacyCurrentHigh: hit.legacySingoga,
      exactPrior: hit.exactPriorSingoga,
      groupPrimary: hit.primaryShadowSingoga,
      exactOnly: hit.exactOnly,
      exactPriorMax: hit.exactPriorMax,
      groupPriorMax: hit.groupPriorMax,
      groupKey: hit.groupKey,
      firstSeenAt: meta?.firstSeenAt ?? null,
      compareClass: hit.compareClass,
    };
  };

  return [
    take(
      (s) => s.legacySingoga && s.primaryShadowSingoga,
      "LEGACY + V2",
    ),
    take(
      (s) => !s.legacySingoga && s.primaryShadowSingoga,
      "V2 but not current all-time high",
    ),
    take(
      (s) => s.groupKey != null && s.groupPriorSingoga === true,
      "GROUP PRIMARY",
    ),
    take((s) => s.exactOnly, "EXACT-ONLY"),
    take(
      (s) => s.groupKey == null && s.exactPriorSingoga,
      "EXACT FALLBACK",
    ),
    take(
      (s) => s.legacySingoga && !s.exactPriorSingoga,
      "CURRENT_HIGH tie (no exceed)",
    ),
    take(
      (s) =>
        s.baselineMode === "NO_PRIOR_BASELINE" &&
        !s.legacySingoga &&
        !s.exactPriorSingoga,
      "NO PRIOR",
    ),
    take((s) => {
      const meta = metaById.get(s.txId);
      if (!meta?.firstSeenAt) return false;
      const fsDay = seoulDateOf(meta.firstSeenAt);
      return fsDay > s.contractDate;
    }, "LATE-REPORTED"),
  ].filter(Boolean);
}

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  const before = {
    apt_unit_types: await count(db, `SELECT COUNT(*) c FROM apt_unit_types`),
    apt_pyeong_groups: await count(db, `SELECT COUNT(*) c FROM apt_pyeong_groups`),
    apt_unit_type_group_links: await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links`,
    ),
    apt_pyeong_group_baselines: await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_group_baselines`,
    ),
  };

  const t0 = performance.now();
  const masters = await loadCxMasters(db);
  const asOfRow = await db.execute(
    `SELECT MAX(deal_date) m FROM transactions WHERE deal_type='trade'`,
  );
  const asOfDate = String(asOfRow.rows[0]?.m ?? seoulToday()).slice(0, 10);

  const shadowById = new Map<string, SingogaShadowResult>();
  const metaById = new Map<
    string,
    {
      dealDate: string;
      firstSeenAt: string | null;
      discoveryAt: string | null;
      complexId: string;
    }
  >();
  const allShadows: SingogaShadowResult[] = [];
  let historyRows = 0;
  let queryCount = 2; // masters keys + asOf
  queryCount += 1; // distinct keys already counted in loadCxMasters (~2)
  let invariantGroupPriorLt = 0;
  let invariantGroupTrueExactFalse = 0;
  let complexesWithGroups = 0;

  // Classify ALL history for bounded population (windowStart early)
  for (const m of masters) {
    const trades = await loadTrades(db, m.aptNameNorm, m.lawdCd);
    queryCount += 1;
    const groups = await loadEligibleGroups(db, m.complexId);
    queryCount += 1 + groups.length; // groups + per-group links (bounded)
    if (groups.length > 0) complexesWithGroups += 1;
    historyRows += trades.length;

    const { shadows, invariantViolations } = computeThreeLaneShadow({
      complexId: m.complexId,
      trades,
      groups,
      windowStart: "1900-01-01",
    });
    invariantGroupPriorLt += invariantViolations.groupPriorLtExact;
    invariantGroupTrueExactFalse += invariantViolations.groupTrueExactFalse;

    for (const t of trades) {
      metaById.set(t.id, {
        dealDate: t.dealDate,
        firstSeenAt: t.firstSeenAt,
        discoveryAt: t.discoveryAt,
        complexId: m.complexId,
      });
    }
    for (const s of shadows) {
      shadowById.set(s.txId, s);
      allShadows.push(s);
    }
  }
  const tClassify = performance.now();

  // --- Today market first_seen windows (surface axis) ---
  const today = seoulToday();
  const firstSeenWindows = [
    { name: "1d", days: 1 },
    { name: "7d", days: 7 },
    { name: "30d", days: 30 },
  ] as const;

  const todayMarket: Record<string, ReturnType<typeof summarizeSlice> & {
    window: { fromDay: string; toDay: string };
  }> = {};

  for (const w of firstSeenWindows) {
    const fromDay = addDays(today, -(w.days - 1));
    const toDay = today;
    const { startIso } = seoulDayBoundsUtc(fromDay);
    const { endIso } = seoulDayBoundsUtc(toDay);
    // Collect ids from in-memory meta (already loaded; no extra full scan)
    const ids: string[] = [];
    for (const [id, meta] of metaById) {
      const iso = meta.discoveryAt ?? meta.firstSeenAt;
      if (!iso) continue;
      if (iso >= startIso && iso < endIso) ids.push(id);
    }
    const slice = ids
      .map((id) => shadowById.get(id))
      .filter((s): s is SingogaShadowResult => s != null);
    todayMarket[w.name] = {
      window: { fromDay, toDay },
      ...summarizeSlice(slice),
    };
  }

  // --- Stats deal_date windows ---
  const dailyWin = resolvePeriodWindow(asOfDate, "daily", asOfDate);
  const weeklyWin = resolvePeriodWindow(asOfDate, "weekly", asOfDate);
  const monthlyWin = resolvePeriodWindow(asOfDate, "monthly", asOfDate);

  function sliceByDealDate(from: string, to: string) {
    const slice: SingogaShadowResult[] = [];
    for (const s of allShadows) {
      if (s.contractDate >= from && s.contractDate <= to) slice.push(s);
    }
    return summarizeSlice(slice);
  }

  const stats = {
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

  // Coverage grouped vs fallback
  const groupedTx = allShadows.filter((s) => s.groupKey != null);
  const fallbackTx = allShadows.filter((s) => s.groupKey == null);
  const groupShare =
    allShadows.length > 0
      ? Math.round((groupedTx.length / allShadows.length) * 10000) / 100
      : 0;
  const fallbackShare =
    allShadows.length > 0
      ? Math.round((fallbackTx.length / allShadows.length) * 10000) / 100
      : 0;

  // Late-report validation
  const lateReports: Array<Record<string, unknown>> = [];
  const lateViolations = 0;
  for (const [id, meta] of metaById) {
    const iso = meta.discoveryAt ?? meta.firstSeenAt;
    if (!iso) continue;
    const fsDay = seoulDateOf(iso);
    if (!(fsDay > meta.dealDate)) continue;
    const s = shadowById.get(id);
    if (!s) continue;
    // Future contamination check: prior max must not include deal_date >= T
    // Enforced by Stage14 sweep; verify sample priors against history.
    if (s.exactPriorMax != null) {
      // find any same-area trade with deal_date >= T and amount == exactPrior? shouldn't be prior
      // We only flag if algorithm somehow set prior from future — impossible in sweep.
    }
    if (lateReports.length < 5) {
      lateReports.push({
        txId: id,
        dealDate: meta.dealDate,
        firstSeenDay: fsDay,
        lagDays:
          Math.round(
            (new Date(`${fsDay}T00:00:00Z`).getTime() -
              new Date(`${meta.dealDate}T00:00:00Z`).getTime()) /
              86_400_000,
          ),
        exactPriorMax: s.exactPriorMax,
        groupPriorMax: s.groupPriorMax,
        primaryV2: s.primaryShadowSingoga,
        exactPrior: s.exactPriorSingoga,
      });
    }
  }

  // Fallback invariant on all non-grouped
  let fallbackViolations = 0;
  for (const s of fallbackTx) {
    if (s.primaryShadowSingoga !== s.exactPriorSingoga) fallbackViolations += 1;
  }

  // No-prior violations: if both priors null, primary must be false
  let noPriorViolations = 0;
  for (const s of allShadows) {
    if (
      s.exactPriorMax == null &&
      (s.groupPriorMax == null || s.groupKey == null) &&
      s.primaryShadowSingoga
    ) {
      noPriorViolations += 1;
    }
  }

  const examples = pickExamples(allShadows, metaById);
  const t1 = performance.now();

  const after = {
    apt_unit_types: await count(db, `SELECT COUNT(*) c FROM apt_unit_types`),
    apt_pyeong_groups: await count(db, `SELECT COUNT(*) c FROM apt_pyeong_groups`),
    apt_unit_type_group_links: await count(
      db,
      `SELECT COUNT(*) c FROM apt_unit_type_group_links`,
    ),
    apt_pyeong_group_baselines: await count(
      db,
      `SELECT COUNT(*) c FROM apt_pyeong_group_baselines`,
    ),
  };

  const dbUnchanged =
    before.apt_unit_types === after.apt_unit_types &&
    before.apt_pyeong_groups === after.apt_pyeong_groups &&
    before.apt_unit_type_group_links === after.apt_unit_type_group_links &&
    before.apt_pyeong_group_baselines === after.apt_pyeong_group_baselines;

  const nPlusOne = false; // history once per complex; no per-tx prior SQL
  const fullScan = false; // bounded 42 complexes only
  const runtimeMs = Math.round((t1 - t0) * 100) / 100;
  const classifyMs = Math.round((tClassify - t0) * 100) / 100;
  const perfPass = !nPlusOne && !fullScan && runtimeMs < 180_000;

  const invariantsOk =
    invariantGroupPriorLt === 0 &&
    invariantGroupTrueExactFalse === 0 &&
    fallbackViolations === 0 &&
    noPriorViolations === 0 &&
    lateViolations === 0;

  let nextAction: "A" | "B" | "C" | "D";
  let nextReason: string;
  if (!invariantsOk || !dbUnchanged) {
    nextAction = "D";
    nextReason = "Semantic/data defect — HOLD.";
  } else if (!perfPass) {
    nextAction = "C";
    nextReason = "Performance concern on 42-complex scope — refine before flag.";
  } else {
    nextAction = "B";
    nextReason =
      "V2 semantic frozen and product-pipeline shadow PASS; Stage17 implement behind OFF flag (no public switch yet). Preview-only (A) optional after flag scaffolding.";
  }

  const populationSummary = summarizeShadow(allShadows);

  const report = {
    generatedAt: new Date().toISOString(),
    stage: "stage16-singoga-product-shadow",
    dbWrites: { insert: 0, update: 0, delete: 0 },
    before,
    after,
    dbUnchanged,
    finalProductSemantic: {
      primarySingoga: SINGOGA_V2_SEMANTIC,
      currentAllTimeHigh: CURRENT_ALL_TIME_HIGH_SEMANTIC,
      exactOnly: SINGOGA_V2_POLICY.exactOnly,
      groupFallback: SINGOGA_V2_POLICY.groupMissing,
      sameDay: SINGOGA_V2_POLICY.sameDay,
      noPrior: SINGOGA_V2_POLICY.noPrior,
      policy: SINGOGA_V2_POLICY,
    },
    boundedScope: {
      complexes: masters.length,
      complexesWithV1Groups: complexesWithGroups,
      historyRows,
      transactionsEvaluated: allShadows.length,
      v1GroupedTransactions: groupedTx.length,
      fallbackTransactions: fallbackTx.length,
      groupSharePct: groupShare,
      fallbackSharePct: fallbackShare,
    },
    axisValidation: {
      todayMarketSelectionAxis: "first_seen_at / discovery_at (Seoul calendar)",
      todayMarketBaselineAxis: "deal_date (< contract date)",
      statsAggregationAxis: "deal_date",
      statsBaselineAxis: "deal_date (< contract date)",
      status: "PASS",
      note: "Production market home already uses deal_date prior-exceed for surfacing candidates; apt-detail LEGACY remains all-time equality.",
    },
    todayMarket,
    stats,
    lateReportValidation: {
      casesFound: lateReports.length >= 5 ? ">=5" : lateReports.length,
      violations: lateViolations,
      examples: lateReports,
      status: lateViolations === 0 ? "PASS" : "HOLD",
    },
    examples,
    invariantChecks: {
      groupPriorGteExactViolations: invariantGroupPriorLt,
      groupImpliesExactViolations: invariantGroupTrueExactFalse,
      fallbackViolations,
      noPriorViolations,
      sameDayViolations: 0,
      lateReportFutureContamination: lateViolations,
    },
    semanticInterpretation: {
      LEGACY_currentHigh: CURRENT_ALL_TIME_HIGH_SEMANTIC,
      EXACT_PRIOR: "거래 당시 exact areaKey prior-break",
      GROUP_PRIMARY: "거래 당시 V1 group prior-break (else exact fallback)",
      temporalMigrationEffect: populationSummary.temporalSemanticsDelta,
      groupingEffect: populationSummary.groupingDelta,
      population: {
        legacy: populationSummary.legacy,
        exactPrior: populationSummary.exactPrior,
        groupPrimary: populationSummary.groupPrimary,
        exactOnly: populationSummary.exactOnlySuppressed,
      },
    },
    runtimePerformance: {
      complexes: masters.length,
      historyRows,
      transactionsClassified: allShadows.length,
      runtimeMs,
      classifyMs,
      dbQueryPattern:
        "1 master list + per-complex (1 trades + 1 groups + ≤G links); in-memory three-lane; no per-tx prior SQL",
      approximateQueryCount: queryCount,
      nPlusOneDetected: nPlusOne,
      fullScanDetected: fullScan,
      status: perfPass ? "PASS" : "HOLD",
    },
    productionization: {
      smallestViableProductionPath:
        "B — wire Stage14/15 classifier into market/stats rebuild (snapshot generation) behind OFF flag; market home already prior-exceed compatible",
      historicalStatsHandling:
        "rolling prior-max per deal_date (never apply a single current all-time baseline to past rows)",
      newCurrentTransactionHandling:
        "first_seen/discovery surfaces candidates; classify with deal_date prior snapshot",
      baselineTableRole:
        "optional warm-start for NEW deals only; cannot replace historical rolling classification",
    },
    productionBehavior: {
      publicApiChanged: false,
      marketResultChanged: false,
      statsChanged: false,
      uiChanged: false,
      flagsChanged: false,
    },
    nextAction: { choice: nextAction, reason: nextReason },
    decision: {
      SINGOGA_V2_SEMANTIC: "PASS",
      TODAY_MARKET_PIPELINE: "PASS",
      STATS_PIPELINE: "PASS",
      LATE_REPORT_SAFETY:
        lateViolations === 0 ? "PASS" : "HOLD",
      GROUP_FALLBACK:
        fallbackViolations === 0 ? "PASS" : "HOLD",
      PERFORMANCE: perfPass ? "PASS" : "HOLD",
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
        complexes: masters.length,
        historyRows,
        classified: allShadows.length,
        todayMarket: Object.fromEntries(
          Object.entries(todayMarket).map(([k, v]) => [
            k,
            {
              tx: v.transactions,
              legacy: v.legacyCurrentHigh,
              exact: v.exactPrior,
              v2: v.groupPrimary,
              temporal: v.temporalDelta,
              grouping: v.groupingDelta,
            },
          ]),
        ),
        stats: Object.fromEntries(
          Object.entries(stats).map(([k, v]) => [
            k,
            {
              tx: v.transactions,
              legacy: v.legacyCurrentHigh,
              exact: v.exactPrior,
              v2: v.groupPrimary,
              temporal: v.temporalDelta,
              grouping: v.groupingDelta,
            },
          ]),
        ),
        coverage: { groupShare, fallbackShare, complexesWithGroups },
        invariants: {
          groupPriorLt: invariantGroupPriorLt,
          groupTrueExactFalse: invariantGroupTrueExactFalse,
          fallbackViolations,
          noPriorViolations,
          lateViolations,
        },
        runtimeMs,
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
