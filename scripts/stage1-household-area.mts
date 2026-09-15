#!/usr/bin/env npx tsx
/**
 * STAGE 1 — household_count enrichment + area/unit readiness audit
 *
 * WRITE: apt_complex_profile.household_count NULL→verified only
 *        (create profile row if missing — carrier for household_count)
 * NO WRITE: apt_unit_types, apt_unit_type_group_links, apt_pyeong_groups, baselines
 *
 * Usage:
 *   npx tsx scripts/stage1-household-area.mts
 *   npx tsx scripts/stage1-household-area.mts --apply
 *   npx tsx scripts/stage1-household-area.mts --apply --batch=300
 */
import { createClient } from "@libsql/client";
import { config as loadEnv } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

loadEnv({ path: ".env.local" });
loadEnv();

const APPLY = process.argv.includes("--apply");
const batchArg = process.argv.find((a) => a.startsWith("--batch="));
const BATCH = Math.min(500, Math.max(50, Number(batchArg?.split("=")[1] ?? 300) || 300));
const API_BASE = "https://apis.data.go.kr/1613000";
const SERVICE_KEY = process.env.MOLIT_API_KEY?.trim();
const DB_URL = process.env.TURSO_DATABASE_URL?.trim();
const DB_TOKEN = process.env.TURSO_AUTH_TOKEN?.trim();
const OUT_DIR = join(process.cwd(), "data/poc/unit-area");

type Json = Record<string, unknown>;
type MasterRow = {
  complex_id: string;
  apt_name: string;
  apt_name_norm: string;
  sido: string | null;
  sigungu: string | null;
  lawd_cd: string | null;
  legal_dong_name: string | null;
  bjdong_cd: string | null;
  jibun: string | null;
};
type KaptListItem = {
  kaptCode: string;
  kaptName: string;
  bjdCode: string;
  as1?: string;
  as2?: string;
  as3?: string;
  as4?: string;
};
type BassInfo = {
  kaptCode: string;
  kaptName: string;
  kaptAddr: string;
  kaptdaCnt: number | null;
  codeSaleNm?: string;
  codeHeatNm?: string;
};
type AreaRow = {
  exclusive_area: number;
  tx_count: number;
  recent_tx: boolean;
  has_unit_type: boolean;
  unit_type_id: string | null;
  group_id: string | null;
  approx_pyeong: number;
};
type ComplexAreaAudit = {
  complexId: string;
  complexName: string;
  rawAreaCount: number;
  unitTypeCount: number;
  groupCount: number;
  linkedCount: number;
  unlinkedCount: number;
  status: string;
  areas?: AreaRow[];
  unlinkedAreas?: number[];
};

