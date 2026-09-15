/**
 * STAGE 4 — Management fee small production load (exactly 5 complexes).
 * Reuses Phase 7.1c V3/V5 fee contract. Formula/UI frozen.
 *
 * Usage:
 *   npx tsx scripts/stage4-mgmt-fee-small-load.mts --apply
 *
 * On first HTTP 429: HOLD immediately (no retry loop).
 */
import { createClient, type Client } from "@libsql/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: ".env.local" });
config();

const ROOT = resolve(import.meta.dirname, "..");
const OUT_DIR = resolve(ROOT, "data/poc/management-fee");
const APPLY = process.argv.includes("--apply");
const BASE = "https://apis.data.go.kr/1613000";
const SOURCE_KAPT = "KAPT";
const SOURCE_FEE = "MOLIT_KAPT_FEE_V3";
const NOW = new Date().toISOString();
const WINDOW = [
  "202509",
  "202510",
  "202511",
  "202512",
  "202601",
  "202602",
  "202603",
  "202604",
  "202605",
  "202606",
  "202607",
  "202608",
] as const;

type Target = {
  name: string;
  complexId: string;
  kapt: string;
  months: string[];
  persistLink: boolean;
  linkEvidence?: Record<string, unknown>;
};

const TARGETS: Target[] = [
  {
    name: "리센츠",
    complexId: "cx_caf229b5ac63cfbd",
    kapt: "A13822003",
    months: [...WINDOW],
    persistLink: true,
    linkEvidence: {
      stage: "stage4",
      from: "stage1-verified",
      bjd: "1171010100",
      jibun: "22",
      kaptAddr: "서울특별시 송파구 잠실동 22 잠실리센츠",
      kaptName: "잠실리센츠",
    },
  },
  {
    name: "트리지움",
    complexId: "cx_85cd8a4b2d5dc3d0",
    kapt: "A13822002",
    months: [...WINDOW],
    persistLink: true,
    linkEvidence: {
      stage: "stage4",
      from: "stage1-verified",
      bjd: "1171010100",
      jibun: "35",
      kaptAddr: "서울특별시 송파구 잠실동 35 잠실동트리지움",
      kaptName: "잠실동트리지움",
    },
  },
  {
    name: "반포자이",
    complexId: "cx_1c244e7305d12c44",
    kapt: "A13704104",
    months: ["202608"],
    persistLink: false,
  },
  {
    name: "헬리오시티",
    complexId: "cx_30d7eea6da810b52",
    kapt: "A10025850",
    months: ["202608"],
    persistLink: false,
  },
  {
    name: "파크리오",
    complexId: "cx_ed52bf895d064c11",
    kapt: "A13824006",
    months: ["202607", "202608"],
    persistLink: false,
  },
];

/** Frozen Phase 7.1c common line-item ops. */
const COMMON_OPS = [
  "getHsmpCleaningCostInfoV3",
  "getHsmpGuardCostInfoV3",
  "getHsmpDisinfectCostInfoV3",
  "getHsmpElevatorCostInfoV3",
  "getHsmpLiquifiedTaxCostInfoV3",
  "getHsmpManageCostInfoV3",
  "getHsmpDomesticWasteCostInfoV3",
  "getHsmpMeetingCostInfoV3",
  "getHsmpBuildingInsuranceCostInfoV3",
  "getHsmpOtherCostInfoV3",
  "getHsmpElectricityCostInfoV3",
  "getHsmpWaterCostInfoV3",
  "getHsmpHeatingCostInfoV3",
  "getHsmpHotWaterCostInfoV3",
  "getHsmpGasCostInfoV3",
  "getHsmpPurificationCostInfoV3",
  "getHsmpLaborCostInfoV3",
] as const;

const INDIVIDUAL_OPS = [
  "getHsmpElectricityCostInfoV3",
  "getHsmpWaterCostInfoV3",
  "getHsmpHeatingCostInfoV3",
  "getHsmpHotWaterCostInfoV3",
  "getHsmpGasCostInfoV3",
] as const;

const INDIVIDUAL_FIELDS = [
  "electP",
  "electC",
  "waterCoolP",
  "waterCoolC",
  "heatP",
  "heatC",
  "waterHotP",
  "waterHotC",
  "gasP",
  "gasC",
] as const;

type JsonRec = Record<string, unknown>;

class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function asRec(v: unknown): JsonRec | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonRec) : null;
}

