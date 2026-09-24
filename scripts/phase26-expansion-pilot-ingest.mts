/**
 * Phase 2.6 expansion — 5-complex portal OpenAPI per-area ingest.
 * Reuses the same ops/formula as 잠실엘스. No nationwide scan.
 *
 * Usage:
 *   npx tsx scripts/phase26-expansion-pilot-ingest.mts
 *   npx tsx scripts/phase26-expansion-pilot-ingest.mts --apply
 *   npx tsx scripts/phase26-expansion-pilot-ingest.mts --months=12 --apply
 */
import { createClient, type Client } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COMMON_OPERATIONS,
  EXPANSION_PILOT_APT_NAMES,
  INDIVIDUAL_OPERATIONS,
  PORTAL_BASIS_SERVICE,
  PORTAL_BASS_OP,
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
  process.argv.find((a) => a.startsWith("--months="))?.slice("--months=".length) ??
    "12",
);

type ApiItem = Record<string, unknown>;

type Target = {
  aptName: string;
  complexId: string;
  lawdCd: string;
  bjdongCd: string | null;
  householdCount: number | null;
};

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

function nameMatch(a: string, b: string): boolean {
  const x = a.replace(/\s+/g, "");
  const y = b.replace(/\s+/g, "");
  return x === y || x.includes(y) || y.includes(x);
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

function extractItems(payload: unknown): ApiItem[] {
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
  const rawItems = body?.items;
  const rawItem = body?.item;
  if (Array.isArray(rawItems)) return rawItems as ApiItem[];
  if (rawItems && typeof rawItems === "object") {
    const inner = (rawItems as Record<string, unknown>).item;
    if (Array.isArray(inner)) return inner as ApiItem[];
    if (inner && typeof inner === "object") return [inner as ApiItem];
  }
  if (Array.isArray(rawItem)) return rawItem as ApiItem[];
  if (rawItem && typeof rawItem === "object") return [rawItem as ApiItem];
  return [];
}

async function fetchOpSum(
  service: string,
  op: string,
  kaptCode: string,
  searchDate: string | null,
  fields: readonly string[],
): Promise<{ ok: boolean; sum: number; item: ApiItem | null; error?: string }> {
  const url =
    `${BASE}/${service}/${op}` +
    `?serviceKey=${encodeURIComponent(SERVICE_KEY)}` +
    `&kaptCode=${encodeURIComponent(kaptCode)}` +
    (searchDate ? `&searchDate=${encodeURIComponent(searchDate)}` : "") +
    `&_type=json`;
  try {
    const payload = await fetchJson(url);
    const items = extractItems(payload);
    const item = items[0] ?? null;
    if (!item) return { ok: false, sum: 0, item: null, error: "empty_item" };
    let sum = 0;
    for (const f of fields) {
      const n = toNumber(item[f]);
      if (n != null) sum += n;
    }
    return { ok: true, sum, item };
  } catch (e) {
    return {
      ok: false,
      sum: 0,
      item: null,
      error: e instanceof Error ? e.message : String(e),
    };
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
    const r = await fetchOpSum(
      "AptCmnuseManageCostServiceV3",
      op.op,
      kaptCode,
      searchDate,
      op.fields,
    );
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

async function resolveTargets(db: Client): Promise<Target[]> {
  const out: Target[] = [];
  for (const name of EXPANSION_PILOT_APT_NAMES) {
    const res = await db.execute({
      sql: `SELECT m.complex_id, m.apt_name_norm, m.lawd_cd, m.bjdong_cd, m.sido_code,
                   p.household_count
            FROM apt_complex_master m
            LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
            WHERE m.apt_name_norm = ?
            ORDER BY CASE WHEN m.sido_code = '11' THEN 0 ELSE 1 END, m.complex_id
            LIMIT 8`,
      args: [name],
    });
    const exact = res.rows.filter((r) => String(r.apt_name_norm) === name);
    const row = exact[0];
    if (!row) {
      console.log(`RESOLVE FAIL ${name}: no master row`);
      continue;
    }
    out.push({
      aptName: name,
      complexId: String(row.complex_id),
      lawdCd: String(row.lawd_cd),
      bjdongCd: row.bjdong_cd == null ? null : String(row.bjdong_cd),
      householdCount: toNumber(row.household_count),
    });
  }
  return out;
}

async function resolveKapt(db: Client, target: Target): Promise<string | null> {
  const linked = await db.execute({
    sql: `SELECT source_key FROM apt_complex_source_links
          WHERE complex_id = ? AND source = 'KAPT' LIMIT 1`,
    args: [target.complexId],
  });
  if (linked.rows[0]?.source_key) return String(linked.rows[0].source_key);

  if (target.lawdCd && target.bjdongCd) {
    const loadCode = `${target.lawdCd}${target.bjdongCd}`;
    const url =
      `${BASE}/AptListService4/getLegaldongAptList4` +
      `?serviceKey=${encodeURIComponent(SERVICE_KEY)}` +
      `&loadCode=${encodeURIComponent(loadCode)}` +
      `&pageNo=1&numOfRows=100`;
    try {
      const payload = await fetchJson(url);
      const items = extractItems(payload);
      const exact = items.find((it) => String(it.kaptName ?? "") === target.aptName);
      const fuzzy = items.find((it) =>
        nameMatch(String(it.kaptName ?? ""), target.aptName),
      );
      const hit = exact ?? fuzzy;
      if (hit?.kaptCode) return String(hit.kaptCode);
    } catch (e) {
      console.log(
        `list fail ${target.aptName}:`,
        e instanceof Error ? e.message : e,
      );
    }
    await sleep(80);
  }

  // Phase 7.1c sido list. `_type=json` can return empty items; omit it.
  const sidoCode = target.lawdCd.slice(0, 2);
  for (let page = 1; page <= 12; page++) {
    const sidoUrl =
      `${BASE}/AptListService4/getSidoAptList4` +
      `?serviceKey=${encodeURIComponent(SERVICE_KEY)}` +
      `&sidoCode=${encodeURIComponent(sidoCode)}` +
      `&pageNo=${page}&numOfRows=1000`;
    try {
      const payload = await fetchJson(sidoUrl);
      const items = extractItems(payload);
      if (items.length === 0) break;
      const exact = items.find((it) => String(it.kaptName ?? "") === target.aptName);
      const fuzzy = items.find((it) =>
        nameMatch(String(it.kaptName ?? ""), target.aptName),
      );
      const hit = exact ?? fuzzy;
      if (hit?.kaptCode) return String(hit.kaptCode);
    } catch (e) {
      console.log(
        `sido list fail ${target.aptName} p${page}:`,
        e instanceof Error ? e.message : e,
      );
      break;
    }
    await sleep(80);
  }
  return null;
}

async function fetchPrivArea(kaptCode: string): Promise<number | null> {
  const r = await fetchOpSum(PORTAL_BASIS_SERVICE, PORTAL_BASS_OP, kaptCode, null, [
    "privArea",
  ]);
  await sleep(80);
  if (!r.ok) return null;
  const n = toNumber(r.item?.privArea);
  return n != null && n > 0 ? n : null;
}

async function discoverLatest(kaptCode: string): Promise<string | null> {
  const now = new Date();
  let probe = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  for (let i = 0; i < 18; i++) {
    const r = await fetchOpSum(
      "AptCmnuseManageCostServiceV3",
      "getHsmpCleaningCostInfoV3",
      kaptCode,
      probe,
      ["cleanCost"],
    );
    await sleep(60);
    if (r.ok && r.sum > 0) return probe;
    const y = Number(probe.slice(0, 4));
    const m = Number(probe.slice(4, 6));
    const nm = m === 1 ? 12 : m - 1;
    const ny = m === 1 ? y - 1 : y;
    probe = `${ny}${String(nm).padStart(2, "0")}`;
  }
  return null;
}

async function ensureColumns(db: Client) {
  const cols = await db.execute(`PRAGMA table_info(apt_complex_mgmt_fee_monthly)`);
  const names = new Set(cols.rows.map((r) => String(r.name)));
  const alters: string[] = [];
  if (!names.has("per_area_individual_fee")) {
    alters.push(
      `ALTER TABLE apt_complex_mgmt_fee_monthly ADD COLUMN per_area_individual_fee REAL`,
    );
  }
  if (!names.has("per_area_reserve_fee")) {
    alters.push(
      `ALTER TABLE apt_complex_mgmt_fee_monthly ADD COLUMN per_area_reserve_fee REAL`,
    );
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

async function upsertMonth(
  db: Client,
  complexId: string,
  householdCount: number | null,
  row: PortalMonthTotals,
) {
  const nowIso = new Date().toISOString();
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
            household_basis=COALESCE(excluded.household_basis, apt_complex_mgmt_fee_monthly.household_basis),
            amount_basis=excluded.amount_basis,
            fee_status=excluded.fee_status,
            source=excluded.source,
            source_version=excluded.source_version,
            updated_at=excluded.updated_at`,
    args: [
      complexId,
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
      householdCount,
      "portal_operation_sum_krw",
      row.status,
      PORTAL_FEE_SOURCE,
      PORTAL_FEE_SOURCE_VERSION,
      nowIso,
    ],
  });
}

async function main() {
  if (!SERVICE_KEY) throw new Error("MOLIT_API_KEY missing");
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error("Turso env missing");

  const db = createClient({ url, authToken });
  if (APPLY) await ensureColumns(db);

  const targets = await resolveTargets(db);
  const report: unknown[] = [];
  let written = 0;

  for (const target of targets) {
    console.log(`\n=== ${target.aptName} ${target.complexId} ===`);
    const existing = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM apt_complex_mgmt_fee_monthly
            WHERE complex_id = ? AND fee_status = 'COMPLETE' AND source = ?`,
      args: [target.complexId, PORTAL_FEE_SOURCE],
    });
    const already = Number(existing.rows[0]?.n ?? 0);
    if (already >= 10 && !process.argv.includes("--force")) {
      console.log(`skip existing COMPLETE months=${already}`);
      report.push({
        ...target,
        status: "SKIP_EXISTING",
        complete: already,
      });
      continue;
    }

    const kapt = await resolveKapt(db, target);
    if (!kapt) {
      console.log("HOLD: kapt unresolved");
      report.push({ ...target, kaptCode: null, status: "HOLD", reason: "kapt_unresolved" });
      continue;
    }
    if (APPLY) {
      await db.execute({
        sql: `INSERT INTO apt_complex_source_links
                (source, source_key, complex_id, source_meta_json, source_version, created_at, updated_at)
              VALUES ('KAPT', ?, ?, NULL, 'phase26-expansion', ?, ?)
              ON CONFLICT(source, source_key) DO UPDATE SET
                complex_id=excluded.complex_id,
                updated_at=excluded.updated_at`,
        args: [kapt, target.complexId, new Date().toISOString(), new Date().toISOString()],
      }).catch((e) => {
        console.log("kapt link skip", e instanceof Error ? e.message : e);
      });
    }

    const privArea = await fetchPrivArea(kapt);
    if (privArea == null || privArea <= 0) {
      console.log("HOLD: privArea missing", kapt);
      report.push({
        ...target,
        kaptCode: kapt,
        privArea,
        status: "HOLD",
        reason: "privArea",
      });
      continue;
    }
    const latest = await discoverLatest(kapt);
    if (!latest) {
      console.log("HOLD: no available month");
      report.push({
        ...target,
        kaptCode: kapt,
        privArea,
        status: "HOLD",
        reason: "no_month",
      });
      continue;
    }
    const months = monthKeysFrom(latest, MONTHS);
    console.log(`kapt=${kapt} privArea=${privArea} months=${months.join(",")}`);
    const results: PortalMonthTotals[] = [];
    for (const month of months) {
      const row = await fetchMonthTotals(kapt, month, privArea);
      results.push(row);
      console.log(
        `  ${month} ${row.status} portal=${row.portalTotal} perM2=${row.perAreaTotal?.toFixed(5) ?? "null"} ` +
          `failC=${row.commonOps.filter((o) => !o.ok).length} failI=${row.individualOps.filter((o) => !o.ok).length}`,
      );
      if (APPLY) {
        await upsertMonth(db, target.complexId, target.householdCount, row);
        written += 1;
      }
    }
    report.push({
      ...target,
      kaptCode: kapt,
      privArea,
      latest,
      months,
      complete: results.filter((r) => r.status === "COMPLETE").length,
      incomplete: results.filter((r) => r.status === "INCOMPLETE").length,
      results,
    });
  }

  const outDir = resolve(process.cwd(), "data/poc/phase26");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(
    outDir,
    APPLY ? "expansion-ingest-apply.json" : "expansion-ingest-dryrun.json",
  );
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        apply: APPLY,
        written,
        names: EXPANSION_PILOT_APT_NAMES,
        report,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${outPath} applyRows=${written}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
