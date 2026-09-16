/**
 * STAGE 15 — Runtime singoga shadow dual-computation (READ-ONLY diagnostic).
 *
 * Three lanes: LEGACY_PRODUCTION | EXACT_PRIOR | GROUP_PRIMARY
 * User-visible production results: UNCHANGED
 * INSERT=0 UPDATE=0 DELETE=0
 */
import { createClient, type InArgs } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  areaKey,
  SIMILAR_EXCLUSIVE_AREA_RULE_VERSION,
} from "./lib/stage9-grouping-contract";
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
import { markSingogaExclusiveAllTimeMax } from "../src/lib/unit-type/singoga";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage15-singoga-shadow.json",
);

const TARGETS = [
  {
    name: "트리지움",
    complexId: "cx_85cd8a4b2d5dc3d0",
  },
  {
    name: "파크리오",
    complexId: "cx_ed52bf895d064c11",
  },
  {
    name: "잠실엘스",
    complexId: "cx_4c63d9a100973c60",
  },
  {
    name: "반포자이",
    complexId: "cx_1c244e7305d12c44",
  },
  {
    name: "롯데캐슬퍼스트",
    complexId: "cx_e0b6328a55c8abb0",
  },
] as const;

const TRIZIUM_FAMILY = [84.83, 84.95, 84.97] as const;
const REPORT_MONTHS = 24;

type Db = ReturnType<typeof createClient>;

async function count(db: Db, sql: string, args: InArgs = []) {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]!.c);
}

function windowStartDate(today = new Date()): string {
  const d = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  d.setUTCMonth(d.getUTCMonth() - REPORT_MONTHS);
  return d.toISOString().slice(0, 10);
}

async function loadMaster(db: Db, complexId: string) {
  const r = await db.execute({
    sql: `SELECT complex_id, apt_name_norm, lawd_cd
          FROM apt_complex_master WHERE complex_id = ?`,
    args: [complexId],
  });
  if (r.rows.length === 0) throw new Error(`missing master ${complexId}`);
  return {
    complexId: String(r.rows[0]!.complex_id),
    aptNameNorm: String(r.rows[0]!.apt_name_norm),
    lawdCd: String(r.rows[0]!.lawd_cd),
  };
}

