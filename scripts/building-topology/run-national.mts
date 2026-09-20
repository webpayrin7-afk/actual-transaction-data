import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { ensureBuildingSchema } from "@/lib/buildings/schema";
import {
  cadastralPnu,
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
import { buildTypeBuildingLinks, type CanonicalType, type OfficialUnit } from "@/lib/buildings/type-links";
import { classifyParity } from "@/lib/buildings/parity";
import {
  upsertBuildings,
  upsertCheckpoint,
  upsertParity,
  upsertTypeBuildingLinks,
  type UpsertStats,
} from "@/lib/buildings/repository";

const APPLY = !process.argv.includes("--dry-run");
const PILOTS_ONLY = process.argv.includes("--pilots");
const OUAC_UNITS = process.argv.includes("--ouac-units");
const PHASE = (process.argv.find((a) => a.startsWith("--phase="))?.slice(8) ?? "all").toLowerCase();
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.slice(8) ?? "0");
const MAX_API = Number(process.argv.find((a) => a.startsWith("--max-api="))?.slice(10) ?? "20000");
const PRIORITY_MAX = Number(process.argv.find((a) => a.startsWith("--priority="))?.slice(11) ?? "3");
const CONCURRENCY = Math.max(1, Number(process.argv.find((a) => a.startsWith("--concurrency="))?.slice(14) ?? "2"));
const OUT = join(process.cwd(), "data/poc/building-topology");

const PILOT_IDS = [
  "cx_4c63d9a100973c60", // 잠실엘스
  "cx_ed52bf895d064c11", // 파크리오
  "cx_caf229b5ac63cfbd", // 리센츠
  "cx_30d7eea6da810b52", // 헬리오시티 서울
  "cx_1c244e7305d12c44", // 반포자이
  "cx_3bcf0f87bce7496b", // 래미안퍼스티지
  "cx_0320fd9e007e1f8c", // 은마
  "cx_c9ed0235ecca960c", // 도곡렉슬
  "cx_07caf64c556e85a7", // 마포프레스티지자이
  "cx_88d05e29df26a0d6", // 포레나노원
];

type Totals = {
  titleApiCalls: number;
  titleCacheHits: number;
  titleErrors: number;
  quota: boolean;
  building: UpsertStats;
  links: UpsertStats;
};

function emptyUpsert(): UpsertStats {
  return { inserted: 0, unchanged: 0, skippedPositive: 0, updatedFill: 0 };
}

function addUpsert(a: UpsertStats, b: UpsertStats): UpsertStats {
  return {
    inserted: a.inserted + b.inserted,
    unchanged: a.unchanged + b.unchanged,
    skippedPositive: a.skippedPositive + b.skippedPositive,
    updatedFill: a.updatedFill + b.updatedFill,
  };
}

function dbClient(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url) throw new Error("TURSO_DATABASE_URL missing");
  return createClient({ url, authToken });
}

async function loadTargets(db: Client) {
  const rows = await db.execute(`
    SELECT m.complex_id, m.apt_name, m.sido, m.sido_code, m.lawd_cd, m.bjdong_cd, m.jibun,
           k.source_key AS kapt_code,
           p.household_count AS kapt_household,
           o.pnu AS ouac_pnu
    FROM apt_complex_master m
    LEFT JOIN apt_complex_source_links k
      ON k.complex_id = m.complex_id AND k.source = 'KAPT'
    LEFT JOIN apt_complex_profile p ON p.complex_id = m.complex_id
    LEFT JOIN (
      SELECT complex_id, MIN(pnu) AS pnu
      FROM official_unit_area_cache
      WHERE pnu != ''
      GROUP BY complex_id
    ) o ON o.complex_id = m.complex_id
  `);
  return rows.rows.map((r) => {
    const lawd = String(r.lawd_cd ?? "");
    const bjdong = String(r.bjdong_cd ?? "");
    const jibun = String(r.jibun ?? "");
    let parcel = parcelFromParts(lawd, bjdong, jibun);
    if (!parcel && r.ouac_pnu) parcel = parcelFromHubPnu(String(r.ouac_pnu));
    return {
      complexId: String(r.complex_id),
      aptName: String(r.apt_name ?? ""),
      sido: r.sido == null ? null : String(r.sido),
      sidoCode: r.sido_code == null ? null : String(r.sido_code),
      lawdCd: lawd,
      parcel,
      parcelKey: parcel ? parcelKey(parcel) : null,
      hubPnu: parcel ? hubPnu(parcel) : null,
      cadastralPnu: parcel ? cadastralPnu(parcel) : null,
      kaptCode: r.kapt_code == null ? null : String(r.kapt_code),
      kaptHousehold: r.kapt_household == null ? null : Number(r.kapt_household),
      priority: priorityForSido(r.sido_code == null ? null : String(r.sido_code)),
    };
  });
}

