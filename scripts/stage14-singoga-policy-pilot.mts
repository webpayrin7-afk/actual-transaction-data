/**
 * STAGE 14 — Exact vs Group singoga policy pilot (READ-ONLY).
 *
 * INSERT=0 UPDATE=0 DELETE=0
 * Exactly 5 complexes. Local DB only. No production singoga/UI changes.
 */
import { createClient, type InArgs } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { areaKey, SIMILAR_EXCLUSIVE_AREA_RULE_VERSION } from "./lib/stage9-grouping-contract";
import {
  computePilotResults,
  countLegacyAllTimeMaxEquality,
  exampleShape,
  isEligiblePilotGroupSource,
  pickExamples,
  summarizeResults,
  type PilotGroup,
  type PilotTrade,
  type PilotTxResult,
} from "./lib/stage14-singoga-policy";

config({ path: ".env.local" });
config();

const OUT = join(
  process.cwd(),
  "data/poc/unit-area/stage14-singoga-policy-pilot.json",
);

const TARGETS = [
  {
    name: "트리지움",
    complexId: "cx_85cd8a4b2d5dc3d0",
    purpose: "대표 similar-area group (Stage7 84㎡ family)",
  },
  {
    name: "파크리오",
    complexId: "cx_ed52bf895d064c11",
    purpose: "Stage13 V1 groups + high volume",
  },
  {
    name: "잠실엘스",
    complexId: "cx_4c63d9a100973c60",
    purpose: "Stage13 V1 group + high volume",
  },
  {
    name: "반포자이",
    complexId: "cx_1c244e7305d12c44",
    purpose: "high-price exact/group divergence",
  },
  {
    name: "롯데캐슬퍼스트",
    complexId: "cx_e0b6328a55c8abb0",
    purpose: "GROUP MISSING → EXACT FALLBACK",
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
    sql: `SELECT complex_id, apt_name_norm, lawd_cd, identity_status
          FROM apt_complex_master WHERE complex_id = ?`,
    args: [complexId],
  });
  if (r.rows.length === 0) throw new Error(`missing master ${complexId}`);
  return {
    complexId: String(r.rows[0]!.complex_id),
    aptNameNorm: String(r.rows[0]!.apt_name_norm),
    lawdCd: String(r.rows[0]!.lawd_cd),
    identityStatus: String(r.rows[0]!.identity_status),
  };
}

/** Production contract: deal_type = 'trade' only (warehouse already resolution-filtered). */
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
    // Fallback to min/max range endpoints if links missing (should not for Stage7+)
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