function parsePayload(text: string): {
  resultCode: string | null;
  resultMsg: string | null;
  item: JsonRec | null;
  items: JsonRec[];
} {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const j = JSON.parse(trimmed) as JsonRec;
      const response = asRec(j.response) ?? j;
      const header = asRec(response.header) ?? {};
      const body = asRec(response.body) ?? {};
      const resultCode =
        header.resultCode != null ? String(header.resultCode) : null;
      const resultMsg =
        header.resultMsg != null ? String(header.resultMsg) : null;
      const itemsNode = body.items;
      const itemNode = body.item;
      const items: JsonRec[] = [];
      if (Array.isArray(itemsNode)) {
        for (const x of itemsNode) {
          const r = asRec(x);
          if (r) items.push(r);
        }
      } else {
        const itemsObj = asRec(itemsNode);
        if (itemsObj) {
          const inner = itemsObj.item;
          if (Array.isArray(inner)) {
            for (const x of inner) {
              const r = asRec(x);
              if (r) items.push(r);
            }
          } else {
            const r = asRec(inner);
            if (r) items.push(r);
          }
        }
      }
      const item = asRec(itemNode) ?? items[0] ?? null;
      if (item && items.length === 0) items.push(item);
      return { resultCode, resultMsg, item, items };
    } catch {
      /* fall through */
    }
  }
  const resultCode = text.match(/<resultCode>([^<]*)<\/resultCode>/)?.[1] ?? null;
  const resultMsg = text.match(/<resultMsg>([^<]*)<\/resultMsg>/)?.[1] ?? null;
  return { resultCode, resultMsg, item: null, items: [] };
}

async function getJson(
  path: string,
  params: Record<string, string>,
  key: string,
): Promise<{
  http: number;
  resultCode: string | null;
  resultMsg: string | null;
  item: JsonRec | null;
  items: JsonRec[];
  ok: boolean;
}> {
  const u = new URL(`${BASE}${path}`);
  u.searchParams.set("serviceKey", key);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u.toString(), {
    headers: { Accept: "application/json" },
  });
  if (res.status === 429) {
    throw new RateLimitError(`HTTP 429 on ${path}`);
  }
  const text = await res.text();
  const parsed = parsePayload(text);
  const ok =
    res.ok &&
    (parsed.resultCode === "00" ||
      parsed.resultCode === "000" ||
      parsed.resultCode === "0" ||
      parsed.resultCode === "0000");
  return { http: res.status, ...parsed, ok };
}

function sumNumericItem(item: JsonRec | null): number | null {
  if (!item) return null;
  let total = 0;
  let any = false;
  for (const [k, v] of Object.entries(item)) {
    if (k === "kaptCode" || /date|name|code/i.test(k)) continue;
    const n = num(v);
    if (n != null) {
      total += n;
      any = true;
    }
  }
  return any ? total : null;
}

async function sumCommon(
  kapt: string,
  yyyymm: string,
  key: string,
): Promise<number | null> {
  let total = 0;
  let any = false;
  for (const op of COMMON_OPS) {
    const r = await getJson(
      `/AptCmnuseManageCostServiceV3/${op}`,
      { kaptCode: kapt, searchDate: yyyymm },
      key,
    );
    await sleep(50);
    const part = sumNumericItem(r.ok ? r.item : null);
    if (part != null) {
      total += part;
      any = true;
    }
  }
  return any ? total : null;
}

async function sumIndividual(
  kapt: string,
  yyyymm: string,
  key: string,
): Promise<number | null> {
  let total = 0;
  let any = false;
  for (const op of INDIVIDUAL_OPS) {
    const r = await getJson(
      `/AptIndvdlzManageCostServiceV3/${op}`,
      { kaptCode: kapt, searchDate: yyyymm },
      key,
    );
    await sleep(50);
    if (!r.ok || !r.item) continue;
    let part = 0;
    let partAny = false;
    for (const f of INDIVIDUAL_FIELDS) {
      if (!(f in r.item)) continue;
      const n = num(r.item[f]);
      if (n != null) {
        part += n;
        partAny = true;
      }
    }
    if (!partAny) {
      const fallback = sumNumericItem(r.item);
      if (fallback != null) {
        part = fallback;
        partAny = true;
      }
    }
    if (partAny) {
      total += part;
      any = true;
    }
  }
  return any ? total : null;
}

async function reserveLevy(
  kapt: string,
  yyyymm: string,
  key: string,
): Promise<number | null> {
  const r = await getJson(
    "/AptRepairsCostServiceV3/getHsmpMonthFeeInfoV3",
    { kaptCode: kapt, searchDate: yyyymm },
    key,
  );
  await sleep(50);
  if (!r.ok || !r.item) return null;
  return num(r.item.sLevy) ?? num(r.item.SLevy) ?? null;
}