async function phaseTypeStats(db: Client) {
  const ts = new Date().toISOString();
  await db.execute({
    sql: `INSERT OR IGNORE INTO unit_type_stats (
            complex_id, unit_type_id, household_count, source, source_as_of, status,
            provenance_json, created_at, updated_at
          )
          SELECT complex_id, unit_type_id, household_count, source, source_as_of,
                 CASE WHEN status IN ('EXACT_SINGLE', 'EXACT_MULTI_RESOLVABLE', 'AMBIGUOUS_MULTI')
                      THEN 'EXACT' ELSE 'NO_SOURCE' END,
                 '{}', ?, ?
          FROM apt_canonical_unit_types
          WHERE household_count IS NOT NULL`,
    args: [ts, ts],
  });
}

async function alreadySuccess(db: Client, complexId: string): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT title_status FROM complex_building_checkpoint WHERE complex_id=?`,
    args: [complexId],
  });
  const status = String(res.rows[0]?.title_status ?? "");
  return status === "SUCCESS" || status === "EMPTY" || status === "SKIP_CACHED" || status === "NO_PARCEL";
}

async function processTitleComplex(
  db: Client,
  target: Awaited<ReturnType<typeof loadTargets>>[number],
  totals: Totals,
): Promise<void> {
  if (!target.parcel) {
    if (APPLY) {
      await upsertCheckpoint(db, {
        complexId: target.complexId,
        priority: target.priority,
        titleStatus: "NO_PARCEL",
        buildingStatus: "NO_SOURCE",
        geometryStatus: "NO_GEOMETRY",
        linkStatus: "NO_SOURCE",
        detail: "missing confirmed PNU/jibun",
      });
    }
    return;
  }
  if (await alreadySuccess(db, target.complexId)) {
    totals.titleCacheHits += 1;
    return;
  }
  try {
    const title = await fetchTitleParcel(target.parcel);
    totals.titleApiCalls += title.apiCalls;
    totals.titleCacheHits += title.fromCache ? 1 : 0;
    const main = title.items.filter(isMainBuilding);
    const buildings = main
      .map((row) => buildingFromTitleRow(row, target.complexId, title.sourceAsOf))
      .filter((row): row is NonNullable<typeof row> => row != null);
    const unique = new Map<string, (typeof buildings)[number]>();
    for (const row of buildings) {
      if (!unique.has(row.officialBuildingKey)) unique.set(row.officialBuildingKey, row);
    }
    const deduped = [...unique.values()];
    const residential = deduped.filter((b) => b.residentialFlag);
    if (APPLY) {
      const stats = await upsertBuildings(db, deduped);
      totals.building = addUpsert(totals.building, stats);
      await upsertCheckpoint(db, {
        complexId: target.complexId,
        parcelKey: target.parcelKey ?? "",
        pnu: target.hubPnu ?? "",
        priority: target.priority,
        titleStatus: deduped.length ? (title.fromCache ? "SKIP_CACHED" : "SUCCESS") : "EMPTY",
        buildingStatus: residential.length ? "EXACT" : deduped.length ? "PARTIAL" : "NO_SOURCE",
        geometryStatus: "NO_GEOMETRY",
        linkStatus: "NO_SOURCE",
        titleTotalCount: title.totalCount,
        residentialCount: residential.length,
        apiCalls: title.apiCalls,
        detail: `main=${main.length} residential=${residential.length} unique=${deduped.length}`,
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    totals.titleErrors += 1;
    if (/429|LIMITED_NUMBER|SERVICE_KEY_IS_NOT_REGISTERED|quota/i.test(msg)) {
      totals.quota = true;
    }
    if (APPLY) {
      await upsertCheckpoint(db, {
        complexId: target.complexId,
        parcelKey: target.parcelKey ?? "",
        pnu: target.hubPnu ?? "",
        priority: target.priority,
        titleStatus: totals.quota ? "QUOTA" : "ERROR",
        buildingStatus: "NO_SOURCE",
        geometryStatus: "NO_GEOMETRY",
        linkStatus: "NO_SOURCE",
        detail: msg.slice(0, 300),
      });
    }
    throw Object.assign(new Error(msg), { quota: totals.quota });
  }
}

async function phaseLinks(db: Client, complexIds: string[], totals: Totals) {
  for (const complexId of complexIds) {
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
      sql: `SELECT dong, floor, ho, exclusive_area, residential_common_area, source_as_of, source_key
            FROM official_unit_area_cache
            WHERE complex_id=? AND source_provider='BldRgstHubService'`,
      args: [complexId],
    });
    const units: OfficialUnit[] = unitRes.rows.map((r) => ({
      dong: String(r.dong ?? ""),
      floor: String(r.floor ?? ""),
      ho: String(r.ho ?? ""),
      exclusiveArea: r.exclusive_area == null ? null : Number(r.exclusive_area),
      residentialCommonArea:
        r.residential_common_area == null ? null : Number(r.residential_common_area),
      sourceAsOf: String(r.source_as_of ?? ""),
      sourceKey: String(r.source_key ?? ""),
    }));
    const bldRes = await db.execute({
      sql: `SELECT building_id, dong_label, residential_flag FROM complex_buildings WHERE complex_id=?`,
      args: [complexId],
    });
    const buildings = bldRes.rows.map((r) => ({
      buildingId: String(r.building_id),
      dongLabel: r.dong_label == null ? null : String(r.dong_label),
      residentialFlag: Number(r.residential_flag) === 1,
    }));
    const built = buildTypeBuildingLinks({
      units,
      types,
      buildings,
      source: "official_unit_area_cache+title",
    });
    if (APPLY && built.links.length) {
      const stats = await upsertTypeBuildingLinks(db, complexId, built.links);
      totals.links = addUpsert(totals.links, stats);
    }
    const kapt = await db.execute({
      sql: `SELECT household_count FROM apt_complex_profile WHERE complex_id=?`,
      args: [complexId],
    });
    const unitCount = new Set(
      units.filter((u) => u.dong && u.ho).map((u) => `${u.dong}\t${u.floor}\t${u.ho}`),
    ).size;
    const typeSumRes = await db.execute({
      sql: `SELECT SUM(household_count) s FROM unit_type_stats WHERE complex_id=? AND status='EXACT'`,
      args: [complexId],
    });
    const bldgSumRes = await db.execute({
      sql: `SELECT SUM(household_count) s FROM complex_buildings WHERE complex_id=? AND residential_flag=1`,
      args: [complexId],
    });
    const parity = classifyParity({
      kaptHousehold: kapt.rows[0]?.household_count == null ? null : Number(kapt.rows[0].household_count),
      unitHousehold: unitCount || null,
      typeHouseholdSum: typeSumRes.rows[0]?.s == null ? null : Number(typeSumRes.rows[0].s),
      buildingHouseholdSum: bldgSumRes.rows[0]?.s == null ? null : Number(bldgSumRes.rows[0].s),
    });
    if (APPLY) {
      await upsertParity(db, {
        complexId,
        kaptHousehold: kapt.rows[0]?.household_count == null ? null : Number(kapt.rows[0].household_count),
        unitHousehold: unitCount || null,
        typeHouseholdSum: typeSumRes.rows[0]?.s == null ? null : Number(typeSumRes.rows[0].s),
        buildingHouseholdSum: bldgSumRes.rows[0]?.s == null ? null : Number(bldgSumRes.rows[0].s),
        parityClass: parity.parityClass,
        detail: parity.detail,
        sourceAsOf: new Date().toISOString().slice(0, 10),
      });
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
        geometryStatus: "NO_GEOMETRY",
        linkStatus: built.links.length ? "EXACT" : units.length ? "PARTIAL" : "NO_SOURCE",
        titleTotalCount: Number(prev?.title_total_count ?? 0),
        residentialCount: Number(prev?.residential_count ?? 0),
        apiCalls: Number(prev?.api_calls ?? 0),
        detail: String(prev?.detail ?? ""),
      });
    }
  }
}

async function writeReport(db: Client, totals: Totals) {
  mkdirSync(OUT, { recursive: true });
  const q = async (sql: string) => (await db.execute(sql)).rows;
  const master = Number((await q(`SELECT COUNT(*) n FROM apt_complex_master`))[0]?.n ?? 0);
  const inv = await q(`
    SELECT COUNT(DISTINCT complex_id) complexes,
           SUM(CASE WHEN residential_flag=1 THEN 1 ELSE 0 END) residential,
           SUM(CASE WHEN residential_flag=1 AND status='EXACT' THEN 1 ELSE 0 END) exact,
           SUM(CASE WHEN residential_flag=1 AND status='PARTIAL' THEN 1 ELSE 0 END) partial,
           SUM(CASE WHEN residential_flag=1 AND dong_label_status='EXACT_DONG_LABEL' THEN 1 ELSE 0 END) labeled,
           SUM(CASE WHEN residential_flag=1 AND dong_label_status='MISSING_DONG_LABEL' THEN 1 ELSE 0 END) unlabeled
    FROM complex_buildings`);
  const geom = await q(`
    SELECT COUNT(*) n,
           SUM(CASE WHEN geometry_status='EXACT_FOOTPRINT' THEN 1 ELSE 0 END) footprints,
           SUM(CASE WHEN geometry_status='POINT_ONLY' THEN 1 ELSE 0 END) points,
           SUM(CASE WHEN geometry_status='NO_GEOMETRY' THEN 1 ELSE 0 END) none
    FROM complex_building_geometry`);
  const types = await q(`
    SELECT COUNT(DISTINCT complex_id) complexes, COUNT(*) types,
           SUM(household_count) households
    FROM unit_type_stats WHERE status='EXACT'`);
  const links = await q(`
    SELECT COUNT(DISTINCT complex_id) complexes, COUNT(*) links,
           SUM(CASE WHEN status='EXACT' THEN 1 ELSE 0 END) exact
    FROM unit_type_building_links`);
  const parity = await q(`
    SELECT parity_class, COUNT(*) n FROM complex_building_parity GROUP BY 1`);
  const sido = await q(`
    SELECT m.sido, m.sido_code,
           COUNT(DISTINCT m.complex_id) complexes,
           COUNT(DISTINCT CASE WHEN b.building_id IS NOT NULL THEN m.complex_id END) with_buildings,
           SUM(CASE WHEN b.residential_flag=1 THEN 1 ELSE 0 END) residential,
           COUNT(DISTINCT CASE WHEN l.complex_id IS NOT NULL THEN m.complex_id END) with_links,
           COUNT(DISTINCT CASE WHEN s.complex_id IS NOT NULL THEN m.complex_id END) with_types
    FROM apt_complex_master m
    LEFT JOIN complex_buildings b ON b.complex_id=m.complex_id
    LEFT JOIN (SELECT DISTINCT complex_id FROM unit_type_building_links WHERE status='EXACT') l
      ON l.complex_id=m.complex_id
    LEFT JOIN (SELECT DISTINCT complex_id FROM unit_type_stats WHERE status='EXACT') s
      ON s.complex_id=m.complex_id
    GROUP BY 1,2`);
  const pilots = await q(`
    SELECT m.complex_id, m.apt_name,
           SUM(CASE WHEN b.residential_flag=1 THEN 1 ELSE 0 END) residential,
           SUM(CASE WHEN b.residential_flag=1 AND b.dong_label_status='EXACT_DONG_LABEL' THEN 1 ELSE 0 END) labeled,
           p.kapt_household_count, p.unit_household_count, p.type_household_sum,
           p.building_household_sum, p.parity_class,
           (SELECT COUNT(*) FROM unit_type_building_links l WHERE l.complex_id=m.complex_id AND l.status='EXACT') links
    FROM apt_complex_master m
    LEFT JOIN complex_buildings b ON b.complex_id=m.complex_id
    LEFT JOIN complex_building_parity p ON p.complex_id=m.complex_id
    WHERE m.complex_id IN (${PILOT_IDS.map((id) => `'${id}'`).join(",")})
    GROUP BY m.complex_id
    ORDER BY m.apt_name`);
  const jamsilTypes = await q(`
    SELECT t.exclusive_area, t.supply_area, t.household_count AS canonical_hh,
           s.household_count AS stats_hh,
           (SELECT COUNT(DISTINCT l.building_id) FROM unit_type_building_links l
             WHERE l.unit_type_id=t.unit_type_id AND l.status='EXACT') buildings,
           (SELECT SUM(l.household_count) FROM unit_type_building_links l
             WHERE l.unit_type_id=t.unit_type_id AND l.status='EXACT') linked_hh
    FROM apt_canonical_unit_types t
    LEFT JOIN unit_type_stats s ON s.unit_type_id=t.unit_type_id
    WHERE t.complex_id='cx_4c63d9a100973c60'
      AND t.exclusive_area IN (84.8, 84.88, 84.97)
    ORDER BY t.exclusive_area`);
  const titleStatus = await q(
    `SELECT title_status, COUNT(*) n FROM complex_building_checkpoint GROUP BY 1`,
  );
  const report = {
    generatedAt: new Date().toISOString(),
    apply: APPLY,
    totals,
    national: {
      targetComplexes: master,
      inventory: inv[0] ?? {},
      geometry: geom[0] ?? {},
      typeStats: types[0] ?? {},
      typeBuilding: links[0] ?? {},
      parity,
      titleStatus,
    },
    sido,
    sidoBuckets: Object.fromEntries(
      sido.map((row) => [
        sidoBucket(
          row.sido == null ? null : String(row.sido),
          row.sido_code == null ? null : String(row.sido_code),
        ),
        row,
      ]),
    ),
    pilots,
    jamsilTypes,
  };
  const path = join(OUT, "national-report.json");
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log("wrote", path);
  return report;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const db = dbClient();
  await ensureBuildingSchema(db);
  const totals: Totals = {
    titleApiCalls: 0,
    titleCacheHits: 0,
    titleErrors: 0,
    quota: false,
    building: emptyUpsert(),
    links: emptyUpsert(),
  };

  if (PHASE === "stats" || PHASE === "all") {
    console.log("phase type stats");
    if (APPLY) await phaseTypeStats(db);
  }

  const targets = await loadTargets(db);
  let work = targets.filter((t) => t.priority <= PRIORITY_MAX);
  if (PILOTS_ONLY) work = work.filter((t) => PILOT_IDS.includes(t.complexId));
  if (OUAC_UNITS) {
    const unitComplexes = await db.execute(
      `SELECT DISTINCT complex_id FROM official_unit_area_cache WHERE source_provider='BldRgstHubService'`,
    );
    const allow = new Set(unitComplexes.rows.map((r) => String(r.complex_id)));
    work = work.filter((t) => allow.has(t.complexId));
  }
  work.sort((a, b) => a.priority - b.priority || a.complexId.localeCompare(b.complexId));
  if (LIMIT > 0) work = work.slice(0, LIMIT);

  if (PHASE === "title" || PHASE === "all") {
    console.log("phase title", work.length, "concurrency", CONCURRENCY);
    let next = 0;
    let consecErrors = 0;
    let stop = false;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (!stop) {
        const i = next;
        next += 1;
        if (i >= work.length) return;
        if (totals.titleApiCalls >= MAX_API) {
          stop = true;
          console.log("max-api reached", totals.titleApiCalls);
          return;
        }
        const target = work[i];
        try {
          await processTitleComplex(db, target, totals);
          consecErrors = 0;
        } catch (error) {
          const quota = Boolean((error as { quota?: boolean }).quota);
          console.warn("title fail", target.aptName, (error as Error).message);
          consecErrors += 1;
          if (quota) {
            totals.quota = true;
            stop = true;
            console.log("STOP quota");
            return;
          }
          if (consecErrors >= 12) {
            stop = true;
            console.log("STOP consecutive title errors", consecErrors);
            return;
          }
          await new Promise((r) => setTimeout(r, Math.min(20000, 1000 * 2 ** Math.min(consecErrors, 5))));
        }
        if ((i + 1) % 25 === 0) {
          console.log(
            JSON.stringify({
              i: i + 1,
              api: totals.titleApiCalls,
              cache: totals.titleCacheHits,
              errors: totals.titleErrors,
              inserted: totals.building.inserted,
            }),
          );
        }
      }
    });
    await Promise.all(workers);
  }

  if (PHASE === "links" || PHASE === "all") {
    const withBuildings = await db.execute(
      `SELECT DISTINCT complex_id FROM complex_buildings WHERE residential_flag=1`,
    );
    let ids = withBuildings.rows.map((r) => String(r.complex_id));
    if (PILOTS_ONLY) ids = ids.filter((id) => PILOT_IDS.includes(id));
    console.log("phase links", ids.length);
    await phaseLinks(db, ids, totals);
  }

  if (PHASE === "report" || PHASE === "all") {
    const report = await writeReport(db, totals);
    console.log(JSON.stringify({
      apply: APPLY,
      api: totals.titleApiCalls,
      buildingsInserted: totals.building.inserted,
      linksInserted: totals.links.inserted,
      inventory: report.national.inventory,
      typeStats: report.national.typeStats,
      typeBuilding: report.national.typeBuilding,
    }));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
