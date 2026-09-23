/**
 * National building + unit/area missing-only closeout runner.
 *
 * BUILDING/UNIT-owned writes only. Never writes apt_complex_profile,
 * apt_canonical_unit_types, transactions, AC, ranking, or price tables.
 *
 * Ops:
 * - WAVE1 local: project unit_type_stats; deterministic type↔building links from OUAC
 * - WAVE2: existing title pipeline for missing-building parcels (cache-first)
 *
 * Detached usage:
 *   npx tsx scripts/building-topology/national-closeout-runner.mts --daemon --apply
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import {
  hubPnu,
  parcelFromHubPnu,
  parcelFromParts,
  parcelKey,
  priorityForSido,
  sidoBucket,
} from "@/lib/buildings/parcel";
import { fetchTitleParcel } from "@/lib/buildings/title-client";
import { buildingFromTitleRow } from "@/lib/buildings/from-title";
import { isMainBuilding } from "@/lib/buildings/residential";
import {
  buildTypeBuildingLinks,
  type CanonicalType,
  type OfficialUnit,
} from "@/lib/buildings/type-links";
import {
  upsertBuildings,
  upsertCheckpoint,
  upsertTypeBuildingLinks,
  type UpsertStats,
} from "@/lib/buildings/repository";

const OUT = join(process.cwd(), "data/poc/building-topology/national-closeout");
const LOCK = join(OUT, "run.lock");
const CHECKPOINT = join(OUT, "checkpoint.json");
const HEARTBEAT = join(OUT, "heartbeat.json");
const PROGRESS = join(OUT, "progress.json");
const MANIFEST = join(OUT, "missing_inventory.json");
const FAILED = join(OUT, "failed_targets.jsonl");
const LOG = join(OUT, "runner.log");
const COVERAGE_BEFORE = join(OUT, "coverage-before.json");
const COVERAGE_NOW = join(OUT, "coverage-now.json");

const APPLY = process.argv.includes("--apply");
const DAEMON = process.argv.includes("--daemon");
const MANIFEST_ONLY = process.argv.includes("--manifest-only");
const BATCH = Math.max(1, Number(process.argv.find((a) => a.startsWith("--batch="))?.slice(8) ?? "40"));
const MAX_API = Math.max(0, Number(process.argv.find((a) => a.startsWith("--max-api="))?.slice(10) ?? "3000"));
const WAVE = (process.argv.find((a) => a.startsWith("--wave="))?.slice(7) ?? "all").toLowerCase();

export type TargetStatus =
  | "READY_LOCAL"
  | "READY_TITLE"
  | "COMPLETE"
  | "NO_SOURCE"
  | "AMBIGUOUS"
  | "IDENTITY_GAP"
  | "SUPPLY_AREA_UNAVAILABLE"
  | "FAILED_RETRYABLE";

export type CloseoutTarget = {
  complexId: string;
  region: string;
  priority: number;
  buildingStatus: TargetStatus;
  unitStatus: TargetStatus;
  areaStatus: TargetStatus;
  linkStatus: TargetStatus;
  sourceAvailability: {
    titleCheckpoint: string | null;
    hasResidentialBuilding: boolean;
    hasCanonicalType: boolean;
    hasExclusive: boolean;
    hasSupply: boolean;
    hasOuacDongHo: boolean;
    hasExactLink: boolean;
    hasUnitTypeStats: boolean;
  };
  requiredOperation: string;
  terminalReason: string | null;
};

type Checkpoint = {
  version: string;
  startedAt: string;
  updatedAt: string;
  cursor: number;
  wave: string;
  apiCalls: number;
  processed: number;
  inserted: number;
  updated: number;
  conflicts: number;
  failures: number;
  holds: number;
  completed: boolean;
  pid: number;
};

type Progress = Checkpoint & {
  firstBatchApplied: boolean;
  lastComplexId: string | null;
  coverage: Record<string, unknown> | null;
};

function log(line: string) {
  mkdirSync(OUT, { recursive: true });
  const row = `[${new Date().toISOString()}] ${line}`;
  appendFileSync(LOG, row + "\n");
  console.error(row);
}

function writeJson(path: string, value: unknown) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function acquireLock(): boolean {
  mkdirSync(OUT, { recursive: true });
  if (existsSync(LOCK)) {
    try {
      const prev = JSON.parse(readFileSync(LOCK, "utf8")) as { pid?: number };
      if (prev.pid && existsSync(`/proc/${prev.pid}`)) {
        log(`lock held by pid=${prev.pid}`);
        return false;
      }
      log(`stale lock pid=${prev.pid ?? "?"} — reclaiming`);
    } catch {
      log("corrupt lock — reclaiming");
    }
  }
  const fd = openSync(LOCK, "w");
  try {
    writeFileSync(
      LOCK,
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          argv: process.argv.slice(2),
          apply: APPLY,
        },
        null,
        2,
      ),
    );
  } finally {
    closeSync(fd);
  }
  return true;
}

function releaseLock() {
  try {
    if (existsSync(LOCK)) {
      const prev = JSON.parse(readFileSync(LOCK, "utf8")) as { pid?: number };
      if (prev.pid === process.pid) unlinkSync(LOCK);
    }
  } catch {
    /* ignore */
  }
}

