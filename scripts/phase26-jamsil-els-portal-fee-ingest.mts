/**
 * Phase 2.6 — 잠실엘스 portal OpenAPI → per-area fee ingest (pilot only).
 *
 * Usage:
 *   npx tsx scripts/phase26-jamsil-els-portal-fee-ingest.mts
 *   npx tsx scripts/phase26-jamsil-els-portal-fee-ingest.mts --apply
 *   npx tsx scripts/phase26-jamsil-els-portal-fee-ingest.mts --months=12 --apply
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COMMON_OPERATIONS,
  INDIVIDUAL_OPERATIONS,
  PILOT_COMPLEX_ID,
  PILOT_KAPT_CODE,
  PILOT_PRIV_AREA_M2,
  PORTAL_FEE_SOURCE,
  PORTAL_FEE_SOURCE_VERSION,
  type PortalMonthTotals,
} from "../src/lib/complex-detail/portal-mgmt-fee-ops";

config({ path: resolve(process.cwd(), ".env.local") });
config();

const BASE = "https://apis.data.go.kr/1613000";
const SERVICE_KEY = process.env.MOLIT_API_KEY?.trim() ?? "";
const APPLY = process.argv.includes("--apply");
const MONTHS = Number(
  process.argv.find((a) => a.startsWith("--months="))?.slice("--months=".length) ?? "12",
);

type ApiItem = Record<string, unknown>;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function toNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function monthKeysFrom(latestYyyymm: string, count: number): string[] {
  const y = Number(latestYyyymm.slice(0, 4));
  const m = Number(latestYyyymm.slice(4, 6));
  const out: string[] = [];
  let yy = y;
  let mm = m;
  for (let i = 0; i < count; i++) {
    out.push(`${yy}${String(mm).padStart(2, "0")}`);
    mm -= 1;
    if (mm === 0) {
      mm = 12;
      yy -= 1;
    }
  }
  return out;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
}

function extractItem(payload: unknown): ApiItem | null {
  const root = payload as Record<string, unknown>;
  const openApi = root.OpenAPI_ServiceResponse as Record<string, unknown> | undefined;
  if (openApi?.cmmMsgHeader) {
    const h = openApi.cmmMsgHeader as Record<string, unknown>;
    throw new Error(
      `OpenAPI error ${String(h.returnReasonCode ?? "")}: ${String(h.returnAuthMsg ?? "")}`,
    );
  }
  const response = root.response as Record<string, unknown> | undefined;
  const header = response?.header as Record<string, unknown> | undefined;
  const resultCode = String(header?.resultCode ?? "");
  if (resultCode && resultCode !== "00" && resultCode !== "000") {
    throw new Error(`API ${resultCode}: ${String(header?.resultMsg ?? "")}`);
  }
  const body = response?.body as Record<string, unknown> | undefined;
  const items = body?.item ?? (body?.items as Record<string, unknown> | undefined)?.item;
  if (Array.isArray(items)) return (items[0] as ApiItem) ?? null;
  if (items && typeof items === "object") return items as ApiItem;
  return null;
}

async function fetchOpSum(
  service: string,
  op: string,
  kaptCode: string,
  searchDate: string,
  fields: readonly string[],
): Promise<{ ok: boolean; sum: number; error?: string }> {
  const url =
    `${BASE}/${service}/${op}` +
    `?serviceKey=${encodeURIComponent(SERVICE_KEY)}` +
    `&kaptCode=${encodeURIComponent(kaptCode)}` +
    `&searchDate=${encodeURIComponent(searchDate)}` +
    `&_type=json`;
  try {
    const payload = await fetchJson(url);
    const item = extractItem(payload);
    if (!item) return { ok: false, sum: 0, error: "empty_item" };
    let sum = 0;
    for (const f of fields) {
      const n = toNumber(item[f]);
      if (n != null) sum += n;
    }
    return { ok: true, sum };
  } catch (e) {
    return { ok: false, sum: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchMonthTotals(
  kaptCode: string,
  searchDate: string,
  privArea: number,
): Promise<PortalMonthTotals> {
  const commonOps: PortalMonthTotals["commonOps"] = [];
  let commonTotal = 0;
  let commonOk = true;
  for (const op of COMMON_OPERATIONS) {
    const r = await fetchOpSum("AptCmnuseManageCostServiceV3", op.op, kaptCode, searchDate, op.fields);
    await sleep(80);
    commonOps.push({ op: op.op, ok: r.ok, sum: r.sum, error: r.error });
    if (!r.ok) commonOk = false;
    else commonTotal += r.sum;
  }

  const individualOps: PortalMonthTotals["individualOps"] = [];
  let individualTotal = 0;
  let individualOk = true;
  for (const op of INDIVIDUAL_OPERATIONS) {
    const r = await fetchOpSum(
      "AptIndvdlzManageCostServiceV3",
      op.op,
      kaptCode,
      searchDate,
      op.fields,
    );
    await sleep(80);
    individualOps.push({ op: op.op, ok: r.ok, sum: r.sum, error: r.error });
    if (!r.ok) individualOk = false;
    else individualTotal += r.sum;
  }

  const reserveR = await fetchOpSum(
    "AptRepairsCostServiceV3",
    "getHsmpMonthFeeInfoV3",
    kaptCode,
    searchDate,
    ["sLevy"],
  );
  await sleep(80);

  const reserveTotal = reserveR.ok ? reserveR.sum : 0;
  const portalTotal = commonTotal + individualTotal + reserveTotal;
  // Unpublished months can return HTTP-success empty/zero payloads for every op.
  // Require a positive portal total for COMPLETE (line-item zeros remain allowed).
  const status: PortalMonthTotals["status"] =
    commonOk &&
    individualOk &&
    reserveR.ok &&
    privArea > 0 &&
    portalTotal > 0
      ? "COMPLETE"
      : "INCOMPLETE";
  const perAreaTotal = privArea > 0 ? portalTotal / privArea : null;

  return {
    searchDate,
    kaptCode,
    privArea,
    commonTotal,
    individualTotal,
    reserveTotal,
    portalTotal,
    perAreaCommon: privArea > 0 ? commonTotal / privArea : null,
    perAreaIndividual: privArea > 0 ? individualTotal / privArea : null,
    perAreaReserve: privArea > 0 ? reserveTotal / privArea : null,
    perAreaTotal,
    status,
    commonOps,
    individualOps,
    reserveOk: reserveR.ok,
    reserveError: reserveR.error,
  };
}

async function ensureColumns(db: ReturnType<typeof createClient>) {
  const cols = await db.execute(`PRAGMA table_info(apt_complex_mgmt_fee_monthly)`);
  const names = new Set(cols.rows.map((r) => String(r.name)));
  const alters: string[] = [];
  if (!names.has("per_area_individual_fee")) {
    alters.push(`ALTER TABLE apt_complex_mgmt_fee_monthly ADD COLUMN per_area_individual_fee REAL`);
  }
  if (!names.has("per_area_reserve_fee")) {
    alters.push(`ALTER TABLE apt_complex_mgmt_fee_monthly ADD COLUMN per_area_reserve_fee REAL`);
  }
  if (!names.has("area_basis")) {
    alters.push(`ALTER TABLE apt_complex_mgmt_fee_monthly ADD COLUMN area_basis TEXT`);
  }
  if (!names.has("fee_status")) {
    alters.push(`ALTER TABLE apt_complex_mgmt_fee_monthly ADD COLUMN fee_status TEXT`);
  }
  for (const sql of alters) {
    await db.execute(sql);
    console.log("schema:", sql);
  }
}

async function main() {
  if (!SERVICE_KEY) throw new Error("MOLIT_API_KEY missing");
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("Turso env missing");

  const db = createClient({ url, authToken });
  if (APPLY) await ensureColumns(db);

  // Discover latest available month via cleaning cost (non-zero when published).
  const now = new Date();
  let probe = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  let latest: string | null = null;
  for (let i = 0; i < 18; i++) {
    const r = await fetchOpSum(
      "AptCmnuseManageCostServiceV3",
      "getHsmpCleaningCostInfoV3",
      PILOT_KAPT_CODE,
      probe,
      ["cleanCost"],
    );
    await sleep(60);
    if (r.ok && r.sum > 0) {
      latest = probe;
      break;
    }
    const y = Number(probe.slice(0, 4));
    const m = Number(probe.slice(4, 6));
    const nm = m === 1 ? 12 : m - 1;
    const ny = m === 1 ? y - 1 : y;
    probe = `${ny}${String(nm).padStart(2, "0")}`;
  }
  if (!latest) throw new Error("No available month found for pilot");

  const months = monthKeysFrom(latest, MONTHS);
  console.log(`pilot ${PILOT_KAPT_CODE} months=${months.join(",")} apply=${APPLY}`);

  const results: PortalMonthTotals[] = [];
  for (const month of months) {
    console.log(`fetch ${month}…`);
    const row = await fetchMonthTotals(PILOT_KAPT_CODE, month, PILOT_PRIV_AREA_M2);
    results.push(row);
    console.log(
      `  ${month} ${row.status} portal=${row.portalTotal} perM2=${row.perAreaTotal?.toFixed(5) ?? "null"} ` +
        `c=${row.commonTotal} i=${row.individualTotal} r=${row.reserveTotal} ` +
        `failC=${row.commonOps.filter((o) => !o.ok).length} failI=${row.individualOps.filter((o) => !o.ok).length} resOk=${row.reserveOk}`,
    );
  }

  let written = 0;
  if (APPLY) {
    const nowIso = new Date().toISOString();
    for (const row of results) {
      await db.execute({
        sql: `INSERT INTO apt_complex_mgmt_fee_monthly (
            complex_id, period_yyyymm,
            common_fee, individual_fee, long_term_repair_reserve, total_fee,
            per_area_common_fee, per_area_individual_fee, per_area_reserve_fee, per_area_total_fee,
            area_basis_sqm, area_basis, household_basis, amount_basis,
            fee_status, source, source_version, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(complex_id, period_yyyymm) DO UPDATE SET
            common_fee=excluded.common_fee,
            individual_fee=excluded.individual_fee,
            long_term_repair_reserve=excluded.long_term_repair_reserve,
            total_fee=excluded.total_fee,
            per_area_common_fee=excluded.per_area_common_fee,
            per_area_individual_fee=excluded.per_area_individual_fee,
            per_area_reserve_fee=excluded.per_area_reserve_fee,
            per_area_total_fee=excluded.per_area_total_fee,
            area_basis_sqm=excluded.area_basis_sqm,
            area_basis=excluded.area_basis,
            household_basis=excluded.household_basis,
            amount_basis=excluded.amount_basis,
            fee_status=excluded.fee_status,
            source=excluded.source,
            source_version=excluded.source_version,
            updated_at=excluded.updated_at`,
        args: [
          PILOT_COMPLEX_ID,
          row.searchDate,
          row.commonTotal,
          row.individualTotal,
          row.reserveTotal,
          row.portalTotal,
          row.perAreaCommon,
          row.perAreaIndividual,
          row.perAreaReserve,
          row.perAreaTotal,
          row.privArea,
          "residential_exclusive",
          5678,
          "portal_operation_sum_krw",
          row.status,
          PORTAL_FEE_SOURCE,
          PORTAL_FEE_SOURCE_VERSION,
          nowIso,
        ],
      });
      written += 1;
    }
  }

  const outDir = resolve(process.cwd(), "data/poc/phase26");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, APPLY ? "ingest-apply.json" : "ingest-dryrun.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        apply: APPLY,
        complexId: PILOT_COMPLEX_ID,
        kaptCode: PILOT_KAPT_CODE,
        privArea: PILOT_PRIV_AREA_M2,
        months,
        written,
        complete: results.filter((r) => r.status === "COMPLETE").length,
        incomplete: results.filter((r) => r.status === "INCOMPLETE").length,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${outPath} applyRows=${written}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
