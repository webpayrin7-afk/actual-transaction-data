/**
 * STAGE 3 — Management fee coverage readiness (cache/DB only).
 * No KAPT API calls. DB WRITE = 0.
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
  | "IDENTITY_MISSING"
  | "COST_DATA_MISSING"
  | "PARTIAL_MONTHS"
  | "UNKNOWN";

type Priority = "READY_A" | "READY_B" | null;

type ComplexRow = {
  complexId: string;
  complexName: string;
  sigungu: string | null;
  kaptId: string | null;
  kaptIdSource: "source_link" | "profile_meta_stage1" | null;
  householdCount: number | null;
  status: Status;
  availableMonths: string[];
  missingMonths: string[];
  allFeeMonths: string[];
  priority: Priority;
  notes?: string;
};

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

function classify(opts: {
  kaptId: string | null;
  availableMonths: string[];
  allFeeMonths: string[];
}): Status {
  const { kaptId, availableMonths, allFeeMonths } = opts;
  if (!kaptId) {
    // fee without identity should be rare; still not COST_DATA_MISSING
    if (allFeeMonths.length > 0) return "UNKNOWN";
    return "IDENTITY_MISSING";
  }
  if (availableMonths.length >= 12) return "ALREADY_COVERED";
  if (availableMonths.length > 0) return "PARTIAL_MONTHS";
  if (allFeeMonths.length > 0) return "PARTIAL_MONTHS";
  // identity present, no fee rows in warehouse → next batch can load
  // (not COST_DATA_MISSING: we did not probe API; absence of cache ≠ confirmed missing)
  return "READY";
}

function priorityOf(row: {
  status: Status;
  complexName: string;
  householdCount: number | null;
  kaptIdSource: ComplexRow["kaptIdSource"];
}): Priority {
  if (row.status !== "READY") return null;
  const pilot = ["잠실엘스", "리센츠", "트리지움", "파크리오", "반포자이", "헬리오시티"];
  if (pilot.includes(row.complexName)) return "READY_A";
  if (row.kaptIdSource === "source_link" && (row.householdCount ?? 0) >= 1000) {
    return "READY_A";
  }
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
    SELECT f.complex_id, f.period_yyyymm
    FROM apt_complex_mgmt_fee_monthly f
    JOIN apt_complex_master m ON m.complex_id=f.complex_id
    WHERE m.sido='서울특별시'
  `);
  const feeMap = new Map<string, string[]>();
  for (const r of feeRows.rows) {
    const id = String(r.complex_id);
    const arr = feeMap.get(id) ?? [];
    arr.push(String(r.period_yyyymm));
    feeMap.set(id, arr);
  }
  for (const [k, v] of feeMap) feeMap.set(k, [...new Set(v)].sort());

  const complexes: ComplexRow[] = [];
  const counts: Record<Status, number> = {
    ALREADY_COVERED: 0,
    READY: 0,
    IDENTITY_MISSING: 0,
    COST_DATA_MISSING: 0,
    PARTIAL_MONTHS: 0,
    UNKNOWN: 0,
  };

  for (const r of seoul.rows) {
    const complexId = String(r.complex_id);
    const complexName = String(r.apt_name);
    let kaptId: string | null = r.kapt_link ? String(r.kapt_link) : null;
    let kaptIdSource: ComplexRow["kaptIdSource"] = kaptId ? "source_link" : null;
    if (!kaptId && r.raw_meta_json) {
      try {
        const meta = JSON.parse(String(r.raw_meta_json)) as {
          kaptCode?: string;
          stage?: string;
        };
        if (meta.kaptCode && String(meta.kaptCode).startsWith("A")) {
          kaptId = String(meta.kaptCode);
          kaptIdSource = "profile_meta_stage1";
        }
      } catch {
        /* ignore */
      }
    }
    const allFeeMonths = feeMap.get(complexId) ?? [];
    const availableMonths = window.filter((m) => allFeeMonths.includes(m));
    const missingMonths = window.filter((m) => !allFeeMonths.includes(m));
    const status = classify({ kaptId, availableMonths, allFeeMonths });
    counts[status] += 1;
    const row: ComplexRow = {
      complexId,
      complexName,
      sigungu: r.sigungu ? String(r.sigungu) : null,
      kaptId,
      kaptIdSource,
      householdCount:
        r.household_count == null ? null : Number(r.household_count),
      status,
      availableMonths,
      missingMonths: status === "IDENTITY_MISSING" ? [] : missingMonths,
      allFeeMonths,
      priority: null,
    };
    row.priority = priorityOf(row);
    complexes.push(row);
  }

  const repNames = ["잠실엘스", "리센츠", "트리지움", "파크리오", "반포자이"];
  const representatives = Object.fromEntries(
    repNames.map((name) => {
      const hit = complexes.find((c) => c.complexName === name) ?? null;
      return [name, hit];
    }),
  );

  const readyCandidates = complexes
    .filter((c) => c.status === "READY")
    .sort((a, b) => {
      const pa = a.priority === "READY_A" ? 0 : 1;
      const pb = b.priority === "READY_A" ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return (b.householdCount ?? 0) - (a.householdCount ?? 0);
    })
    .slice(0, 10);

  const detail = complexes.filter(
    (c) =>
      c.status !== "IDENTITY_MISSING" ||
      repNames.includes(c.complexName),
  );

  const artifact = {
    generatedAt: new Date().toISOString(),
    scope: "서울특별시 apt_complex_master (local DB/cache only; no KAPT API)",
    window: {
      convention: "last 12 completed calendar months (exclude current month)",
      end: windowEnd,
      months: window,
    },
    summary: {
      complexesChecked: complexes.length,
      ...counts,
    },
    blockers: {
      identity:
        "Dominant: 서울 KAPT source_link coverage is tiny (almost all IDENTITY_MISSING).",
      costAvailability:
        "Secondary among identity-known complexes: some PARTIAL_MONTHS; no confirmed COST_DATA_MISSING without API probe.",
      apiQuota:
        "KAPT HTTP 429 from Stage1 — Stage3 intentionally made zero external KAPT calls.",
      other:
        "리센츠/트리지움 have Stage1 profile kaptCode but no apt_complex_source_links KAPT row yet.",
    },
    productAnswers: {
      displayableNow: counts.ALREADY_COVERED,
      identityReadyForNextBatch: counts.READY,
      biggestBlocker: "KAPT identity coverage (IDENTITY_MISSING)",
      safeNextBatchSize: Math.min(10, counts.READY || readyCandidates.length),
      schemaChangeRequired: false,
      existingPipelineExpandable: true,
    },
    representatives,
    readyCandidates,
    nonIdentityMissingDetail: detail,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(artifact, null, 2));
  console.log(
    JSON.stringify(
      {
        out: OUT_FILE,
        summary: artifact.summary,
        window: artifact.window,
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
                  priority: v.priority,
                }
              : null,
          ]),
        ),
        readyCandidates: readyCandidates.map((c) => ({
          complexId: c.complexId,
          complexName: c.complexName,
          kaptId: c.kaptId,
          priority: c.priority,
          householdCount: c.householdCount,
        })),
        productAnswers: artifact.productAnswers,
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