function heartbeat(extra: Record<string, unknown> = {}) {
  writeJson(HEARTBEAT, {
    pid: process.pid,
    at: new Date().toISOString(),
    ...extra,
  });
}

function emptyUpsert(): UpsertStats {
  return { inserted: 0, unchanged: 0, skippedPositive: 0, updatedFill: 0 };
}

function regionOf(sido: string | null, sidoCode: string | null): string {
  const bucket = sidoBucket(sido, sidoCode);
  if (bucket === "SEOUL" || bucket === "GYEONGGI") return bucket;
  const code = (sidoCode ?? "").trim();
  const map: Record<string, string> = {
    "28": "INCHEON",
    "26": "BUSAN",
    "27": "DAEGU",
    "30": "DAEJEON",
    "29": "GWANGJU",
    "31": "ULSAN",
    "36": "SEJONG",
    "51": "GANGWON",
    "42": "GANGWON",
    "43": "CHUNGBUK",
    "44": "CHUNGNAM",
    "45": "JEONBUK",
    "52": "JEONBUK",
    "46": "JEONNAM",
    "47": "GYEONGBUK",
    "48": "GYEONGNAM",
    "50": "JEJU",
  };
  return map[code] ?? (code || "OTHER");
}

export async function computeCoverage(db: Client) {
  const total = Number(
    (await db.execute(`SELECT COUNT(*) n FROM apt_complex_master`)).rows[0]?.n ?? 0,
  );
  const byRegion = await db.execute(`
    SELECT
      CASE
        WHEN sido_code='11' OR sido LIKE '서울%' THEN 'SEOUL'
        WHEN sido_code='41' OR sido LIKE '경기%' THEN 'GYEONGGI'
        WHEN sido_code='28' OR sido LIKE '인천%' THEN 'INCHEON'
        WHEN sido_code='26' OR sido LIKE '부산%' THEN 'BUSAN'
        WHEN sido_code='27' OR sido LIKE '대구%' THEN 'DAEGU'
        WHEN sido_code='30' OR sido LIKE '대전%' THEN 'DAEJEON'
        WHEN sido_code='29' OR sido LIKE '광주%' THEN 'GWANGJU'
        WHEN sido_code='31' OR sido LIKE '울산%' THEN 'ULSAN'
        WHEN sido_code='36' OR sido LIKE '세종%' THEN 'SEJONG'
        WHEN sido_code IN ('42','51') OR sido LIKE '강원%' THEN 'GANGWON'
        WHEN sido_code='43' OR sido LIKE '충북%' OR sido LIKE '충청북%' THEN 'CHUNGBUK'
        WHEN sido_code='44' OR sido LIKE '충남%' OR sido LIKE '충청남%' THEN 'CHUNGNAM'
        WHEN sido_code IN ('45','52') OR sido LIKE '전북%' OR sido LIKE '전라북%' THEN 'JEONBUK'
        WHEN sido_code='46' OR sido LIKE '전남%' OR sido LIKE '전라남%' THEN 'JEONNAM'
        WHEN sido_code='47' OR sido LIKE '경북%' OR sido LIKE '경상북%' THEN 'GYEONGBUK'
        WHEN sido_code='48' OR sido LIKE '경남%' OR sido LIKE '경상남%' THEN 'GYEONGNAM'
        WHEN sido_code='50' OR sido LIKE '제주%' THEN 'JEJU'
        ELSE COALESCE(NULLIF(sido_code,''),'OTHER')
      END region,
      COUNT(*) total,
      SUM(CASE WHEN EXISTS (
            SELECT 1 FROM complex_buildings b
            WHERE b.complex_id=m.complex_id AND b.residential_flag=1 AND b.status='EXACT'
          ) THEN 1 ELSE 0 END) building,
      SUM(CASE WHEN EXISTS (
            SELECT 1 FROM apt_canonical_unit_types t WHERE t.complex_id=m.complex_id
          ) THEN 1 ELSE 0 END) unit_type,
      SUM(CASE WHEN EXISTS (
            SELECT 1 FROM apt_canonical_unit_types t
            WHERE t.complex_id=m.complex_id AND t.exclusive_cents IS NOT NULL AND t.exclusive_cents>0
          ) THEN 1 ELSE 0 END) exclusive_area,
      SUM(CASE WHEN EXISTS (
            SELECT 1 FROM apt_canonical_unit_types t
            WHERE t.complex_id=m.complex_id AND t.supply_cents IS NOT NULL AND t.supply_cents>0
          ) THEN 1 ELSE 0 END) supply_area,
      SUM(CASE WHEN EXISTS (
            SELECT 1 FROM unit_type_building_links l
            WHERE l.complex_id=m.complex_id AND l.status='EXACT'
          ) THEN 1 ELSE 0 END) type_building
    FROM apt_complex_master m
    GROUP BY 1`);
  const inv = await db.execute(`
    SELECT COUNT(DISTINCT complex_id) complexes,
           SUM(CASE WHEN residential_flag=1 AND status='EXACT' THEN 1 ELSE 0 END) residential,
           SUM(CASE WHEN residential_flag=1 AND status='EXACT'
                     AND dong_label IS NOT NULL AND TRIM(dong_label)!='' THEN 1 ELSE 0 END) dong,
           SUM(CASE WHEN residential_flag=1 AND height_status='OFFICIAL_HEIGHT' THEN 1 ELSE 0 END) height_official,
           SUM(CASE WHEN residential_flag=1 AND height_status='FLOOR_COUNT_ONLY' THEN 1 ELSE 0 END) floor_only,
           SUM(CASE WHEN residential_flag=1 AND height_status='HEIGHT_MISSING' THEN 1 ELSE 0 END) height_missing
    FROM complex_buildings`);
  const links = await db.execute(`
    SELECT COUNT(*) links, COUNT(DISTINCT complex_id) complexes
    FROM unit_type_building_links WHERE status='EXACT'`);
  const national = {
    total,
    building: Number((await db.execute(`
      SELECT COUNT(DISTINCT complex_id) n FROM complex_buildings
      WHERE residential_flag=1 AND status='EXACT'`)).rows[0]?.n ?? 0),
    buildingAny: Number((await db.execute(`
      SELECT COUNT(DISTINCT complex_id) n FROM complex_buildings`)).rows[0]?.n ?? 0),
    unit: Number((await db.execute(`
      SELECT COUNT(DISTINCT complex_id) n FROM apt_canonical_unit_types`)).rows[0]?.n ?? 0),
    exclusive: Number((await db.execute(`
      SELECT COUNT(DISTINCT complex_id) n FROM apt_canonical_unit_types
      WHERE exclusive_cents IS NOT NULL AND exclusive_cents>0`)).rows[0]?.n ?? 0),
    supply: Number((await db.execute(`
      SELECT COUNT(DISTINCT complex_id) n FROM apt_canonical_unit_types
      WHERE supply_cents IS NOT NULL AND supply_cents>0`)).rows[0]?.n ?? 0),
    typeBuilding: Number((await db.execute(`
      SELECT COUNT(DISTINCT complex_id) n FROM unit_type_building_links WHERE status='EXACT'`)).rows[0]?.n ?? 0),
    areaSelectorReady: Number((await db.execute(`
      SELECT COUNT(DISTINCT complex_id) n FROM apt_canonical_unit_types
      WHERE exclusive_cents IS NOT NULL AND exclusive_cents>0`)).rows[0]?.n ?? 0),
    supplyPyeongReady: Number((await db.execute(`
      SELECT COUNT(DISTINCT complex_id) n FROM apt_canonical_unit_types
      WHERE supply_cents IS NOT NULL AND supply_cents>0`)).rows[0]?.n ?? 0),
  };
  return {
    at: new Date().toISOString(),
    national,
    inventory: inv.rows[0],
    links: links.rows[0],
    byRegion: byRegion.rows,
  };
}