function mustEnv(): void {
  if (!SERVICE_KEY) throw new Error("MOLIT_API_KEY missing");
  if (!DB_URL || !DB_TOKEN) throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeJibun(j: string | null | undefined): string {
  return String(j ?? "")
    .replace(/\s+/g, "")
    .replace(/번지$/g, "")
    .replace(/^0+/, "")
    .trim();
}

function jibunInAddr(jibun: string, addr: string): boolean {
  const j = normalizeJibun(jibun);
  if (!j) return false;
  const a = String(addr ?? "").replace(/\s+/g, "");
  if (a.includes(j + "번지") || a.includes(j)) {
    const re = new RegExp(`(^|[^0-9])${j.replace(/-/g, "[-－]")}($|[^0-9]|번지)`);
    return re.test(a);
  }
  return false;
}

function namesCompatible(masterName: string, kaptName: string): boolean {
  const a = masterName.replace(/\s+/g, "");
  const b = kaptName.replace(/\s+/g, "");
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

async function fetchJson(url: string): Promise<Json> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return (await res.json()) as Json;
}

async function getSigunguAptList(sigunguCode: string): Promise<KaptListItem[]> {
  const url =
    `${API_BASE}/AptListService4/getSigunguAptList4` +
    `?serviceKey=${encodeURIComponent(SERVICE_KEY!)}` +
    `&sigunguCode=${encodeURIComponent(sigunguCode)}&numOfRows=5000&pageNo=1&_type=json`;
  const json = await fetchJson(url);
  const body = (json.response as Json)?.body as Json | undefined;
  const items = body?.items;
  if (Array.isArray(items)) return items as KaptListItem[];
  if (items && typeof items === "object" && Array.isArray((items as Json).item)) {
    return (items as Json).item as KaptListItem[];
  }
  return [];
}

async function getBassInfo(kaptCode: string): Promise<BassInfo | null> {
  const url =
    `${API_BASE}/AptBasisInfoServiceV5/getAphusBassInfoV5` +
    `?serviceKey=${encodeURIComponent(SERVICE_KEY!)}` +
    `&kaptCode=${encodeURIComponent(kaptCode)}&_type=json`;
  const json = await fetchJson(url);
  const body = (json.response as Json)?.body as Json | undefined;
  const item = body?.item as Json | undefined;
  if (!item || typeof item !== "object") return null;
  return {
    kaptCode: String(item.kaptCode ?? kaptCode),
    kaptName: String(item.kaptName ?? ""),
    kaptAddr: String(item.kaptAddr ?? ""),
    kaptdaCnt: num(item.kaptdaCnt),
    codeSaleNm: item.codeSaleNm != null ? String(item.codeSaleNm) : undefined,
    codeHeatNm: item.codeHeatNm != null ? String(item.codeHeatNm) : undefined,
  };
}

type MatchResult =
  | { status: "matched"; kaptCode: string; bass: BassInfo; evidence: string }
  | { status: "ambiguous"; candidates: string[]; evidence: string }
  | { status: "unresolved"; evidence: string };

async function matchMasterToKapt(
  master: MasterRow,
  listCache: Map<string, KaptListItem[]>,
): Promise<MatchResult> {
  const lawd = master.lawd_cd;
  const jibun = normalizeJibun(master.jibun);
  const bjd = master.bjdong_cd;
  if (!lawd || lawd.length < 5) return { status: "unresolved", evidence: "missing lawd_cd" };
  if (!jibun) return { status: "unresolved", evidence: "missing jibun" };
  if (!bjd) return { status: "unresolved", evidence: "missing bjdong_cd" };

  // Master often stores 5-digit legal-dong; KAPT list uses 10-digit (sigungu+dong).
  const fullBjd = bjd.length >= 10 ? bjd : `${lawd.slice(0, 5)}${bjd}`;

  const sigungu = lawd.slice(0, 5);
  if (!listCache.has(sigungu)) {
    listCache.set(sigungu, await getSigunguAptList(sigungu));
    await sleep(120);
  }
  const list = listCache.get(sigungu)!;
  const bjdCands = list.filter((it) => String(it.bjdCode) === fullBjd);
  if (bjdCands.length === 0) {
    return { status: "unresolved", evidence: `no KAPT list rows for bjdCode=${fullBjd}` };
  }

  const nameCands = bjdCands.filter((it) => namesCompatible(master.apt_name, it.kaptName));
  const pool = nameCands.length > 0 ? nameCands : bjdCands;

  const verified: { item: KaptListItem; bass: BassInfo }[] = [];
  for (const it of pool) {
    const bass = await getBassInfo(it.kaptCode);
    await sleep(80);
    if (!bass) continue;
    if (!jibunInAddr(jibun, bass.kaptAddr)) continue;
    if (nameCands.length > 0 && !namesCompatible(master.apt_name, bass.kaptName)) continue;
    verified.push({ item: it, bass });
  }

  if (verified.length === 1) {
    const v = verified[0]!;
    return {
      status: "matched",
      kaptCode: v.item.kaptCode,
      bass: v.bass,
      evidence: `bjd=${fullBjd} jibun=${jibun} in kaptAddr="${v.bass.kaptAddr}" name~="${v.bass.kaptName}"`,
    };
  }
  if (verified.length > 1) {
    return {
      status: "ambiguous",
      candidates: verified.map((v) => v.item.kaptCode),
      evidence: `multiple jibun-verified: ${verified.map((v) => v.item.kaptCode).join(",")}`,
    };
  }
  return {
    status: "unresolved",
    evidence: `no jibun-verified among ${pool.length} pool (bjd=${fullBjd} jibun=${jibun})`,
  };
}

function classifyAreaStatus(a: {
  rawAreaCount: number;
  unitTypeCount: number;
  linkedCount: number;
  groupCount: number;
}): string {
  if (a.rawAreaCount <= 0) return "AMBIGUOUS";
  if (a.unitTypeCount <= 0) return "RAW_AREA_ONLY";
  if (a.linkedCount <= 0 || a.groupCount <= 0) return "GROUP_LINK_MISSING";
  if (a.linkedCount < a.rawAreaCount || a.unitTypeCount < a.rawAreaCount) {
    return "PARTIAL_UNIT_MASTER";
  }
  return "AREA_READY";
}

function matchUnitForArea(
  ea: number,
  units: { key: string; min: number; max: number }[],
): string | null {
  for (const u of units) {
    if (ea >= u.min - 1e-6 && ea <= u.max + 1e-6) return u.key;
  }
  // exact float key fallback
  for (const u of units) {
    if (Math.abs(u.min - ea) < 1e-4 || Math.abs(u.max - ea) < 1e-4) return u.key;
  }
  return null;
}

async function resolveComplexKey(
  db: ReturnType<typeof createClient>,
  complexId: string,
): Promise<string | null> {
  const r = await db.execute({
    sql: `SELECT complex_key FROM apt_pyeong_groups WHERE complex_id = ? LIMIT 1`,
    args: [complexId],
  });
  if (r.rows.length > 0 && r.rows[0]!.complex_key != null) return String(r.rows[0]!.complex_key);
  return null;
}

async function auditComplexArea(
  db: ReturnType<typeof createClient>,
  master: MasterRow,
  withDetail: boolean,
): Promise<ComplexAreaAudit> {
  const cid = master.complex_id;
  const txRes = await db.execute({
    sql: `
      SELECT exclusive_area AS ea, COUNT(*) AS cnt, MAX(year_month) AS latest
      FROM transactions
      WHERE apt_name_norm = ?
        AND lawd_cd = ?
        AND exclusive_area IS NOT NULL
        AND exclusive_area > 0
      GROUP BY exclusive_area
      ORDER BY exclusive_area
    `,
    args: [master.apt_name_norm, master.lawd_cd],
  });

  const complexKey = await resolveComplexKey(db, cid);
  const units: { key: string; min: number; max: number }[] = [];
  const groupByUnit = new Map<string, string>();
  const groups = new Set<string>();

  if (complexKey) {
    const unitRes = await db.execute({
      sql: `SELECT unit_type_key, exclusive_area_min, exclusive_area_max FROM apt_unit_types WHERE complex_key = ?`,
      args: [complexKey],
    });
    for (const r of unitRes.rows) {
      units.push({
        key: String(r.unit_type_key),
        min: Number(r.exclusive_area_min),
        max: Number(r.exclusive_area_max),
      });
    }
    const linkRes = await db.execute({
      sql: `SELECT unit_type_key, group_key FROM apt_unit_type_group_links WHERE complex_key = ?`,
      args: [complexKey],
    });
    for (const r of linkRes.rows) {
      groupByUnit.set(String(r.unit_type_key), String(r.group_key));
      groups.add(String(r.group_key));
    }
  }

  const areas: AreaRow[] = [];
  let linkedCount = 0;
  const unlinkedAreas: number[] = [];
  for (const r of txRes.rows) {
    const ea = Number(r.ea);
    const ut = matchUnitForArea(ea, units);
    const gid = ut ? groupByUnit.get(ut) ?? null : null;
    if (gid) linkedCount += 1;
    else unlinkedAreas.push(ea);
    areas.push({
      exclusive_area: ea,
      tx_count: Number(r.cnt),
      recent_tx: Number(r.latest) >= 202401,
      has_unit_type: Boolean(ut),
      unit_type_id: ut,
      group_id: gid,
      approx_pyeong: Math.round((ea / 3.305785) * 100) / 100,
    });
  }

  const summary: ComplexAreaAudit = {
    complexId: cid,
    complexName: master.apt_name,
    rawAreaCount: areas.length,
    unitTypeCount: units.length,
    groupCount: groups.size,
    linkedCount,
    unlinkedCount: unlinkedAreas.length,
    status: classifyAreaStatus({
      rawAreaCount: areas.length,
      unitTypeCount: units.length,
      linkedCount,
      groupCount: groups.size,
    }),
  };
  if (withDetail) {
    summary.areas = areas;
    summary.unlinkedAreas = unlinkedAreas;
  }
  return summary;
}

async function getHousehold(db: ReturnType<typeof createClient>, complexId: string): Promise<number | null> {
  const r = await db.execute({
    sql: `SELECT household_count FROM apt_complex_profile WHERE complex_id = ?`,
    args: [complexId],
  });
  if (r.rows.length === 0) return null;
  return num(r.rows[0]!.household_count);
}

async function writeHousehold(
  db: ReturnType<typeof createClient>,
  complexId: string,
  household: number,
  meta: Json,
): Promise<"inserted" | "updated" | "skipped"> {
  const existing = await db.execute({
    sql: `SELECT household_count FROM apt_complex_profile WHERE complex_id = ?`,
    args: [complexId],
  });
  const now = new Date().toISOString();
  const metaJson = JSON.stringify(meta);

  if (existing.rows.length === 0) {
    if (!APPLY) return "skipped";
    await db.execute({
      sql: `
        INSERT INTO apt_complex_profile (complex_id, household_count, source, source_version, raw_meta_json, updated_at)
        VALUES (?, ?, 'kapt_basis_v5', 'stage1-household-area', ?, ?)
      `,
      args: [complexId, household, metaJson, now],
    });
    return "inserted";
  }

  const cur = num(existing.rows[0]!.household_count);
  if (cur != null) return "skipped";
  if (!APPLY) return "skipped";
  await db.execute({
    sql: `
      UPDATE apt_complex_profile
      SET household_count = ?, source = 'kapt_basis_v5', source_version = 'stage1-household-area',
          raw_meta_json = ?, updated_at = ?
      WHERE complex_id = ? AND household_count IS NULL
    `,
    args: [household, metaJson, now, complexId],
  });
  return "updated";
}

async function loadRepMasters(db: ReturnType<typeof createClient>): Promise<MasterRow[]> {
  const r = await db.execute(`
    SELECT complex_id, apt_name, apt_name_norm, sido, sigungu, lawd_cd,
           legal_dong_name, bjdong_cd, jibun
    FROM apt_complex_master
    WHERE sido = '서울특별시'
      AND (
        (apt_name = '리센츠' AND lawd_cd = '11710' AND jibun = '22')
        OR (apt_name = '트리지움' AND lawd_cd = '11710' AND jibun = '35')
      )
  `);
  return r.rows.map((row) => ({
    complex_id: String(row.complex_id),
    apt_name: String(row.apt_name),
    apt_name_norm: String(row.apt_name_norm),
    sido: row.sido != null ? String(row.sido) : null,
    sigungu: row.sigungu != null ? String(row.sigungu) : null,
    lawd_cd: row.lawd_cd != null ? String(row.lawd_cd) : null,
    legal_dong_name: row.legal_dong_name != null ? String(row.legal_dong_name) : null,
    bjdong_cd: row.bjdong_cd != null ? String(row.bjdong_cd) : null,
    jibun: row.jibun != null ? String(row.jibun) : null,
  }));
}

async function loadSeoulMissingBatch(db: ReturnType<typeof createClient>, limit: number): Promise<MasterRow[]> {
  const r = await db.execute({
    sql: `
      SELECT m.complex_id, m.apt_name, m.apt_name_norm, m.sido, m.sigungu, m.lawd_cd,
             m.legal_dong_name, m.bjdong_cd, m.jibun
      FROM apt_complex_master m
      LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
      WHERE m.sido = '서울특별시'
        AND (p.household_count IS NULL)
        AND m.jibun IS NOT NULL AND TRIM(m.jibun) != ''
        AND m.bjdong_cd IS NOT NULL AND LENGTH(m.bjdong_cd) >= 5
        AND m.lawd_cd IS NOT NULL AND LENGTH(m.lawd_cd) >= 5
        AND m.complex_id NOT IN (
          SELECT complex_id FROM apt_complex_master
          WHERE (apt_name = '리센츠' AND lawd_cd = '11710' AND jibun = '22')
             OR (apt_name = '트리지움' AND lawd_cd = '11710' AND jibun = '35')
        )
      ORDER BY m.sigungu, m.apt_name
      LIMIT ?
    `,
    args: [limit],
  });
  return r.rows.map((row) => ({
    complex_id: String(row.complex_id),
    apt_name: String(row.apt_name),
    apt_name_norm: String(row.apt_name_norm),
    sido: row.sido != null ? String(row.sido) : null,
    sigungu: row.sigungu != null ? String(row.sigungu) : null,
    lawd_cd: row.lawd_cd != null ? String(row.lawd_cd) : null,
    legal_dong_name: row.legal_dong_name != null ? String(row.legal_dong_name) : null,
    bjdong_cd: row.bjdong_cd != null ? String(row.bjdong_cd) : null,
    jibun: row.jibun != null ? String(row.jibun) : null,
  }));
}

async function seoulCoverage(db: ReturnType<typeof createClient>) {
  const total = await db.execute(`SELECT COUNT(*) AS c FROM apt_complex_master WHERE sido='서울특별시'`);
  const withHh = await db.execute(`
    SELECT COUNT(*) AS c FROM apt_complex_master m
    JOIN apt_complex_profile p ON p.complex_id = m.complex_id
    WHERE m.sido='서울특별시' AND p.household_count IS NOT NULL AND p.household_count > 0
  `);
  const missing = await db.execute(`
    SELECT COUNT(*) AS c FROM apt_complex_master m
    LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
    WHERE m.sido='서울특별시' AND (p.complex_id IS NULL OR p.household_count IS NULL)
  `);
  const identityReady = await db.execute(`
    SELECT COUNT(*) AS c FROM apt_complex_master m
    LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
    WHERE m.sido='서울특별시'
      AND (p.complex_id IS NULL OR p.household_count IS NULL)
      AND m.jibun IS NOT NULL AND TRIM(m.jibun) != ''
      AND m.bjdong_cd IS NOT NULL AND LENGTH(m.bjdong_cd) >= 5
      AND m.lawd_cd IS NOT NULL
  `);
  return {
    total: Number(total.rows[0]!.c),
    withHousehold: Number(withHh.rows[0]!.c),
    missing: Number(missing.rows[0]!.c),
    identityReadyMissing: Number(identityReady.rows[0]!.c),
  };
}

async function seoulAreaReadiness(
  db: ReturnType<typeof createClient>,
): Promise<{
  complexesChecked: number;
  byStatus: Record<string, number>;
  totals: { rawDistinctAreas: number; unitTypes: number; groupLinked: number; unlinked: number };
  summaries: ComplexAreaAudit[];
}> {
  const masters = await db.execute(`
    SELECT complex_id, apt_name, apt_name_norm, sido, sigungu, lawd_cd,
           legal_dong_name, bjdong_cd, jibun
    FROM apt_complex_master WHERE sido='서울특별시'
  `);

  const txAreas = await db.execute(`
    SELECT apt_name_norm, lawd_cd, exclusive_area AS ea, COUNT(*) AS cnt
    FROM transactions
    WHERE exclusive_area IS NOT NULL AND exclusive_area > 0
      AND lawd_cd LIKE '11%'
    GROUP BY apt_name_norm, lawd_cd, exclusive_area
  `);
  const txMap = new Map<string, Map<number, number>>();
  for (const r of txAreas.rows) {
    const k = `${String(r.apt_name_norm)}|${String(r.lawd_cd)}`;
    if (!txMap.has(k)) txMap.set(k, new Map());
    txMap.get(k)!.set(Number(r.ea), Number(r.cnt));
  }

  // complex_id -> complex_key via existing pyeong groups (pilot mapping)
  const idToKey = new Map<string, string>();
  const keyMapRes = await db.execute(`
    SELECT DISTINCT complex_id, complex_key FROM apt_pyeong_groups WHERE complex_id IS NOT NULL
  `);
  for (const r of keyMapRes.rows) {
    idToKey.set(String(r.complex_id), String(r.complex_key));
  }

  type UnitRec = { key: string; min: number; max: number };
  const unitsByKey = new Map<string, UnitRec[]>();
  const units = await db.execute(
    `SELECT complex_key, unit_type_key, exclusive_area_min, exclusive_area_max FROM apt_unit_types`,
  );
  for (const r of units.rows) {
    const ck = String(r.complex_key);
    if (!unitsByKey.has(ck)) unitsByKey.set(ck, []);
    unitsByKey.get(ck)!.push({
      key: String(r.unit_type_key),
      min: Number(r.exclusive_area_min),
      max: Number(r.exclusive_area_max),
    });
  }

  const linksByKey = new Map<string, Map<string, string>>();
  const groupsByKey = new Map<string, Set<string>>();
  const links = await db.execute(
    `SELECT complex_key, unit_type_key, group_key FROM apt_unit_type_group_links`,
  );
  for (const r of links.rows) {
    const ck = String(r.complex_key);
    if (!linksByKey.has(ck)) linksByKey.set(ck, new Map());
    linksByKey.get(ck)!.set(String(r.unit_type_key), String(r.group_key));
    if (!groupsByKey.has(ck)) groupsByKey.set(ck, new Set());
    groupsByKey.get(ck)!.add(String(r.group_key));
  }

  const byStatus: Record<string, number> = {
    AREA_READY: 0,
    PARTIAL_UNIT_MASTER: 0,
    GROUP_LINK_MISSING: 0,
    RAW_AREA_ONLY: 0,
    AMBIGUOUS: 0,
  };
  let rawDistinctAreas = 0;
  let unitTypesTotal = 0;
  let groupLinked = 0;
  let unlinked = 0;
  const summaries: ComplexAreaAudit[] = [];

  for (const row of masters.rows) {
    const m: MasterRow = {
      complex_id: String(row.complex_id),
      apt_name: String(row.apt_name),
      apt_name_norm: String(row.apt_name_norm),
      sido: row.sido != null ? String(row.sido) : null,
      sigungu: row.sigungu != null ? String(row.sigungu) : null,
      lawd_cd: row.lawd_cd != null ? String(row.lawd_cd) : null,
      legal_dong_name: row.legal_dong_name != null ? String(row.legal_dong_name) : null,
      bjdong_cd: row.bjdong_cd != null ? String(row.bjdong_cd) : null,
      jibun: row.jibun != null ? String(row.jibun) : null,
    };
    const k = `${m.apt_name_norm}|${m.lawd_cd}`;
    const areaMap = txMap.get(k) ?? new Map();
    const ck = idToKey.get(m.complex_id) ?? null;
    const unitList = ck ? unitsByKey.get(ck) ?? [] : [];
    const lMap = ck ? linksByKey.get(ck) ?? new Map() : new Map();
    const gSet = ck ? groupsByKey.get(ck) ?? new Set() : new Set();

    let linkedCount = 0;
    let unlinkedCount = 0;
    for (const ea of areaMap.keys()) {
      const ut = matchUnitForArea(ea, unitList);
      if (ut && lMap.has(ut)) linkedCount += 1;
      else unlinkedCount += 1;
    }

    const status = classifyAreaStatus({
      rawAreaCount: areaMap.size,
      unitTypeCount: unitList.length,
      linkedCount,
      groupCount: gSet.size,
    });
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    rawDistinctAreas += areaMap.size;
    unitTypesTotal += unitList.length;
    groupLinked += linkedCount;
    unlinked += unlinkedCount;

    summaries.push({
      complexId: m.complex_id,
      complexName: m.apt_name,
      rawAreaCount: areaMap.size,
      unitTypeCount: unitList.length,
      groupCount: gSet.size,
      linkedCount,
      unlinkedCount,
      status,
    });
  }

  return {
    complexesChecked: masters.rows.length,
    byStatus,
    totals: { rawDistinctAreas, unitTypes: unitTypesTotal, groupLinked, unlinked },
    summaries,
  };
}

async function main() {
  mustEnv();
  mkdirSync(OUT_DIR, { recursive: true });
  const db = createClient({ url: DB_URL!, authToken: DB_TOKEN! });
  const listCache = new Map<string, KaptListItem[]>();
  let externalCalls = 0;

  console.log(`MODE=${APPLY ? "APPLY" : "DRY-RUN"} BATCH=${BATCH}`);

  const covBefore = await seoulCoverage(db);
  console.log("Seoul household coverage before:", covBefore);

  const reps = await loadRepMasters(db);
  if (reps.length !== 2) {
    console.warn("Expected 2 representative masters, got", reps.length, reps.map((r) => r.apt_name));
  }

  const repReports: Json[] = [];
  for (const m of reps) {
    console.log(`\n=== REP ${m.apt_name} ${m.complex_id} ===`);
    const before = await getHousehold(db, m.complex_id);
    const match = await matchMasterToKapt(m, listCache);
    externalCalls += 1 + (match.status === "matched" ? 1 : 5);
    console.log("match:", match);

    let after = before;
    let writeOp: string = "none";
    let official: number | null = null;

    if (match.status === "matched" && match.bass.kaptdaCnt != null && match.bass.kaptdaCnt > 0) {
      official = match.bass.kaptdaCnt;
      if (before == null) {
        writeOp = await writeHousehold(db, m.complex_id, official, {
          stage: "stage1-rep",
          kaptCode: match.kaptCode,
          evidence: match.evidence,
          kaptAddr: match.bass.kaptAddr,
          kaptName: match.bass.kaptName,
        });
        after = APPLY ? official : before;
        if (APPLY) after = await getHousehold(db, m.complex_id);
      } else {
        writeOp = "skipped_non_null";
      }
    }

    const area = await auditComplexArea(db, m, true);
    repReports.push({
      complex_id: m.complex_id,
      apt_name: m.apt_name,
      lawd_cd: m.lawd_cd,
      jibun: m.jibun,
      bjdong_cd: m.bjdong_cd,
      household_before: before,
      official_household: official,
      household_after: after,
      write_op: writeOp,
      match,
      area,
    });
    console.log("area status:", area.status, "raw:", area.rawAreaCount, "units:", area.unitTypeCount, "groups:", area.groupCount);
  }

  const batch = await loadSeoulMissingBatch(db, BATCH);
  console.log(`\nSeoul batch size=${batch.length}`);
  const batchStats = {
    attempted: batch.length,
    matched: 0,
    ambiguous: 0,
    unresolved: 0,
    updated: 0,
    inserted: 0,
    skipped: 0,
    details: [] as Json[],
  };

  for (const m of batch) {
    const match = await matchMasterToKapt(m, listCache);
    externalCalls += 2;
    if (match.status === "ambiguous") {
      batchStats.ambiguous += 1;
      batchStats.details.push({ complex_id: m.complex_id, apt_name: m.apt_name, status: "ambiguous", evidence: match.evidence });
      continue;
    }
    if (match.status === "unresolved") {
      batchStats.unresolved += 1;
      batchStats.details.push({ complex_id: m.complex_id, apt_name: m.apt_name, status: "unresolved", evidence: match.evidence });
      continue;
    }
    batchStats.matched += 1;
    const hh = match.bass.kaptdaCnt;
    if (hh == null || hh <= 0) {
      batchStats.unresolved += 1;
      batchStats.details.push({ complex_id: m.complex_id, apt_name: m.apt_name, status: "no_kaptdaCnt", kaptCode: match.kaptCode });
      continue;
    }
    const op = await writeHousehold(db, m.complex_id, hh, {
      stage: "stage1-batch",
      kaptCode: match.kaptCode,
      evidence: match.evidence,
      kaptAddr: match.bass.kaptAddr,
      kaptName: match.bass.kaptName,
    });
    if (op === "inserted") batchStats.inserted += 1;
    else if (op === "updated") batchStats.updated += 1;
    else batchStats.skipped += 1;
    if (batchStats.matched % 25 === 0) {
      console.log(`  progress matched=${batchStats.matched} inserted=${batchStats.inserted} unresolved=${batchStats.unresolved}`);
    }
  }

  const covAfter = await seoulCoverage(db);
  console.log("\nSeoul household coverage after:", covAfter);

  console.log("\nComputing Seoul area readiness (read-only)...");
  const areaReady = await seoulAreaReadiness(db);

  const householdArtifact = {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? "apply" : "dry-run",
    schemaNote:
      "household_count lives on apt_complex_profile (not apt_complex_master). Writes create/update profile rows for NULL household only.",
    coverageBefore: covBefore,
    coverageAfter: covAfter,
    representatives: repReports,
    batch: {
      ...batchStats,
      details: batchStats.details.slice(0, 200),
    },
    externalCallsEstimate: externalCalls,
  };

  const areaArtifact = {
    generatedAt: new Date().toISOString(),
    note: "Read-only audit. No apt_unit_types / group link / pyeong group writes.",
    groupingPrinciple:
      "RAW unit types preserved; similar-area group is derived convenience layer only. No auto-group this run.",
    representatives: Object.fromEntries(
      repReports.map((r) => [String((r as Json).apt_name), (r as Json).area]),
    ),
    seoul: {
      complexesChecked: areaReady.complexesChecked,
      byStatus: areaReady.byStatus,
      totals: areaReady.totals,
    },
    summaries: areaReady.summaries,
  };

  writeFileSync(join(OUT_DIR, "household-enrichment-report.json"), JSON.stringify(householdArtifact, null, 2));
  writeFileSync(join(OUT_DIR, "area-readiness-seoul.json"), JSON.stringify(areaArtifact, null, 2));

  const compact = {
    ...areaArtifact,
    summaries: areaReady.summaries.filter((s) => s.rawAreaCount > 0 || s.unitTypeCount > 0),
  };
  writeFileSync(join(OUT_DIR, "area-readiness-seoul-nonzero.json"), JSON.stringify(compact, null, 2));

  console.log("\nWrote artifacts to", OUT_DIR);
  console.log("STATUS_COUNTS", areaReady.byStatus);
  console.log("BATCH", {
    matched: batchStats.matched,
    ambiguous: batchStats.ambiguous,
    unresolved: batchStats.unresolved,
    inserted: batchStats.inserted,
    updated: batchStats.updated,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