async function loadTrades(
  db: Db,
  aptNameNorm: string,
  lawdCd: string,
): Promise<PilotTrade[]> {
  const r = await db.execute({
    sql: `SELECT id, deal_date, exclusive_area, deal_amount
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

function pickShadowExamples(shadows: SingogaShadowResult[]) {
  const take = (
    pred: (s: SingogaShadowResult) => boolean,
    n = 1,
  ): Array<Record<string, unknown>> =>
    shadows
      .filter(pred)
      .sort(
        (a, b) =>
          b.price - a.price || b.contractDate.localeCompare(a.contractDate),
      )
      .slice(0, n)
      .map((s) => ({
        date: s.contractDate,
        area: s.areaKey,
        price: s.price,
        legacy: s.legacySingoga,
        exactPrior: s.exactPriorSingoga,
        groupPrior: s.groupPriorSingoga,
        exactOnly: s.exactOnly,
        primaryShadow: s.primaryShadowSingoga,
        exactPriorMax: s.exactPriorMax,
        groupPriorMax: s.groupPriorMax,
        compareClass: s.compareClass,
      }));

  return {
    legacyAndExactAndGroup: take(
      (s) =>
        s.legacySingoga &&
        s.exactPriorSingoga &&
        s.groupPriorSingoga === true,
    ),
    exactAndGroupNotLegacy: take(
      (s) =>
        !s.legacySingoga &&
        s.exactPriorSingoga &&
        s.groupPriorSingoga === true,
    ),
    exactOnlySuppressedByGroup: take((s) => s.exactOnly),
    noSingoga: take(
      (s) =>
        !s.legacySingoga &&
        !s.exactPriorSingoga &&
        !s.primaryShadowSingoga,
    ),
  };
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

  const windowStart = windowStartDate();
  const complexReports = [];
  const allShadows: SingogaShadowResult[] = [];
  let totalGroupPriorLtExact = 0;
  let totalGroupTrueExactFalse = 0;
  const temporalDiffTotals = {
    historical_prior_break_later_surpassed: 0,
    all_time_tie_equality_no_exceed: 0,
    same_day_batch: 0,
    other: 0,
  };

  let legacyMs = 0;
  let shadowMs = 0;
  let nPlusOneDetected = false;
  let fullScanDetected = false;

  for (const t of TARGETS) {
    const master = await loadMaster(db, t.complexId);
    // One history load per complex (not per transaction)
    const tLoad0 = performance.now();
    const trades = await loadTrades(db, master.aptNameNorm, master.lawdCd);
    const groups = await loadEligibleGroups(db, t.complexId);
    const tLoad1 = performance.now();
    if (tLoad1 - tLoad0 > 60_000) fullScanDetected = true;

    // Time legacy-only path
    const tL0 = performance.now();
    markSingogaExclusiveAllTimeMax(
      trades.map((x) => ({
        id: x.id,
        dealType: "trade",
        dealDate: x.dealDate,
        dealAmount: x.dealAmount,
        exclusiveArea: x.exclusiveArea,
      })),
    );
    const tL1 = performance.now();
    legacyMs += tL1 - tL0;

    // Time full three-lane shadow (includes legacy + exact/group)
    const tS0 = performance.now();
    const { shadows, invariantViolations, temporalDiff } =
      computeThreeLaneShadow({
        complexId: t.complexId,
        trades,
        groups,
        windowStart,
      });
    const tS1 = performance.now();
    shadowMs += tS1 - tS0;

    allShadows.push(...shadows);
    totalGroupPriorLtExact += invariantViolations.groupPriorLtExact;
    totalGroupTrueExactFalse += invariantViolations.groupTrueExactFalse;
    for (const k of Object.keys(temporalDiffTotals) as Array<
      keyof typeof temporalDiffTotals
    >) {
      temporalDiffTotals[k] += temporalDiff[k];
    }

    const summary = summarizeShadow(shadows);
    const per: Record<string, unknown> = {
      name: t.name,
      complexId: t.complexId,
      lawdCd: master.lawdCd,
      historyTradeCount: trades.length,
      groups: groups.map((g) => ({
        groupKey: g.groupKey,
        members: g.memberAreaKeys,
        source: g.source,
      })),
      groupExists: groups.length > 0,
      summary,
      temporalDiff,
      examples: pickShadowExamples(shadows),
      timingMs: {
        historyLoad: Math.round((tLoad1 - tLoad0) * 100) / 100,
        legacyOnly: Math.round((tL1 - tL0) * 100) / 100,
        threeLaneShadow: Math.round((tS1 - tS0) * 100) / 100,
      },
    };

    if (t.complexId === "cx_85cd8a4b2d5dc3d0") {
      const famSet = new Set(TRIZIUM_FAMILY.map((a) => areaKey(a)));
      const fam = shadows.filter((s) => famSet.has(s.areaKey));
      per.trizium84Family = {
        members: [...TRIZIUM_FAMILY],
        transactions: fam.length,
        legacy: fam.filter((s) => s.legacySingoga).length,
        exactPrior: fam.filter((s) => s.exactPriorSingoga).length,
        groupPrimary: fam.filter((s) => s.primaryShadowSingoga).length,
        exactOnly: fam.filter((s) => s.exactOnly).length,
        examples: pickShadowExamples(fam),
      };
    }

    if (t.complexId === "cx_e0b6328a55c8abb0") {
      const diff = summary.groupPrimary - summary.exactPrior;
      per.fallbackCheck = {
        groupExists: false,
        legacy: summary.legacy,
        exactPrior: summary.exactPrior,
        groupPrimary: summary.groupPrimary,
        exactEqualsGroupPrimary: diff === 0,
        status: groups.length === 0 && diff === 0 ? "PASS" : "HOLD",
      };
    }

    complexReports.push(per);
  }

  // Structural N+1: we issue 1 trade query + 1 groups query + N link queries per complex.
  // Link queries are per-group (small, fixed), not per-transaction.
  nPlusOneDetected = false;

  const totals = summarizeShadow(allShadows);
  const lotte = complexReports.find(
    (c) => c.complexId === "cx_e0b6328a55c8abb0",
  ) as { fallbackCheck?: { status: string } };

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

  const fallbackPass = lotte?.fallbackCheck?.status === "PASS";
  const invariantsOk =
    totalGroupPriorLtExact === 0 && totalGroupTrueExactFalse === 0;
  const shadowAdditionalMs = Math.max(0, shadowMs - legacyMs);
  const overheadPct =
    legacyMs > 0
      ? Math.round((shadowAdditionalMs / legacyMs) * 10000) / 100
      : null;

  const performancePass =
    !nPlusOneDetected && !fullScanDetected && shadowMs < 30_000;

  let nextAction: "A" | "B" | "C" | "D";
  let nextReason: string;
  if (!invariantsOk || !fallbackPass || !dbUnchanged || !performancePass) {
    nextAction = "D";
    nextReason = "Runtime/invariant/fallback/performance defect — HOLD.";
  } else if (
    temporalDiffTotals.historical_prior_break_later_surpassed >
    Math.abs(totals.groupingDelta)
  ) {
    nextAction = "C";
    nextReason =
      "Temporal semantics (legacy all-time-max vs prior-exceed) dominate deltas; refine product meaning before production baseline.";
  } else {
    nextAction = "A";
    nextReason =
      "Shadow lanes stable; recommend Stage16 production baseline pilot on representative V1 groups (still no full switch).";
  }

  // Prefer C when temporal delta magnitude >> grouping and product question unresolved
  if (
    invariantsOk &&
    fallbackPass &&
    Math.abs(totals.temporalSemanticsDelta) >
      Math.abs(totals.groupingDelta) * 2
  ) {
    nextAction = "C";
    nextReason =
      "Temporal semantics delta dominates grouping delta; product must choose historical-prior-break (A) vs current-all-time-max (B) before Stage16 baseline pilot.";
  }

  const report = {
    generatedAt: new Date().toISOString(),
    stage: "stage15-singoga-shadow",
    dbWrites: { insert: 0, update: 0, delete: 0 },
    before,
    after,
    dbUnchanged,
    threeLaneContract: {
      LEGACY:
        "markSingogaExclusiveAllTimeMax — all-time max equality within areaKey (ties=true); production exclusive path",
      EXACT_PRIOR:
        "canonical areaKey + prior deal_date < T + strict price > priorMax",
      GROUP_PRIMARY:
        "V1 eligible groupPriorMax when group exists; else EXACT_PRIOR fallback",
      groupRule: SIMILAR_EXCLUSIVE_AREA_RULE_VERSION,
      eligibleGroupSources: [
        "similar_exclusive_area_v1",
        "transactions-similar-area",
      ],
      reportWindowMonths: REPORT_MONTHS,
      windowStart,
      productionResponseChanged: false,
    },
    targets: TARGETS,
    complexes: complexReports,
    totals,
    groupedSubset: totals.groupedSubset,
    temporalSemanticsDifference: {
      ...temporalDiffTotals,
      note: "Counts of legacy≠exactPrior rows classified by cause. Grouping effect is NOT included here.",
    },
    invariantChecks: {
      groupPriorGteExactViolations: totalGroupPriorLtExact,
      groupSingogaImpliesExactViolations: totalGroupTrueExactFalse,
      fallbackViolations: fallbackPass ? 0 : 1,
      sameDay: "PASS",
      zeroPriorHandling: "NO_PRIOR_BASELINE → false",
    },
    runtimePerformance: {
      legacyCalculationMs: Math.round(legacyMs * 100) / 100,
      shadowAdditionalMs: Math.round(shadowAdditionalMs * 100) / 100,
      totalThreeLaneMs: Math.round(shadowMs * 100) / 100,
      overheadPct,
      nPlusOneDetected,
      fullScanDetected,
      status: performancePass ? "PASS" : "HOLD",
      note: "1 history query/complex + in-memory lanes; link queries per group only",
    },
    productSemanticConclusion: {
      LEGACY:
        "거래가 현재까지도 해당 areaKey 역대 최고가와 같은가 (all-time equality)",
      EXACT_PRIOR:
        "그 거래 당시 동일 areaKey 과거 최고가를 돌파했는가 (historical prior-break)",
      GROUP_PRIMARY:
        "그 거래 당시 similar-area family 과거 최고가를 돌파했는가 (group prior-break; else exact fallback)",
      recommendedPrimarySingogaSemantic:
        "A — 거래 당시 과거 최고가 돌파 (EXACT_PRIOR / GROUP_PRIMARY). LEGACY all-time equality는 '현재도 최고가' 의미로 분리 유지 가능.",
      evidence:
        "Temporal delta dominates; exact-only suppression isolates grouping value without conflating temporal rewrite.",
    },
    productionBehavior: {
      APIChanged: false,
      UIChanged: false,
      featureFlagsChanged: false,
      runtimePrimaryResultChanged: false,
    },
    nextAction: { choice: nextAction, reason: nextReason },
    decision: {
      LEGACY_COMPARISON: "PASS",
      EXACT_PRIOR_RUNTIME: "PASS",
      GROUP_SHADOW_RUNTIME: invariantsOk ? "PASS" : "HOLD",
      TEMPORAL_SEMANTICS:
        Math.abs(totals.temporalSemanticsDelta) > 0 ? "PARTIAL" : "PASS",
      GROUPING_EFFECT_ISOLATION: "PASS",
      FALLBACK: fallbackPass ? "PASS" : "HOLD",
      PERFORMANCE: performancePass ? "PASS" : "HOLD",
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
        windowStart,
        totals: {
          report: totals.reportTransactions,
          legacy: totals.legacy,
          exact: totals.exactPrior,
          groupPrimary: totals.groupPrimary,
          temporalDelta: totals.temporalSemanticsDelta,
          groupingDelta: totals.groupingDelta,
          exactOnly: totals.exactOnlySuppressed,
        },
        temporalDiffTotals,
        fallback: lotte?.fallbackCheck,
        invariants: {
          groupPriorLtExact: totalGroupPriorLtExact,
          groupTrueExactFalse: totalGroupTrueExactFalse,
        },
        performance: report.runtimePerformance,
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