export async function buildManifest(db: Client): Promise<CloseoutTarget[]> {
  const masters = await db.execute(`
    SELECT m.complex_id, m.sido, m.sido_code, m.lawd_cd, m.bjdong_cd, m.jibun,
           c.title_status, c.building_status, c.link_status, c.residential_count, c.pnu, c.parcel_key
    FROM apt_complex_master m
    LEFT JOIN complex_building_checkpoint c ON c.complex_id=m.complex_id
  `);
  const hasBld = new Set<string>();
  {
    let offset = 0;
    for (;;) {
      const res = await db.execute({
        sql: `SELECT DISTINCT complex_id FROM complex_buildings
              WHERE residential_flag=1 AND status='EXACT'
              ORDER BY complex_id LIMIT 8000 OFFSET ?`,
        args: [offset],
      });
      if (!res.rows.length) break;
      for (const r of res.rows) hasBld.add(String(r.complex_id));
      offset += res.rows.length;
      if (res.rows.length < 8000) break;
    }
  }
  const hasType = new Set<string>();
  const hasEx = new Set<string>();
  const hasSupply = new Set<string>();
  {
    let offset = 0;
    for (;;) {
      const res = await db.execute({
        sql: `SELECT complex_id, exclusive_cents, supply_cents FROM apt_canonical_unit_types
              ORDER BY unit_type_id LIMIT 10000 OFFSET ?`,
        args: [offset],
      });
      if (!res.rows.length) break;
      for (const r of res.rows) {
        const id = String(r.complex_id);
        hasType.add(id);
        if (r.exclusive_cents != null && Number(r.exclusive_cents) > 0) hasEx.add(id);
        if (r.supply_cents != null && Number(r.supply_cents) > 0) hasSupply.add(id);
      }
      offset += res.rows.length;
      if (res.rows.length < 10000) break;
    }
  }
  const hasLink = new Set<string>();
  {
    let offset = 0;
    for (;;) {
      const res = await db.execute({
        sql: `SELECT DISTINCT complex_id FROM unit_type_building_links WHERE status='EXACT'
              ORDER BY complex_id LIMIT 8000 OFFSET ?`,
        args: [offset],
      });
      if (!res.rows.length) break;
      for (const r of res.rows) hasLink.add(String(r.complex_id));
      offset += res.rows.length;
      if (res.rows.length < 8000) break;
    }
  }
  const hasUts = new Set<string>();
  {
    let offset = 0;
    for (;;) {
      const res = await db.execute({
        sql: `SELECT DISTINCT complex_id FROM unit_type_stats ORDER BY complex_id LIMIT 8000 OFFSET ?`,
        args: [offset],
      });
      if (!res.rows.length) break;
      for (const r of res.rows) hasUts.add(String(r.complex_id));
      offset += res.rows.length;
      if (res.rows.length < 8000) break;
    }
  }
  const hasOuacDongHo = new Set<string>();
  {
    let offset = 0;
    for (;;) {
      const res = await db.execute({
        sql: `SELECT DISTINCT complex_id FROM official_unit_area_cache
              WHERE dong IS NOT NULL AND TRIM(dong)!='' AND ho IS NOT NULL AND TRIM(ho)!=''
              ORDER BY complex_id LIMIT 8000 OFFSET ?`,
        args: [offset],
      });
      if (!res.rows.length) break;
      for (const r of res.rows) hasOuacDongHo.add(String(r.complex_id));
      offset += res.rows.length;
      if (res.rows.length < 8000) break;
    }
  }

  const targets: CloseoutTarget[] = [];
  for (const r of masters.rows) {
    const complexId = String(r.complex_id);
    const region = regionOf(
      r.sido == null ? null : String(r.sido),
      r.sido_code == null ? null : String(r.sido_code),
    );
    const priority = priorityForSido(r.sido_code == null ? null : String(r.sido_code));
    const title = r.title_status == null ? null : String(r.title_status);
    const bld = hasBld.has(complexId);
    const unit = hasType.has(complexId);
    const exclusive = hasEx.has(complexId);
    const supply = hasSupply.has(complexId);
    const link = hasLink.has(complexId);
    const uts = hasUts.has(complexId);
    const ouacDong = hasOuacDongHo.has(complexId);

    let buildingStatus: TargetStatus = bld ? "COMPLETE" : "NO_SOURCE";
    let buildingReason: string | null = bld ? null : "no_exact_residential_building";
    if (!bld) {
      if (title === "NO_PARCEL") {
        buildingStatus = "IDENTITY_GAP";
        buildingReason = "title_NO_PARCEL";
      } else if (title === "EMPTY") {
        // P0 Seoul/Gyeonggi EMPTY with parcel: retry via existing title pipeline (wave2).
        const parcel =
          parcelFromParts(String(r.lawd_cd ?? ""), String(r.bjdong_cd ?? ""), String(r.jibun ?? "")) ||
          (r.pnu ? parcelFromHubPnu(String(r.pnu)) : null);
        if (parcel && (region === "SEOUL" || region === "GYEONGGI")) {
          buildingStatus = "READY_TITLE";
          buildingReason = "title_EMPTY_retry";
        } else {
          buildingStatus = "NO_SOURCE";
          buildingReason = "title_EMPTY";
        }
      } else if (title === "SUCCESS" || title === "SKIP_CACHED") {
        buildingStatus = "NO_SOURCE";
        buildingReason = "title_non_residential_only";
      } else if (
        parcelFromParts(String(r.lawd_cd ?? ""), String(r.bjdong_cd ?? ""), String(r.jibun ?? "")) ||
        (r.pnu ? parcelFromHubPnu(String(r.pnu)) : null)
      ) {
        buildingStatus = "READY_TITLE";
        buildingReason = null;
      }
    }

    const unitStatus: TargetStatus = unit ? "COMPLETE" : "NO_SOURCE";
    let areaStatus: TargetStatus = "NO_SOURCE";
    if (exclusive && supply) areaStatus = "COMPLETE";
    else if (exclusive && !supply) areaStatus = "SUPPLY_AREA_UNAVAILABLE";
    else if (!unit) areaStatus = "NO_SOURCE";

    let linkStatus: TargetStatus = link ? "COMPLETE" : "NO_SOURCE";
    let linkReason: string | null = link ? null : "no_exact_type_building_link";
    let requiredOperation = "NONE";
    if (!uts && unit) {
      requiredOperation = "PROJECT_UNIT_STATS";
      linkStatus = link ? "COMPLETE" : "READY_LOCAL";
    }
    if (!link && bld && unit && ouacDong) {
      linkStatus = "READY_LOCAL";
      linkReason = null;
      requiredOperation =
        requiredOperation === "PROJECT_UNIT_STATS"
          ? "PROJECT_UNIT_STATS+ATTEMPT_LINK"
          : "ATTEMPT_LINK";
    } else if (!link && bld && unit && !ouacDong) {
      linkStatus = "IDENTITY_GAP";
      linkReason = "ouac_missing_dong_ho";
    } else if (!link && (!bld || !unit)) {
      linkStatus = "NO_SOURCE";
      linkReason = !bld ? "building_missing" : "canonical_type_missing";
    }
    if (buildingStatus === "READY_TITLE" && (WAVE === "all" || WAVE === "2" || WAVE === "title")) {
      requiredOperation =
        requiredOperation === "NONE" ? "TITLE_FETCH" : `${requiredOperation}+TITLE_FETCH`;
    }
    if (
      requiredOperation === "NONE" &&
      buildingStatus === "COMPLETE" &&
      unitStatus === "COMPLETE" &&
      (linkStatus === "COMPLETE" || linkStatus === "IDENTITY_GAP" || linkStatus === "NO_SOURCE") &&
      (areaStatus === "COMPLETE" || areaStatus === "SUPPLY_AREA_UNAVAILABLE" || areaStatus === "NO_SOURCE")
    ) {
      // fully classified
    }

    const overallReady =
      requiredOperation !== "NONE" &&
      (requiredOperation.includes("PROJECT") ||
        requiredOperation.includes("ATTEMPT") ||
        requiredOperation.includes("TITLE"));

    targets.push({
      complexId,
      region,
      priority,
      buildingStatus,
      unitStatus,
      areaStatus,
      linkStatus: overallReady && linkStatus === "NO_SOURCE" ? linkStatus : linkStatus,
      sourceAvailability: {
        titleCheckpoint: title,
        hasResidentialBuilding: bld,
        hasCanonicalType: unit,
        hasExclusive: exclusive,
        hasSupply: supply,
        hasOuacDongHo: ouacDong,
        hasExactLink: link,
        hasUnitTypeStats: uts,
      },
      requiredOperation,
      terminalReason: buildingReason ?? linkReason,
    });
  }

  targets.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.complexId.localeCompare(b.complexId);
  });
  return targets;
}