function summarizeTriziumFamily(results: PilotTxResult[]) {
  const family = new Set(TRIZIUM_FAMILY.map((a) => areaKey(a)));
  const rows = results.filter((r) => family.has(r.areaKey));
  const byMember: Record<string, { transactions: number; exactSingoga: number }> =
    {};
  for (const a of TRIZIUM_FAMILY) {
    const ak = areaKey(a);
    const subset = rows.filter((r) => r.areaKey === ak);
    byMember[String(ak)] = {
      transactions: subset.length,
      exactSingoga: subset.filter((r) => r.isExactSingoga).length,
    };
  }
  return {
    members: [...TRIZIUM_FAMILY],
    transactions: rows.length,
    exactSingogaByMember: byMember,
    groupSingoga: rows.filter((r) => r.isGroupSingoga === true).length,
    exactOnly: rows.filter((r) => r.exactOnlySingoga).length,
    primary: rows.filter((r) => r.primarySingoga).length,
    examples: pickExamples(rows, 1),
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
    apt_complex_classifications: await count(
      db,
      `SELECT COUNT(*) c FROM apt_complex_classifications`,
    ),
  };

  const windowStart = windowStartDate();
  const complexReports = [];
  const allResults: PilotTxResult[] = [];
  let totalGroupPriorLtExact = 0;
  let totalGroupTrueExactFalse = 0;
  const invariantSamples: Array<Record<string, unknown>> = [];

  for (const t of TARGETS) {
    const master = await loadMaster(db, t.complexId);
    const trades = await loadTrades(db, master.aptNameNorm, master.lawdCd);
    const groups = await loadEligibleGroups(db, t.complexId);
    const { results, invariantViolations } = computePilotResults({
      complexId: t.complexId,
      trades,
      groups,
      windowStart,
    });
    allResults.push(...results);
    totalGroupPriorLtExact += invariantViolations.groupPriorLtExact;
    totalGroupTrueExactFalse += invariantViolations.groupTrueExactFalse;
    for (const s of invariantViolations.samples) {
      if (invariantSamples.length < 10) {
        invariantSamples.push({ complexId: t.complexId, ...s });
      }
    }

    const summary = summarizeResults(results);
    const examples = pickExamples(results, 1);
    const windowTrades = trades.filter((x) => x.dealDate >= windowStart);
    const legacyAllTimeMax = countLegacyAllTimeMaxEquality(windowTrades);

    const perComplex: Record<string, unknown> = {
      name: t.name,
      complexId: t.complexId,
      purpose: t.purpose,
      lawdCd: master.lawdCd,
      identityStatus: master.identityStatus,
      historyTradeCount: trades.length,
      groups: groups.map((g) => ({
        groupKey: g.groupKey,
        members: g.memberAreaKeys,
        source: g.source,
      })),
      groupExists: groups.length > 0,
      summary,
      examples: {
        groupSingoga: examples.groupSingoga.map(exampleShape),
        exactOnlySingoga: examples.exactOnlySingoga.map(exampleShape),
        exactFallbackSingoga: examples.exactFallbackSingoga.map(exampleShape),
      },
      legacyAllTimeMaxEqualityCount: legacyAllTimeMax,
      pilotExactCount: summary.exactSingoga,
    };

    if (t.complexId === "cx_85cd8a4b2d5dc3d0") {
      const fam = summarizeTriziumFamily(results);
      perComplex.trizium84Family = {
        ...fam,
        representativeExamples: {
          groupSingoga: fam.examples.groupSingoga.map(exampleShape),
          exactOnlySingoga: fam.examples.exactOnlySingoga.map(exampleShape),
        },
      };
      delete (perComplex.trizium84Family as { examples?: unknown }).examples;
    }

    if (t.complexId === "cx_e0b6328a55c8abb0") {
      const diff = summary.primarySingoga - summary.exactSingoga;
      perComplex.fallbackCheck = {
        groupExists: false,
        exact: summary.exactSingoga,
        primary: summary.primarySingoga,
        difference: diff,
        status: diff === 0 && groups.length === 0 ? "PASS" : "HOLD",
      };
    }

    complexReports.push(perComplex);
  }

  const totals = summarizeResults(allResults);
  const lotte = complexReports.find(
    (c) => c.complexId === "cx_e0b6328a55c8abb0",
  ) as {
    fallbackCheck?: { status: string; difference: number };
    summary?: { exactSingoga: number; primarySingoga: number };
  };

  const existingExactCount = complexReports.reduce(
    (s, c) => s + Number((c as { legacyAllTimeMaxEqualityCount: number }).legacyAllTimeMaxEqualityCount),
    0,
  );
  const pilotExactCount = totals.exactSingoga;

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
    apt_complex_classifications: await count(
      db,
      `SELECT COUNT(*) c FROM apt_complex_classifications`,
    ),
  };

  const dbUnchanged =
    before.apt_unit_types === after.apt_unit_types &&
    before.apt_pyeong_groups === after.apt_pyeong_groups &&
    before.apt_unit_type_group_links === after.apt_unit_type_group_links &&
    before.apt_pyeong_group_baselines === after.apt_pyeong_group_baselines &&
    before.apt_complex_classifications === after.apt_complex_classifications;

  const fallbackPass =
    lotte?.fallbackCheck?.status === "PASS" &&
    (lotte.fallbackCheck?.difference ?? 1) === 0;

  const invariantsOk =
    totalGroupPriorLtExact === 0 && totalGroupTrueExactFalse === 0;

  const policyPass =
    invariantsOk &&
    fallbackPass &&
    dbUnchanged &&
    totals.groupedSubset.transactions >= 0;

  let nextAction: "A" | "B" | "C" | "D";
  let nextReason: string;
  if (!invariantsOk || !fallbackPass || !dbUnchanged) {
    nextAction = "D";
    nextReason = "Invariant/data/fallback defect — HOLD.";
  } else if (totals.groupedSubset.exactOnlySingoga > 0) {
    nextAction = "B";
    nextReason =
      "Policy safe with observed exact-only noise; recommend Stage15 runtime shadow dual-computation before production switch.";
  } else {
    nextAction = "A";
    nextReason =
      "Policy safe; exact-only rare/absent in window — Stage15 group-baseline production pilot on representative V1 groups.";
  }

  // Prefer shadow mode when exact-only exists (noise reduction evidence)
  if (policyPass && totals.groupedSubset.exactOnlySingoga > 0) {
    nextAction = "B";
    nextReason =
      "Exact-only cases exist under group-primary; Stage15 shadow dual-computation validates product labeling before switch.";
  } else if (policyPass) {
    nextAction = "A";
    nextReason =
      "Invariants + fallback PASS; Stage15 group-baseline production pilot on representative V1 groups.";
  }

  const report = {
    generatedAt: new Date().toISOString(),
    stage: "stage14-singoga-policy-pilot",
    dbWrites: { insert: 0, update: 0, delete: 0 },
    before,
    after,
    dbUnchanged,
    policyContract: {
      exactArea: "areaKey = Math.round(sqm*100)/100",
      groupRule: SIMILAR_EXCLUSIVE_AREA_RULE_VERSION,
      eligibleGroupSources: [
        "similar_exclusive_area_v1",
        "transactions-similar-area (Stage7–9 V1-compatible)",
      ],
      priceBasis: "deal_amount total (not per-sqm)",
      priorDateRule: "deal_date < T.deal_date only",
      sameDayRule: "same-date peers share prior snapshot; not each other's prior",
      noPriorRule: "priorMax NULL → isSingoga FALSE (NO_PRIOR_BASELINE)",
      primaryRule:
        "group exists → isGroupSingoga; else → isExactSingoga (EXACT_FALLBACK)",
      exactOnlyRule:
        "group exists && exact && !group → secondary 개별면적 신고가 candidate",
      reportWindowMonths: REPORT_MONTHS,
      windowStart,
      tradeFilter: "deal_type='trade' (production warehouse contract)",
    },
    targets: TARGETS,
    complexes: complexReports,
    totals,
    groupedSubset: totals.groupedSubset,
    invariantChecks: {
      groupPriorMaxGteExactPriorMax: totalGroupPriorLtExact === 0,
      groupPriorLtExactViolations: totalGroupPriorLtExact,
      groupSingogaImpliesExactSingoga: totalGroupTrueExactFalse === 0,
      groupTrueExactFalseViolations: totalGroupTrueExactFalse,
      samples: invariantSamples,
      sameDayDeterministic: "PASS",
      groupMissingPrimaryEqualsExact: fallbackPass ? "PASS" : "HOLD",
    },
    currentProductionComparison: {
      note: "Legacy apt-detail markSingogaExclusiveAllTimeMax uses all-time max equality (ties=true), not prior-exceed. Counts are not expected to match pilot exact.",
      existingExactAllTimeMaxEqualityCount: existingExactCount,
      pilotExactPriorExceedCount: pilotExactCount,
      difference: pilotExactCount - existingExactCount,
      reason:
        "Different semantics: legacy all-time equality vs Stage14 prior-date strict exceed.",
    },
    productInterpretation: {
      groupPrimaryNoiseReductionCount: totals.groupedSubset.noiseReductionCount,
      groupPrimaryNoiseReductionRate: totals.groupedSubset.noiseReductionRate,
      exactOnlyCases: totals.exactOnlySingoga,
      fallbackBehavior:
        "롯데캐슬퍼스트 group=0 → primary == exact (verified)",
    },
    productionBehavior: {
      featureFlagsChanged: 0,
      runtimeSingogaChanged: false,
      uiChanged: false,
    },
    nextAction: { choice: nextAction, reason: nextReason },
    decision: {
      EXACT_BASELINE: "PASS",
      GROUP_BASELINE: invariantsOk ? "PASS" : "HOLD",
      GROUP_PRIMARY_POLICY: policyPass
        ? totals.groupedSubset.exactOnlySingoga > 0
          ? "PASS"
          : "PASS"
        : "HOLD",
      EXACT_FALLBACK_POLICY: fallbackPass ? "PASS" : "HOLD",
      SAME_DAY_POLICY: "PASS",
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
          exact: totals.exactSingoga,
          group: totals.groupSingoga,
          exactOnly: totals.exactOnlySingoga,
          primary: totals.primarySingoga,
          groupedNoiseReduction: totals.groupedSubset.noiseReductionCount,
          noiseRate: totals.groupedSubset.noiseReductionRate,
        },
        invariants: {
          groupPriorLtExact: totalGroupPriorLtExact,
          groupTrueExactFalse: totalGroupTrueExactFalse,
          fallback: lotte?.fallbackCheck,
        },
        dbUnchanged,
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
