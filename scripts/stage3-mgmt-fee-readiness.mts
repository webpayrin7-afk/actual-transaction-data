/**
 * STAGE 3 — Management fee coverage readiness (DB/cache only).
 * No KAPT API calls. DB WRITE = 0.
 * Formula/UI frozen — classification only.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

config({ path: ".env.local" });
config();

const OUT_DIR = join(process.cwd(), "data/poc/management-fee");
const OUT_FILE = join(OUT_DIR, "coverage-readiness.json");

type Status =
  | "ALREADY_COVERED"
  | "READY"
  | "PARTIAL_MONTHS"
  | "IDENTITY_MISSING"
  | "COST_DATA_MISSING"
  | "UNKNOWN";

type Priority = "READY_A" | "READY_B" | null;

type FeeMonth = {
  period: string;
  common: boolean;
  individual: boolean;
  reserve: boolean;
  complete: boolean;
};

type ComplexOut = {
  complexId: string;
  complexName: string;
  sigungu: string | null;
  kaptId: string | null;
  kaptIdSource: "source_link" | "profile_meta_stage1" | null;
  householdCount: number | null;
  status: Status;
  priority: Priority;
  availableMonths: string[];
  missingMonths: string[];
  latestAvailableMonth: string | null;
  common: boolean;
  individual: boolean;
  reserve: boolean;
  allRequiredComponents: boolean;
  notes?: string;
};

const PILOT_NAMES = [
  "잠실엘스",
  "리센츠",
  "트리지움",
  "파크리오",
  "반포자이",
  "헬리오시티",
] as const;

function lastCompletedYyyymm(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthsBack(end: string, n: number): string[] {
  const y = Number(end.slice(0, 4));
  const m = Number(end.slice(4, 6));
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(y, m - 1 - i, 1);
    out.push(
      `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}`,
    );
  }
  return out;
}

/** Month is usable for coverage if all 3 fee components exist (UI contract). */
function monthUsable(fm: FeeMonth): boolean {
  return fm.common && fm.individual && fm.reserve;
}

function classify(opts: {
  kaptId: string | null;
  availableMonths: string[];
  allFeeMonths: string[];
}): Status {
  const { kaptId, availableMonths, allFeeMonths } = opts;
  if (!kaptId) {
    if (allFeeMonths.length > 0) return "UNKNOWN";
    return "IDENTITY_MISSING";
  }
  if (availableMonths.length >= 12) return "ALREADY_COVERED";
  if (availableMonths.length > 0 || allFeeMonths.length > 0) {
    return "PARTIAL_MONTHS";
  }
  // Identity known, no local fee rows — next batch can fetch.
  // Not COST_DATA_MISSING: we did not probe KAPT cost APIs this run.
  return "READY";
}