async function projectUnitStats(db: Client): Promise<UpsertStats> {
  const ts = new Date().toISOString();
  const before = Number(
    (await db.execute(`SELECT COUNT(*) n FROM unit_type_stats`)).rows[0]?.n ?? 0,
  );
  if (APPLY) {
    // Mirror all Core types into BUILDING-owned unit_type_stats (missing-only).
    // Do not invent household counts; null stays null.
    await db.execute({
      sql: `INSERT OR IGNORE INTO unit_type_stats (
              complex_id, unit_type_id, household_count, source, source_as_of, status,
              provenance_json, created_at, updated_at
            )
            SELECT complex_id, unit_type_id, household_count,
                   COALESCE(NULLIF(source,''), 'apt_canonical_unit_types'),
                   COALESCE(NULLIF(source_as_of,''), '2026-08'),
                   CASE WHEN status IN ('EXACT_SINGLE', 'EXACT_MULTI_RESOLVABLE', 'AMBIGUOUS_MULTI')
                        THEN 'EXACT' ELSE 'NO_SOURCE' END,
                   '{"closeout":"national-building-unit-v1"}', ?, ?
            FROM apt_canonical_unit_types`,
      args: [ts, ts],
    });
  }
  const after = Number(
    (await db.execute(`SELECT COUNT(*) n FROM unit_type_stats`)).rows[0]?.n ?? 0,
  );
  return {
    inserted: Math.max(0, after - before),
    unchanged: 0,
    skippedPositive: 0,
    updatedFill: 0,
  };
}