async function ensureKaptLink(
  db: Client,
  complexId: string,
  kapt: string,
  meta: Record<string, unknown>,
): Promise<"inserted" | "exists" | "conflict"> {
  const byKey = await db.execute({
    sql: `SELECT complex_id FROM apt_complex_source_links
          WHERE source = ? AND source_key = ? LIMIT 1`,
    args: [SOURCE_KAPT, kapt],
  });
  if (byKey.rows.length) {
    const cur = String(byKey.rows[0]!.complex_id);
    if (cur === complexId) return "exists";
    return "conflict";
  }
  const byComplex = await db.execute({
    sql: `SELECT source_key FROM apt_complex_source_links
          WHERE source = ? AND complex_id = ? LIMIT 1`,
    args: [SOURCE_KAPT, complexId],
  });
  if (byComplex.rows.length) {
    const existing = String(byComplex.rows[0]!.source_key);
    if (existing === kapt) return "exists";
    return "conflict";
  }
  if (!APPLY) return "inserted";
  await db.execute({
    sql: `INSERT INTO apt_complex_source_links
            (source, source_key, complex_id, source_meta_json, source_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      SOURCE_KAPT,
      kapt,
      complexId,
      JSON.stringify(meta),
      "stage4/stage1-verified",
      NOW,
      NOW,
    ],
  });
  return "inserted";
}

async function monthCompleteLocal(
  db: Client,
  complexId: string,
  yyyymm: string,
): Promise<boolean> {
  const r = await db.execute({
    sql: `SELECT common_fee, individual_fee, long_term_repair_reserve
          FROM apt_complex_mgmt_fee_monthly
          WHERE complex_id = ? AND period_yyyymm = ?`,
    args: [complexId, yyyymm],
  });
  if (!r.rows.length) return false;
  const row = r.rows[0]!;
  return (
    row.common_fee != null &&
    row.individual_fee != null &&
    row.long_term_repair_reserve != null
  );
}

async function upsertFee(
  db: Client,
  complexId: string,
  yyyymm: string,
  common: number | null,
  individual: number | null,
  reserve: number | null,
  householdBasis: number | null,
): Promise<number> {
  if (common == null && individual == null && reserve == null) return 0;
  const totalFee =
    common != null || individual != null || reserve != null
      ? (common ?? 0) + (individual ?? 0) + (reserve ?? 0)
      : null;
  const complete =
    common != null && individual != null && reserve != null ? "COMPLETE" : "PARTIAL";
  await db.execute({
    sql: `INSERT INTO apt_complex_mgmt_fee_monthly (
            complex_id, period_yyyymm, common_fee, individual_fee, long_term_repair_reserve,
            total_fee, per_area_common_fee, per_area_total_fee, area_basis_sqm,
            household_basis, amount_basis, source, source_version, updated_at, fee_status
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(complex_id, period_yyyymm) DO UPDATE SET
            common_fee=excluded.common_fee,
            individual_fee=excluded.individual_fee,
            long_term_repair_reserve=excluded.long_term_repair_reserve,
            total_fee=excluded.total_fee,
            household_basis=excluded.household_basis,
            amount_basis=excluded.amount_basis,
            source=excluded.source,
            source_version=excluded.source_version,
            updated_at=excluded.updated_at,
            fee_status=excluded.fee_status`,
    args: [
      complexId,
      yyyymm,
      common,
      individual,
      reserve,
      totalFee,
      householdBasis,
      "complex_month_total_krw",
      SOURCE_FEE,
      "stage4/AptCmnuse+AptIndvdlz+AptRepairs V3",
      NOW,
      complete,
    ],
  });
  return 1;
}

async function setEnrichment(
  db: Client,
  complexId: string,
  domain: string,
  status: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO apt_complex_enrichment_state
            (complex_id, domain, status, reason_code, data_version, processed_at, updated_at)
          VALUES (?, ?, ?, NULL, 'stage4', ?, ?)
          ON CONFLICT(complex_id, domain) DO UPDATE SET
            status=excluded.status,
            data_version=excluded.data_version,
            processed_at=excluded.processed_at,
            updated_at=excluded.updated_at`,
    args: [complexId, domain, status, NOW, NOW],
  });
}

async function main() {
  if (!APPLY) {
    console.error("Refusing dry-run for production load; pass --apply");
    process.exit(2);
  }
  const key = process.env.MOLIT_API_KEY?.trim();
  if (!key) throw new Error("MOLIT_API_KEY missing");
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });

  mkdirSync(OUT_DIR, { recursive: true });

  const report: Record<string, unknown> = {
    generatedAt: NOW,
    mode: "apply",
    window: WINDOW,
    rateLimitGate: null as null | Record<string, unknown>,
    decision: "IN_PROGRESS",
    writes: { source_links: 0, management_rows: 0, skipped_existing: 0 },
    targets: [] as Array<Record<string, unknown>>,
  };

  // ---- Rate-limit gate: one cheap management call ----
  try {
    const gate = await getJson(
      "/AptCmnuseManageCostServiceV3/getHsmpCleaningCostInfoV3",
      { kaptCode: "A13822003", searchDate: "202608" },
      key,
    );
    report.rateLimitGate = {
      status: "PASS",
      http: gate.http,
      resultCode: gate.resultCode,
      probe: "리센츠 A13822003 202608 cleaning",
    };
    console.log("RATE_LIMIT_GATE PASS", gate.http, gate.resultCode);
  } catch (e) {
    if (e instanceof RateLimitError) {
      report.rateLimitGate = { status: "HOLD", reason: e.message };
      report.decision = "HOLD";
      writeFileSync(
        resolve(OUT_DIR, "stage4-small-load-report.json"),
        JSON.stringify(report, null, 2),
      );
      console.log("RATE_LIMIT_GATE HOLD — stopping Stage4, no retries");
      process.exit(0);
    }
    throw e;
  }

  try {
    for (const t of TARGETS) {
      const entry: Record<string, unknown> = {
        name: t.name,
        complexId: t.complexId,
        kapt: t.kapt,
        link: null,
        monthsRequested: t.months,
        monthsLoaded: [] as string[],
        monthsSkippedExisting: [] as string[],
        monthsEmpty: [] as string[],
        errors: [] as string[],
      };

      if (t.persistLink) {
        const linkOp = await ensureKaptLink(
          db,
          t.complexId,
          t.kapt,
          t.linkEvidence ?? { stage: "stage4" },
        );
        entry.link = linkOp;
        if (linkOp === "inserted") {
          (report.writes as { source_links: number }).source_links += 1;
        }
        if (linkOp === "conflict") {
          (entry.errors as string[]).push("KAPT source_link conflict — abort target");
          (report.targets as unknown[]).push(entry);
          continue;
        }
      }

      // household from profile (already Stage1-filled for reps)
      const hhRes = await db.execute({
        sql: `SELECT household_count FROM apt_complex_profile WHERE complex_id=?`,
        args: [t.complexId],
      });
      let household =
        hhRes.rows[0]?.household_count != null
          ? Number(hhRes.rows[0].household_count)
          : null;

      if (household == null) {
        const bass = await getJson(
          "/AptBasisInfoServiceV5/getAphusBassInfoV5",
          { kaptCode: t.kapt },
          key,
        );
        await sleep(80);
        household = num(bass.item?.kaptdaCnt);
      }

      for (const ym of t.months) {
        if (await monthCompleteLocal(db, t.complexId, ym)) {
          (entry.monthsSkippedExisting as string[]).push(ym);
          (report.writes as { skipped_existing: number }).skipped_existing += 1;
          continue;
        }
        const common = await sumCommon(t.kapt, ym, key);
        const individual = await sumIndividual(t.kapt, ym, key);
        const reserve = await reserveLevy(t.kapt, ym, key);
        if (common == null && individual == null && reserve == null) {
          (entry.monthsEmpty as string[]).push(ym);
          continue;
        }
        const n = await upsertFee(
          db,
          t.complexId,
          ym,
          common,
          individual,
          reserve,
          household,
        );
        (report.writes as { management_rows: number }).management_rows += n;
        (entry.monthsLoaded as string[]).push(ym);
        console.log(
          JSON.stringify({
            apt: t.name,
            ym,
            common,
            individual,
            reserve,
            household,
          }),
        );
      }

      // refresh enrichment if any fee months now present
      const cnt = await db.execute({
        sql: `SELECT COUNT(*) c FROM apt_complex_mgmt_fee_monthly WHERE complex_id=?`,
        args: [t.complexId],
      });
      if (Number(cnt.rows[0]!.c) > 0) {
        await setEnrichment(db, t.complexId, "MANAGEMENT_FEE", "READY");
      }

      // post window coverage
      const post = await db.execute({
        sql: `SELECT period_yyyymm FROM apt_complex_mgmt_fee_monthly
              WHERE complex_id=? AND period_yyyymm >= '202509' AND period_yyyymm <= '202608'
                AND common_fee IS NOT NULL AND individual_fee IS NOT NULL
                AND long_term_repair_reserve IS NOT NULL
              ORDER BY 1`,
        args: [t.complexId],
      });
      entry.windowCompleteMonths = post.rows.map((r) => String(r.period_yyyymm));
      entry.windowCompleteCount = post.rows.length;

      (report.targets as unknown[]).push(entry);
    }

    report.decision = "PASS";
  } catch (e) {
    if (e instanceof RateLimitError) {
      report.decision = "PARTIAL_HOLD_429";
      report.rateLimitDuringLoad = e.message;
      console.log("RATE_LIMIT during load — HOLD further fetches:", e.message);
    } else {
      report.decision = "ERROR";
      report.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  writeFileSync(
    resolve(OUT_DIR, "stage4-small-load-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ decision: report.decision, writes: report.writes }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