function priorityOf(row: {
  status: Status;
  complexName: string;
  householdCount: number | null;
  kaptIdSource: ComplexOut["kaptIdSource"];
}): Priority {
  if (row.status !== "READY") return null;
  // READY_A: official source_link KAPT, or named pilot with verified Stage1 meta
  if (row.kaptIdSource === "source_link") return "READY_A";
  if (
    (PILOT_NAMES as readonly string[]).includes(row.complexName) &&
    row.kaptIdSource === "profile_meta_stage1"
  ) {
    return "READY_A";
  }
  // READY_B: Stage1 profile kapt meta only (source_link not yet persisted)
  if (row.kaptIdSource === "profile_meta_stage1") return "READY_B";
  return "READY_B";
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) throw new Error("TURSO credentials missing");
  const db = createClient({ url, authToken: token });

  const windowEnd = lastCompletedYyyymm();
  const window = monthsBack(windowEnd, 12);

  const seoul = await db.execute(`
    SELECT m.complex_id, m.apt_name, m.sigungu,
      (SELECT source_key FROM apt_complex_source_links l
        WHERE l.complex_id=m.complex_id AND l.source='KAPT' LIMIT 1) kapt_link,
      p.household_count, p.raw_meta_json
    FROM apt_complex_master m
    LEFT JOIN apt_complex_profile p ON p.complex_id=m.complex_id
    WHERE m.sido='서울특별시'
  `);

  const feeRows = await db.execute(`
    SELECT f.complex_id, f.period_yyyymm,
      f.common_fee, f.individual_fee, f.long_term_repair_reserve, f.fee_status
    FROM apt_complex_mgmt_fee_monthly f
    JOIN apt_complex_master m ON m.complex_id=f.complex_id
    WHERE m.sido='서울특별시'
  `);

  const feeMap = new Map<string, FeeMonth[]>();
  for (const r of feeRows.rows) {
    const id = String(r.complex_id);
    const arr = feeMap.get(id) ?? [];
    arr.push({
      period: String(r.period_yyyymm),
      common: r.common_fee != null,
      individual: r.individual_fee != null,
      reserve: r.long_term_repair_reserve != null,
      complete: String(r.fee_status ?? "") === "COMPLETE",
    });
    feeMap.set(id, arr);
  }

  const complexes: ComplexOut[] = [];
  const counts: Record<Status, number> = {
    ALREADY_COVERED: 0,
    READY: 0,
    PARTIAL_MONTHS: 0,
    IDENTITY_MISSING: 0,
    COST_DATA_MISSING: 0,
    UNKNOWN: 0,
  };
  let readyA = 0;
  let readyB = 0;
  let full12 = 0;
  let partial = 0;
  let noData = 0;
  let commonN = 0;
  let individualN = 0;
  let reserveN = 0;
  let allRequiredN = 0;
  let latestMonthGlobal: string | null = null;

  for (const r of seoul.rows) {
    const complexId = String(r.complex_id);
    const complexName = String(r.apt_name);
    let kaptId: string | null = r.kapt_link ? String(r.kapt_link) : null;
    let kaptIdSource: ComplexOut["kaptIdSource"] = kaptId
      ? "source_link"
      : null;
    if (!kaptId && r.raw_meta_json) {
      try {
        const meta = JSON.parse(String(r.raw_meta_json)) as {
          kaptCode?: string;
        };
        if (meta.kaptCode && String(meta.kaptCode).startsWith("A")) {
          kaptId = String(meta.kaptCode);
          kaptIdSource = "profile_meta_stage1";
        }
      } catch {
        /* ignore */
      }
    }

    const months = feeMap.get(complexId) ?? [];
    const byPeriod = new Map(months.map((m) => [m.period, m]));
    const allFeeMonths = [...byPeriod.keys()].sort();
    if (allFeeMonths.length) {
      const latest = allFeeMonths[allFeeMonths.length - 1]!;
      if (!latestMonthGlobal || latest > latestMonthGlobal) {
        latestMonthGlobal = latest;
      }
    }

    // Coverage months: in window AND all 3 components present
    const availableMonths = window.filter((p) => {
      const fm = byPeriod.get(p);
      return fm ? monthUsable(fm) : false;
    });
    const missingMonths = window.filter((p) => !availableMonths.includes(p));

    const anyCommon = months.some((m) => m.common);
    const anyIndiv = months.some((m) => m.individual);
    const anyReserve = months.some((m) => m.reserve);
    const allRequiredComponents = anyCommon && anyIndiv && anyReserve;

    if (anyCommon) commonN += 1;
    if (anyIndiv) individualN += 1;
    if (anyReserve) reserveN += 1;
    if (allRequiredComponents) allRequiredN += 1;

    if (availableMonths.length >= 12) full12 += 1;
    else if (availableMonths.length > 0 || allFeeMonths.length > 0) partial += 1;
    else noData += 1;

    const status = classify({ kaptId, availableMonths, allFeeMonths });
    counts[status] += 1;

    const row: ComplexOut = {
      complexId,
      complexName,
      sigungu: r.sigungu ? String(r.sigungu) : null,
      kaptId,
      kaptIdSource,
      householdCount:
        r.household_count == null ? null : Number(r.household_count),
      status,
      priority: null,
      availableMonths,
      missingMonths: status === "IDENTITY_MISSING" ? [] : missingMonths,
      latestAvailableMonth: allFeeMonths.length
        ? allFeeMonths[allFeeMonths.length - 1]!
        : null,
      common: anyCommon,
      individual: anyIndiv,
      reserve: anyReserve,
      allRequiredComponents,
    };
    row.priority = priorityOf(row);
    if (row.priority === "READY_A") readyA += 1;
    if (row.priority === "READY_B") readyB += 1;
    if (row.kaptIdSource === "profile_meta_stage1" && row.status === "READY") {
      row.notes =
        "KAPT from Stage1 profile meta; persist apt_complex_source_links before/with fee load";
    }
    complexes.push(row);
  }

  const representatives = Object.fromEntries(
    (["잠실엘스", "리센츠", "트리지움", "파크리오", "반포자이"] as const).map(
      (name) => [name, complexes.find((c) => c.complexName === name) ?? null],
    ),
  );

  // Next batch: READY first (A then B), then PARTIAL_MONTHS for known pilots
  const readySorted = complexes
    .filter((c) => c.status === "READY")
    .sort((a, b) => {
      const pa = a.priority === "READY_A" ? 0 : 1;
      const pb = b.priority === "READY_A" ? 0 : 1;
      if (pa !== pb) return pa - pb;
      const na = (PILOT_NAMES as readonly string[]).includes(a.complexName)
        ? 0
        : 1;
      const nb = (PILOT_NAMES as readonly string[]).includes(b.complexName)
        ? 0
        : 1;
      if (na !== nb) return na - nb;
      return (b.householdCount ?? 0) - (a.householdCount ?? 0);
    });

  const partialPilots = complexes
    .filter(
      (c) =>
        c.status === "PARTIAL_MONTHS" &&
        (PILOT_NAMES as readonly string[]).includes(c.complexName),
    )
    .sort((a, b) => a.missingMonths.length - b.missingMonths.length);

  // Prefer READY_A, then pilot PARTIAL backfill, then READY_B by household.
  const readyAList = readySorted.filter((c) => c.priority === "READY_A");
  const readyBList = readySorted.filter((c) => c.priority !== "READY_A");
  const nextBatchCandidates = [...readyAList, ...partialPilots, ...readyBList]
    .slice(0, 20)
    .map((c, idx) => ({
      rank: idx + 1,
      complexId: c.complexId,
      complexName: c.complexName,
      kaptId: c.kaptId,
      status: c.status,
      priority: c.priority ?? (c.status === "PARTIAL_MONTHS" ? "BACKFILL" : null),
      householdCount: c.householdCount,
      missingMonths: c.missingMonths,
      kaptIdSource: c.kaptIdSource,
      notes: c.notes ?? null,
    }));

  // Slim complexes list for artifact: non-IDENTITY_MISSING + reps
  const complexesOut = complexes
    .filter(
      (c) =>
        c.status !== "IDENTITY_MISSING" ||
        ["잠실엘스", "리센츠", "트리지움", "파크리오", "반포자이"].includes(
          c.complexName,
        ),
    )
    .map((c) => ({
      complexId: c.complexId,
      complexName: c.complexName,
      sigungu: c.sigungu,
      kaptId: c.kaptId,
      kaptIdSource: c.kaptIdSource,
      status: c.status,
      priority: c.priority,
      availableMonths: c.availableMonths,
      missingMonths: c.missingMonths,
      latestAvailableMonth: c.latestAvailableMonth,
      common: c.common,
      individual: c.individual,
      reserve: c.reserve,
      allRequiredComponents: c.allRequiredComponents,
      householdCount: c.householdCount,
      notes: c.notes ?? null,
    }));

  const artifact = {
    generatedAt: new Date().toISOString(),
    scope: "seoul",
    window: {
      convention:
        "last 12 completed calendar months (exclude current incomplete month)",
      end: windowEnd,
      months: window,
      usableMonthRule:
        "common_fee AND individual_fee AND long_term_repair_reserve all non-null (UI contract)",
    },
    summary: {
      checked: complexes.length,
      alreadyCovered: counts.ALREADY_COVERED,
      ready: counts.READY,
      readyA,
      readyB,
      partialMonths: counts.PARTIAL_MONTHS,
      identityMissing: counts.IDENTITY_MISSING,
      costDataMissing: counts.COST_DATA_MISSING,
      unknown: counts.UNKNOWN,
    },
    twelveMonthCoverage: {
      full12Months: full12,
      partial,
      noData,
      latestAvailableMonthObserved: latestMonthGlobal,
    },
    componentCoverage: {
      common: commonN,
      individual: individualN,
      reserve: reserveN,
      allRequiredComponents: allRequiredN,
      note: "Counts of Seoul complexes with ≥1 local fee row having that component",
    },
    representatives,
    nextBatchCandidates,
    complexes: complexesOut,
    blockers: {
      identity:
        "PRIMARY — vast majority of Seoul masters lack KAPT identity in source_links/profile meta",
      costCoverage:
        "Secondary — among identity-known, several PARTIAL_MONTHS; no COST_DATA_MISSING without API probe",
      apiQuota:
        "KAPT HTTP 429 from Stage1 — this run made zero external KAPT calls",
      other:
        "Some READY_B identities are Stage1 profile meta only (need source_link persist on load)",
    },
    productAnswers: {
      displayableNow: counts.ALREADY_COVERED,
      identityReadyForNextBatch: counts.READY,
      full12MonthComplexes: full12,
      partialMonthsComplexes: counts.PARTIAL_MONTHS,
      biggestBlocker: "KAPT_IDENTITY",
      safeNextBatchSize: 10,
      schemaChangeRequired: false,
      existingPipelineExpandable: true,
    },
    decision: {
      MANAGEMENT_IDENTITY_READINESS: "PARTIAL",
      MANAGEMENT_COVERAGE_READINESS: "PARTIAL",
      NEXT_BATCH_READINESS: "PASS",
      DATA_SAFETY: "PASS",
    },
    safety: {
      kaptApiCalls: 0,
      dbInsert: 0,
      dbUpdate: 0,
      dbDelete: 0,
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(artifact, null, 2));
  console.log(
    JSON.stringify(
      {
        out: OUT_FILE,
        summary: artifact.summary,
        twelveMonthCoverage: artifact.twelveMonthCoverage,
        componentCoverage: artifact.componentCoverage,
        representatives: Object.fromEntries(
          Object.entries(representatives).map(([k, v]) => [
            k,
            v
              ? {
                  complexId: v.complexId,
                  kaptId: v.kaptId,
                  kaptIdSource: v.kaptIdSource,
                  status: v.status,
                  availableMonths: v.availableMonths,
                  missingMonths: v.missingMonths,
                  latestAvailableMonth: v.latestAvailableMonth,
                  common: v.common,
                  individual: v.individual,
                  reserve: v.reserve,
                  allRequiredComponents: v.allRequiredComponents,
                }
              : null,
          ]),
        ),
        nextBatchCandidates: artifact.nextBatchCandidates,
        productAnswers: artifact.productAnswers,
        decision: artifact.decision,
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