async function attemptLink(db: Client, complexId: string): Promise<{
  stats: UpsertStats;
  publicLinks: number;
  resolution: string;
}> {
  const typesRes = await db.execute({
    sql: `SELECT unit_type_id, exclusive_cents, supply_cents, status, household_count
          FROM apt_canonical_unit_types WHERE complex_id=?`,
    args: [complexId],
  });
  const types: CanonicalType[] = typesRes.rows.map((r) => ({
    unitTypeId: String(r.unit_type_id),
    exclusiveCents: Number(r.exclusive_cents),
    supplyCents: Number(r.supply_cents),
    status: String(r.status),
    householdCount: r.household_count == null ? null : Number(r.household_count),
  }));
  const unitRes = await db.execute({
    sql: `SELECT dong, floor, ho, exclusive_area, residential_common_area, source_as_of, source_key,
                 source_building_id
          FROM official_unit_area_cache
          WHERE complex_id=?
            AND dong IS NOT NULL AND TRIM(dong)!=''
            AND ho IS NOT NULL AND TRIM(ho)!=''`,
    args: [complexId],
  });
  const units: OfficialUnit[] = unitRes.rows.map((r) => ({
    dong: String(r.dong ?? ""),
    floor: String(r.floor ?? ""),
    ho: String(r.ho ?? ""),
    exclusiveArea: r.exclusive_area == null ? null : Number(r.exclusive_area),
    residentialCommonArea:
      r.residential_common_area == null ? null : Number(r.residential_common_area),
    officialBuildingKey: r.source_building_id ? String(r.source_building_id) : null,
    sourceAsOf: String(r.source_as_of ?? ""),
    sourceKey: String(r.source_key ?? ""),
  }));
  const bldRes = await db.execute({
    sql: `SELECT building_id, dong_label, residential_flag, official_building_key,
                 physical_household_count
          FROM complex_buildings WHERE complex_id=?`,
    args: [complexId],
  });
  const buildings = bldRes.rows.map((r) => ({
    buildingId: String(r.building_id),
    dongLabel: r.dong_label == null ? null : String(r.dong_label),
    residentialFlag: Number(r.residential_flag) === 1,
    officialBuildingKey: r.official_building_key == null ? null : String(r.official_building_key),
  }));
  const physicalByBuilding = new Map<string, number | null>();
  for (const r of bldRes.rows) {
    physicalByBuilding.set(
      String(r.building_id),
      r.physical_household_count == null ? null : Number(r.physical_household_count),
    );
  }
  const built = buildTypeBuildingLinks({
    units,
    types,
    buildings,
    source: "official_unit_area_cache+title",
  });
  const exact = built.links.filter((l) => l.status === "EXACT");
  // household safety: drop links that would exceed physical cap on that building
  const sumByBld = new Map<string, number>();
  for (const link of exact) {
    sumByBld.set(link.buildingId, (sumByBld.get(link.buildingId) ?? 0) + link.householdCount);
  }
  const safe = exact.filter((link) => {
    const cap = physicalByBuilding.get(link.buildingId);
    if (cap == null) return true;
    return (sumByBld.get(link.buildingId) ?? 0) <= cap;
  });
  let stats = emptyUpsert();
  if (APPLY && safe.length) {
    stats = await upsertTypeBuildingLinks(db, complexId, safe);
    const cp = await db.execute({
      sql: `SELECT * FROM complex_building_checkpoint WHERE complex_id=?`,
      args: [complexId],
    });
    const prev = cp.rows[0];
    await upsertCheckpoint(db, {
      complexId,
      parcelKey: String(prev?.parcel_key ?? ""),
      pnu: String(prev?.pnu ?? ""),
      priority: Number(prev?.priority ?? 9),
      titleStatus: String(prev?.title_status ?? "PENDING"),
      buildingStatus: String(prev?.building_status ?? "NO_SOURCE"),
      geometryStatus: String(prev?.geometry_status ?? "NO_GEOMETRY"),
      linkStatus: safe.length ? "EXACT" : "PARTIAL",
      titleTotalCount: Number(prev?.title_total_count ?? 0),
      residentialCount: Number(prev?.residential_count ?? 0),
      apiCalls: Number(prev?.api_calls ?? 0),
      detail: String(prev?.detail ?? "").slice(0, 200),
    });
  }
  return {
    stats,
    publicLinks: safe.length,
    resolution: safe.length
      ? "EXACT"
      : exact.length
        ? "HELD_SAFETY"
        : units.length
          ? "AMBIGUOUS_OR_NO_PUBLIC"
          : "NO_SOURCE",
  };
}

async function titleFetch(
  db: Client,
  row: {
    complexId: string;
    lawdCd: string;
    bjdongCd: string;
    jibun: string;
    pnu: string | null;
    priority: number;
  },
): Promise<{ stats: UpsertStats; apiCalls: number; status: string }> {
  const parcel =
    parcelFromParts(row.lawdCd, row.bjdongCd, row.jibun) ??
    (row.pnu ? parcelFromHubPnu(row.pnu) : null);
  if (!parcel) {
    if (APPLY) {
      await upsertCheckpoint(db, {
        complexId: row.complexId,
        priority: row.priority,
        titleStatus: "NO_PARCEL",
        buildingStatus: "NO_SOURCE",
        geometryStatus: "NO_GEOMETRY",
        linkStatus: "NO_SOURCE",
        detail: "closeout missing parcel",
      });
    }
    return { stats: emptyUpsert(), apiCalls: 0, status: "NO_PARCEL" };
  }
  const title = await fetchTitleParcel(parcel, { force: true });
  const main = title.items.filter(isMainBuilding);
  const buildings = main
    .map((item) => buildingFromTitleRow(item, row.complexId, title.sourceAsOf))
    .filter((b): b is NonNullable<typeof b> => b != null);
  const unique = new Map<string, (typeof buildings)[number]>();
  for (const b of buildings) {
    if (!unique.has(b.officialBuildingKey)) unique.set(b.officialBuildingKey, b);
  }
  const deduped = [...unique.values()];
  const residential = deduped.filter((b) => b.residentialFlag);
  let stats = emptyUpsert();
  if (APPLY) {
    stats = await upsertBuildings(db, deduped);
    await upsertCheckpoint(db, {
      complexId: row.complexId,
      parcelKey: parcelKey(parcel),
      pnu: hubPnu(parcel),
      priority: row.priority,
      titleStatus: deduped.length ? (title.fromCache ? "SKIP_CACHED" : "SUCCESS") : "EMPTY",
      buildingStatus: residential.length ? "EXACT" : deduped.length ? "PARTIAL" : "NO_SOURCE",
      geometryStatus: "NO_GEOMETRY",
      linkStatus: "NO_SOURCE",
      titleTotalCount: title.totalCount,
      residentialCount: residential.length,
      apiCalls: title.apiCalls,
      detail: `closeout main=${main.length} residential=${residential.length}`,
    });
  }
  return {
    stats,
    apiCalls: title.apiCalls,
    status: residential.length ? "EXACT" : deduped.length ? "PARTIAL" : "EMPTY",
  };
}

async function loadTitleTargets(db: Client, ids: string[]) {
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  const res = await db.execute({
    sql: `SELECT m.complex_id, m.lawd_cd, m.bjdong_cd, m.jibun, m.sido_code, c.pnu
          FROM apt_complex_master m
          LEFT JOIN complex_building_checkpoint c ON c.complex_id=m.complex_id
          WHERE m.complex_id IN (${ph})`,
    args: ids,
  });
  return res.rows.map((r) => ({
    complexId: String(r.complex_id),
    lawdCd: String(r.lawd_cd ?? ""),
    bjdongCd: String(r.bjdong_cd ?? ""),
    jibun: String(r.jibun ?? ""),
    pnu: r.pnu == null ? null : String(r.pnu),
    priority: priorityForSido(r.sido_code == null ? null : String(r.sido_code)),
  }));
}

async function runSafetyChecks(db: Client) {
  const dupLinks = await db.execute(`
    SELECT complex_id, unit_type_id, building_id, COUNT(*) n
    FROM unit_type_building_links GROUP BY 1,2,3 HAVING n>1 LIMIT 5`);
  const orphanLinks = await db.execute(`
    SELECT COUNT(*) n FROM unit_type_building_links l
    WHERE NOT EXISTS (SELECT 1 FROM apt_complex_master m WHERE m.complex_id=l.complex_id)
       OR NOT EXISTS (SELECT 1 FROM complex_buildings b WHERE b.building_id=l.building_id)`);
  const invalidArea = await db.execute(`
    SELECT COUNT(*) n FROM apt_canonical_unit_types
    WHERE (exclusive_cents IS NOT NULL AND exclusive_cents < 0)
       OR (supply_cents IS NOT NULL AND supply_cents < -1)`);
  return {
    duplicateLinks: dupLinks.rows.length,
    orphanLinks: Number(orphanLinks.rows[0]?.n ?? 0),
    invalidAreas: Number(invalidArea.rows[0]?.n ?? 0),
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  if (!acquireLock()) {
    console.log(JSON.stringify({ status: "FAILED_TO_START", reason: "LOCK_HELD" }));
    process.exit(2);
  }
  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    releaseLock();
    process.exit(143);
  });

  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  log(`start apply=${APPLY} daemon=${DAEMON} wave=${WAVE} batch=${BATCH} maxApi=${MAX_API}`);
  heartbeat({ phase: "boot" });

  if (!existsSync(COVERAGE_BEFORE)) {
    const before = await computeCoverage(db);
    writeJson(COVERAGE_BEFORE, before);
  }

  const targets = await buildManifest(db);
  const actionable = targets.filter((t) => t.requiredOperation !== "NONE");
  writeJson(MANIFEST, {
    at: new Date().toISOString(),
    total: targets.length,
    actionable: actionable.length,
    byOperation: actionable.reduce<Record<string, number>>((acc, t) => {
      acc[t.requiredOperation] = (acc[t.requiredOperation] ?? 0) + 1;
      return acc;
    }, {}),
    missing: {
      building: targets.filter((t) => t.buildingStatus !== "COMPLETE").length,
      unit: targets.filter((t) => t.unitStatus !== "COMPLETE").length,
      supplyArea: targets.filter((t) => t.areaStatus !== "COMPLETE").length,
      link: targets.filter((t) => t.linkStatus !== "COMPLETE").length,
    },
    targets: actionable,
  });
  log(`manifest total=${targets.length} actionable=${actionable.length}`);
  heartbeat({ phase: "manifest", actionable: actionable.length });

  if (MANIFEST_ONLY) {
    writeJson(PROGRESS, {
      version: "national-building-unit-closeout-v1",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cursor: 0,
      wave: WAVE,
      apiCalls: 0,
      processed: 0,
      inserted: 0,
      updated: 0,
      conflicts: 0,
      failures: 0,
      holds: 0,
      completed: false,
      pid: process.pid,
      firstBatchApplied: false,
      lastComplexId: null,
      coverage: null,
    } satisfies Progress);
    console.log(JSON.stringify({ status: "MANIFEST_ONLY", actionable: actionable.length, out: OUT }));
    return;
  }

  const progress = readJson<Progress>(PROGRESS, {
    version: "national-building-unit-closeout-v1",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cursor: 0,
    wave: WAVE,
    apiCalls: 0,
    processed: 0,
    inserted: 0,
    updated: 0,
    conflicts: 0,
    failures: 0,
    holds: 0,
    completed: false,
    pid: process.pid,
    firstBatchApplied: false,
    lastComplexId: null,
    coverage: null,
  });
  progress.pid = process.pid;
  progress.updatedAt = new Date().toISOString();
  writeJson(CHECKPOINT, progress);
  writeJson(PROGRESS, progress);

  // WAVE1 global project (idempotent)
  if (WAVE === "all" || WAVE === "1" || WAVE === "local") {
    heartbeat({ phase: "project_unit_stats" });
    const projected = await projectUnitStats(db);
    progress.inserted += projected.inserted;
    progress.processed += 1;
    progress.firstBatchApplied = APPLY ? progress.firstBatchApplied || projected.inserted >= 0 : progress.firstBatchApplied;
    if (APPLY) progress.firstBatchApplied = true;
    progress.updatedAt = new Date().toISOString();
    writeJson(PROGRESS, progress);
    writeJson(CHECKPOINT, progress);
    log(`project_unit_stats inserted=${projected.inserted}`);
  }

  const work = actionable.filter((t) => {
    if (WAVE === "1" || WAVE === "local") {
      return (
        t.requiredOperation.includes("ATTEMPT_LINK") ||
        t.requiredOperation.includes("PROJECT_UNIT_STATS")
      );
    }
    if (WAVE === "2" || WAVE === "title") return t.requiredOperation.includes("TITLE_FETCH");
    return true;
  });

  let cursor = Math.min(progress.cursor, work.length);
  let firstBatchStats = { processed: 0, inserted: 0, updated: 0, conflicts: 0, failures: 0 };

  while (cursor < work.length) {
    if (progress.apiCalls >= MAX_API && (WAVE === "all" || WAVE === "2" || WAVE === "title")) {
      // still allow local ops without API
    }
    const batch = work.slice(cursor, cursor + BATCH);
    let batchInsert = 0;
    let batchUpdate = 0;
    let batchFail = 0;
    let batchConflict = 0;

    const linkIds = batch
      .filter((t) => t.requiredOperation.includes("ATTEMPT_LINK"))
      .map((t) => t.complexId);
    const titleIds = batch
      .filter((t) => t.requiredOperation.includes("TITLE_FETCH"))
      .map((t) => t.complexId);

    for (const id of linkIds) {
      try {
        const result = await attemptLink(db, id);
        batchInsert += result.stats.inserted;
        batchUpdate += result.stats.updatedFill;
        batchConflict += result.stats.skippedPositive;
        if (result.resolution === "AMBIGUOUS_OR_NO_PUBLIC" || result.resolution === "HELD_SAFETY") {
          progress.holds += 1;
        }
        progress.lastComplexId = id;
        appendFileSync(
          join(OUT, "applied.jsonl"),
          JSON.stringify({
            at: new Date().toISOString(),
            op: "ATTEMPT_LINK",
            complexId: id,
            ...result,
          }) + "\n",
        );
      } catch (error) {
        batchFail += 1;
        appendFileSync(
          FAILED,
          JSON.stringify({
            at: new Date().toISOString(),
            complexId: id,
            op: "ATTEMPT_LINK",
            error: error instanceof Error ? error.message : String(error),
          }) + "\n",
        );
      }
    }

    if (titleIds.length && progress.apiCalls < MAX_API && (WAVE === "all" || WAVE === "2" || WAVE === "title")) {
      const titleRows = await loadTitleTargets(db, titleIds);
      for (const row of titleRows) {
        if (progress.apiCalls >= MAX_API) break;
        try {
          const result = await titleFetch(db, row);
          progress.apiCalls += result.apiCalls;
          batchInsert += result.stats.inserted;
          batchUpdate += result.stats.updatedFill;
          progress.lastComplexId = row.complexId;
          appendFileSync(
            join(OUT, "applied.jsonl"),
            JSON.stringify({
              at: new Date().toISOString(),
              op: "TITLE_FETCH",
              complexId: row.complexId,
              ...result,
            }) + "\n",
          );
        } catch (error) {
          batchFail += 1;
          const msg = error instanceof Error ? error.message : String(error);
          appendFileSync(
            FAILED,
            JSON.stringify({
              at: new Date().toISOString(),
              complexId: row.complexId,
              op: "TITLE_FETCH",
              error: msg,
            }) + "\n",
          );
          if (/429|LIMITED_NUMBER|quota/i.test(msg)) {
            log("quota hit — stopping title wave");
            progress.apiCalls = MAX_API;
            break;
          }
        }
      }
    }

    cursor += batch.length;
    progress.cursor = cursor;
    progress.processed += batch.length;
    progress.inserted += batchInsert;
    progress.updated += batchUpdate;
    progress.conflicts += batchConflict;
    progress.failures += batchFail;
    progress.updatedAt = new Date().toISOString();
    if (APPLY) progress.firstBatchApplied = true;
    writeJson(PROGRESS, progress);
    writeJson(CHECKPOINT, progress);
    heartbeat({
      phase: "batch",
      cursor,
      total: work.length,
      inserted: progress.inserted,
      apiCalls: progress.apiCalls,
    });
    log(
      `batch cursor=${cursor}/${work.length} insert=${batchInsert} update=${batchUpdate} fail=${batchFail}`,
    );

    if (firstBatchStats.processed === 0) {
      firstBatchStats = {
        processed: batch.length,
        inserted: batchInsert + (progress.inserted > batchInsert ? progress.inserted - batchInsert : 0),
        updated: batchUpdate,
        conflicts: batchConflict,
        failures: batchFail,
      };
      writeJson(join(OUT, "first-batch.json"), {
        at: new Date().toISOString(),
        ...firstBatchStats,
        unitStatsProjected: true,
      });
    }

    const nowCov = await computeCoverage(db);
    writeJson(COVERAGE_NOW, nowCov);
    progress.coverage = nowCov.national;
    writeJson(PROGRESS, progress);

    if (!DAEMON && cursor >= Math.min(work.length, BATCH)) {
      // foreground start-gate mode: one batch then exit if not daemon
      break;
    }
  }

  if (cursor >= work.length) {
    progress.completed = true;
    progress.updatedAt = new Date().toISOString();
    writeJson(PROGRESS, progress);
    writeJson(CHECKPOINT, progress);
    log("completed all actionable targets");
  }

  const safety = await runSafetyChecks(db);
  writeJson(join(OUT, "safety.json"), safety);
  heartbeat({ phase: progress.completed ? "done" : "paused", cursor, safety });

  console.log(
    JSON.stringify(
      {
        status: progress.completed ? "COMPLETE" : "BACKGROUND_RUNNING",
        apply: APPLY,
        out: OUT,
        progress,
        firstBatch: readJson(join(OUT, "first-batch.json"), null),
        safety,
        lock: existsSync(LOCK),
        heartbeat: existsSync(HEARTBEAT),
        checkpoint: existsSync(CHECKPOINT),
      },
      null,
      2,
    ),
  );
}

const isMain = process.argv[1]?.endsWith("national-closeout-runner.mts");
if (isMain) {
  main().catch((error) => {
    log(`fatal ${error instanceof Error ? error.message : String(error)}`);
    releaseLock();
    process.exit(1);
  });
}
