import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { ensureBuildingSchema } from "@/lib/buildings/schema";
import {
  hubPnu,
  parcelFromCadastralPnu,
  parcelFromHubPnu,
  parcelFromParts,
  parcelKey,
  sidoBucket,
} from "@/lib/buildings/parcel";
import { readTitleCache, fetchTitleParcel } from "@/lib/buildings/title-client";
import { buildingFromTitleRow } from "@/lib/buildings/from-title";
import { isMainBuilding } from "@/lib/buildings/residential";
import { officialKeyFromTitlePk } from "@/lib/buildings/identity";
import { heightAttrsFromTitle } from "@/lib/buildings/height";
import {
  buildTypeBuildingLinks,
  type CanonicalType,
  type OfficialUnit,
} from "@/lib/buildings/type-links";
import { classifyParity } from "@/lib/buildings/parity";
import {
  deriveHouseholdCounts,
  displayedExceedsPhysical,
  uiSafeTypeSum,
} from "@/lib/buildings/counts";
import { payloadBytes } from "@/lib/buildings/geometry";
import { emptyManifest, writeManifest } from "@/lib/buildings/gis-source";
import { acquireOfficialGis } from "@/lib/buildings/gis-acquire";
import { loadComplexBuildingsApi, loadComplexBuildingsApiLive } from "@/lib/buildings/api";
import { findCompactArtifact, ingestCompactUnitEvidence } from "@/lib/buildings/ingest-unit-evidence";
import {
  upsertBuildings,
  upsertCheckpoint,
  upsertCompactExtractorSpec,
  upsertGisManifest,
  upsertHouseholdCounts,
  upsertParity,
  upsertTypeBuildingLinks,
  upsertResolutionStats,
  upsertApiSnapshot,
  refreshThreeDReadiness,
  type UpsertStats,
} from "@/lib/buildings/repository";

const APPLY = !process.argv.includes("--dry-run");
const PHASE = (process.argv.find((a) => a.startsWith("--phase="))?.slice(8) ?? "all").toLowerCase();
const MAX_API = Number(process.argv.find((a) => a.startsWith("--max-api="))?.slice(10) ?? "4000");
const CONCURRENCY = Math.max(1, Number(process.argv.find((a) => a.startsWith("--concurrency="))?.slice(14) ?? "2"));
const OUT = join(process.cwd(), "data/poc/building-topology");
const EXTRACTOR = JSON.parse(
  readFileSync(join(OUT, "compact-unit-building-extractor.spec.json"), "utf8"),
) as {
  specId: string;
  required: boolean;
  output: { artifactName: string; expectedSize: string };
};

const PILOT_IDS = [
  "cx_4c63d9a100973c60",
  "cx_ed52bf895d064c11",
  "cx_caf229b5ac63cfbd",
  "cx_30d7eea6da810b52",
  "cx_1c244e7305d12c44",
  "cx_3bcf0f87bce7496b",
  "cx_0320fd9e007e1f8c",
  "cx_c9ed0235ecca960c",
  "cx_07caf64c556e85a7",
  "cx_88d05e29df26a0d6",
];

function dbClient(): Client {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url) throw new Error("TURSO_DATABASE_URL missing");
  return createClient({ url, authToken });
}

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

async function phaseSchema(db: Client) {
  await ensureBuildingSchema(db);
}

async function phaseGisManifest(db: Client) {
  const acquired = await acquireOfficialGis();
  const status = acquired.sourceTemporarilyUnavailable
    ? "SOURCE_TEMPORARILY_UNAVAILABLE"
    : "FILE_AVAILABLE";
  const manifest = emptyManifest(
    JSON.stringify({
      successfulOfficialPath: acquired.successfulOfficialPath,
      failedPaths: acquired.failedPaths,
      wfsValidationOk: acquired.wfsValidationOk,
      fileUrl: acquired.fileUrl,
      paths: acquired.paths.map((p) => ({ path: p.path, status: p.status, attempts: p.attempts.length })),
      note: "Bulk SHP not acquired; WFS not ingested as national footprints",
    }),
    status,
  );
  manifest.successfulOfficialPath = acquired.successfulOfficialPath;
  manifest.failedPaths = acquired.failedPaths;
  writeManifest(manifest);
  if (!APPLY) return { manifest, acquired };
  await upsertGisManifest(db, {
    manifestId: "gis-building-20260809",
    sourceDataset: manifest.sourceDataset,
    sourceVersion: manifest.sourceVersion,
    sourceDate: manifest.sourceDate,
    checksum: manifest.checksum,
    crs: manifest.crs,
    featureCount: manifest.featureCount,
    validGeometryCount: manifest.validGeometryCount,
    licenseAttribution: manifest.licenseAttribution,
    wfsFallbackUsed: false,
    acquisitionStatus: manifest.acquisitionStatus,
    localPath: "",
    detail: manifest.detail,
  });
  await upsertCompactExtractorSpec(db, {
    specId: EXTRACTOR.specId,
    required: EXTRACTOR.required,
    artifactName: EXTRACTOR.output.artifactName,
    expectedSize: EXTRACTOR.output.expectedSize,
    specJson: JSON.stringify(EXTRACTOR),
  });
  return { manifest, acquired };
}

async function phaseHeight(db: Client) {
  const cps = await db.execute(
    `SELECT complex_id, parcel_key FROM complex_building_checkpoint
     WHERE title_status IN ('SUCCESS', 'SKIP_CACHED') AND parcel_key != ''`,
  );
  let files = 0;
  let filled = 0;
  const updates: { sql: string; args: unknown[] }[] = [];
  const ts = new Date().toISOString();
  for (const row of cps.rows) {
    const cache = readTitleCache(String(row.parcel_key));
    if (!cache) continue;
    files += 1;
    for (const item of cache.items) {
      if (!isMainBuilding(item)) continue;
      const pk = officialKeyFromTitlePk(item.mgmBldrgstPk ?? "");
      if (!pk) continue;
      const height = heightAttrsFromTitle(item);
      updates.push({
        sql: `UPDATE complex_buildings SET
                height_m = COALESCE(height_m, ?),
                underground_floor_count = COALESCE(underground_floor_count, ?),
                structure_type = COALESCE(structure_type, ?),
                roof_type = COALESCE(roof_type, ?),
                arch_area = COALESCE(arch_area, ?),
                tot_area = COALESCE(tot_area, ?),
                floor_count = COALESCE(floor_count, ?),
                height_status = COALESCE(NULLIF(height_status, ''), ?),
                three_d_readiness = COALESCE(NULLIF(three_d_readiness, ''), 'NO_GEOMETRY'),
                updated_at = ?
              WHERE official_building_key = ?`,
        args: [
          height.heightM,
          height.undergroundFloorCount,
          height.structureType,
          height.roofType,
          height.archArea,
          height.totArea,
          height.groundFloorCount,
          height.heightStatus,
          ts,
          pk,
        ],
      });
    }
  }
  if (APPLY) {
    for (let i = 0; i < updates.length; i += 40) {
      await db.batch(updates.slice(i, i + 40) as never, "write");
      filled += Math.min(40, updates.length - i);
      if (i % 2000 === 0) console.log("height batch", i, "/", updates.length);
    }
    await refreshThreeDReadiness(db);
  }
  return { files, updates: updates.length, filled };
}

async function phaseCounts(db: Client) {
  const typeRows = await db.execute(
    `SELECT complex_id, unit_type_id, exclusive_cents, supply_cents, status, household_count FROM apt_canonical_unit_types`,
  );
  const unitRows = await db.execute(
    `SELECT complex_id, dong, floor, ho, exclusive_area, residential_common_area, source_as_of, source_key, source_building_id
     FROM official_unit_area_cache WHERE source_provider='BldRgstHubService'`,
  );
  const kaptRows = await db.execute(`SELECT complex_id, household_count FROM apt_complex_profile`);
  const bldgRows = await db.execute(
    `SELECT complex_id, SUM(household_count) s FROM complex_buildings WHERE residential_flag=1 GROUP BY 1`,
  );
  const unsafeRows = await db.execute(
    `SELECT complex_id, SUM(household_count) s FROM unit_type_stats GROUP BY 1`,
  );
  const typesByCx = new Map<string, CanonicalType[]>();
  for (const r of typeRows.rows) {
    const id = String(r.complex_id);
    const list = typesByCx.get(id) ?? [];
    list.push({
      unitTypeId: String(r.unit_type_id),
      exclusiveCents: Number(r.exclusive_cents),
      supplyCents: Number(r.supply_cents),
      status: String(r.status),
      householdCount: r.household_count == null ? null : Number(r.household_count),
    });
    typesByCx.set(id, list);
  }
  const unitsByCx = new Map<string, OfficialUnit[]>();
  for (const r of unitRows.rows) {
    const id = String(r.complex_id);
    const list = unitsByCx.get(id) ?? [];
    list.push({
      dong: String(r.dong ?? ""),
      floor: String(r.floor ?? ""),
      ho: String(r.ho ?? ""),
      exclusiveArea: r.exclusive_area == null ? null : Number(r.exclusive_area),
      residentialCommonArea:
        r.residential_common_area == null ? null : Number(r.residential_common_area),
      officialBuildingKey: officialKeyFromTitlePk(String(r.source_building_id ?? "")),
      sourceAsOf: String(r.source_as_of ?? ""),
      sourceKey: String(r.source_key ?? ""),
    });
    unitsByCx.set(id, list);
  }
  const kapt = new Map(kaptRows.rows.map((r) => [String(r.complex_id), r.household_count == null ? null : Number(r.household_count)]));
  const bldg = new Map(bldgRows.rows.map((r) => [String(r.complex_id), r.s == null ? null : Number(r.s)]));
  const unsafe = new Map(unsafeRows.rows.map((r) => [String(r.complex_id), r.s == null ? null : Number(r.s)]));
  const asOf = new Date().toISOString().slice(0, 10);
  const ts = new Date().toISOString();
  const stats = emptyUpsert();
  const typeInserts: { sql: string; args: unknown[] }[] = [];
  const groupInserts: { sql: string; args: unknown[] }[] = [];
  const parityInserts: { sql: string; args: unknown[] }[] = [];
  let n = 0;
  for (const [complexId, types] of typesByCx) {
    const units = unitsByCx.get(complexId) ?? [];
    const derived = deriveHouseholdCounts({ types, units });
    const physical = units.filter((u) => u.dong && u.ho).length || null;
    const uiSum = uiSafeTypeSum(derived.types);
    const groupSum = derived.groups.reduce((s, g) => s + (g.householdCount ?? 0), 0);
    const parity = classifyParity({
      kaptHousehold: kapt.get(complexId) ?? null,
      unitHousehold: physical,
      typeHouseholdSum: uiSum || null,
      buildingHouseholdSum: bldg.get(complexId) ?? null,
    });
    for (const row of derived.types) {
      typeInserts.push({
        sql: `INSERT INTO unit_type_household_counts (
                complex_id, unit_type_id, exclusive_cents, supply_cents, household_count,
                count_status, ui_safe, source, source_as_of, provenance_json, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          complexId, row.unitTypeId, row.exclusiveCents, row.supplyCents, row.householdCount,
          row.countStatus, row.uiSafe ? 1 : 0, row.source, asOf, JSON.stringify(row.provenance), ts, ts,
        ],
      });
    }
    for (const row of derived.groups) {
      groupInserts.push({
        sql: `INSERT INTO unit_exclusive_group_counts (
                complex_id, exclusive_cents, household_count, variant_count, count_status,
                source, source_as_of, provenance_json, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          complexId, row.exclusiveCents, row.householdCount, row.variantCount, row.countStatus,
          row.source, asOf, JSON.stringify(row.provenance), ts,
        ],
      });
    }
    parityInserts.push({
      sql: `INSERT INTO complex_building_parity (
              complex_id, kapt_household_count, unit_household_count, type_household_sum,
              building_household_sum, parity_class, detail, source_as_of, updated_at,
              physical_unit_count, ui_safe_type_sum, exclusive_group_sum, displayed_exceeds_physical
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(complex_id) DO UPDATE SET
              kapt_household_count=excluded.kapt_household_count,
              unit_household_count=excluded.unit_household_count,
              type_household_sum=excluded.type_household_sum,
              building_household_sum=excluded.building_household_sum,
              parity_class=excluded.parity_class,
              detail=excluded.detail,
              source_as_of=excluded.source_as_of,
              physical_unit_count=excluded.physical_unit_count,
              ui_safe_type_sum=excluded.ui_safe_type_sum,
              exclusive_group_sum=excluded.exclusive_group_sum,
              displayed_exceeds_physical=excluded.displayed_exceeds_physical,
              updated_at=excluded.updated_at`,
      args: [
        complexId, kapt.get(complexId) ?? null, physical, unsafe.get(complexId) ?? null,
        bldg.get(complexId) ?? null, parity.parityClass, parity.detail, asOf, ts,
        physical, uiSum, groupSum, displayedExceedsPhysical(uiSum, physical) ? 1 : 0,
      ],
    });
    n += 1;
  }
  if (APPLY) {
    await db.execute(`DELETE FROM unit_type_household_counts`);
    await db.execute(`DELETE FROM unit_exclusive_group_counts`);
    for (let i = 0; i < typeInserts.length; i += 40) {
      await db.batch(typeInserts.slice(i, i + 40) as never, "write");
      if (i % 4000 === 0) console.log("count types", i, "/", typeInserts.length);
    }
    for (let i = 0; i < groupInserts.length; i += 40) {
      await db.batch(groupInserts.slice(i, i + 40) as never, "write");
    }
    for (let i = 0; i < parityInserts.length; i += 40) {
      await db.batch(parityInserts.slice(i, i + 40) as never, "write");
    }
    stats.inserted = typeInserts.length;
  }
  return { complexes: n, typeRows: typeInserts.length, groupRows: groupInserts.length, stats };
}

async function loadUnits(db: Client, complexId: string): Promise<OfficialUnit[]> {
  const unitRes = await db.execute({
    sql: `SELECT dong, floor, ho, exclusive_area, residential_common_area, source_as_of, source_key, source_building_id
          FROM official_unit_area_cache
          WHERE complex_id=? AND source_provider='BldRgstHubService'`,
    args: [complexId],
  });
  return unitRes.rows.map((r) => ({
    dong: String(r.dong ?? ""),
    floor: String(r.floor ?? ""),
    ho: String(r.ho ?? ""),
    exclusiveArea: r.exclusive_area == null ? null : Number(r.exclusive_area),
    residentialCommonArea:
      r.residential_common_area == null ? null : Number(r.residential_common_area),
    officialBuildingKey: officialKeyFromTitlePk(String(r.source_building_id ?? "")),
    sourceAsOf: String(r.source_as_of ?? ""),
    sourceKey: String(r.source_key ?? ""),
  }));
}

async function loadTypes(db: Client, complexId: string): Promise<CanonicalType[]> {
  const typesRes = await db.execute({
    sql: `SELECT unit_type_id, exclusive_cents, supply_cents, status, household_count
          FROM apt_canonical_unit_types WHERE complex_id=?`,
    args: [complexId],
  });
  return typesRes.rows.map((r) => ({
    unitTypeId: String(r.unit_type_id),
    exclusiveCents: Number(r.exclusive_cents),
    supplyCents: Number(r.supply_cents),
    status: String(r.status),
    householdCount: r.household_count == null ? null : Number(r.household_count),
  }));
}

async function phaseLinks(db: Client) {
  const ids = await db.execute(
    `SELECT DISTINCT complex_id FROM official_unit_area_cache WHERE source_provider='BldRgstHubService'`,
  );
  const stats = emptyUpsert();
  for (const row of ids.rows) {
    const complexId = String(row.complex_id);
    const types = await loadTypes(db, complexId);
    const units = await loadUnits(db, complexId);
    const bldRes = await db.execute({
      sql: `SELECT building_id, dong_label, residential_flag, official_building_key FROM complex_buildings WHERE complex_id=?`,
      args: [complexId],
    });
    const buildings = bldRes.rows.map((r) => ({
      buildingId: String(r.building_id),
      dongLabel: r.dong_label == null ? null : String(r.dong_label),
      residentialFlag: Number(r.residential_flag) === 1,
      officialBuildingKey: r.official_building_key == null ? null : String(r.official_building_key),
    }));
    const built = buildTypeBuildingLinks({
      units,
      types,
      buildings,
      source: "official_unit_area_cache+title.mgm_bldrgst_pk",
    });
    if (APPLY) {
      if (built.links.length) {
        const up = await upsertTypeBuildingLinks(db, complexId, built.links);
        Object.assign(stats, addUpsert(stats, up));
      }
      await upsertResolutionStats(
        db,
        complexId,
        built.stats,
        "official_unit_area_cache+title.mgm_bldrgst_pk",
        units[0]?.sourceAsOf ?? "",
      );
    }
    if (APPLY && built.links.length) {
      const cp = await db.execute({
        sql: `SELECT * FROM complex_building_checkpoint WHERE complex_id=?`,
        args: [complexId],
      });
      const prev = cp.rows[0];
      if (prev) {
        await upsertCheckpoint(db, {
          complexId,
          parcelKey: String(prev.parcel_key ?? ""),
          pnu: String(prev.pnu ?? ""),
          priority: Number(prev.priority ?? 9),
          titleStatus: String(prev.title_status ?? "PENDING"),
          buildingStatus: String(prev.building_status ?? "NO_SOURCE"),
          geometryStatus: String(prev.geometry_status ?? "NO_GEOMETRY"),
          linkStatus: "EXACT",
          titleTotalCount: Number(prev.title_total_count ?? 0),
          residentialCount: Number(prev.residential_count ?? 0),
          apiCalls: Number(prev.api_calls ?? 0),
          detail: String(prev.detail ?? ""),
        });
      }
    }
  }
  return stats;
}

async function processTitle(
  db: Client,
  target: { complexId: string; parcel: NonNullable<ReturnType<typeof parcelFromParts>>; parcelKey: string; hubPnu: string; priority: number; recovery: string },
  totals: { api: number; recovered: number; empty: number; error: number },
) {
  const title = await fetchTitleParcel(target.parcel);
  totals.api += title.apiCalls;
  const main = title.items.filter(isMainBuilding);
  const buildings = main
    .map((row) => buildingFromTitleRow(row, target.complexId, title.sourceAsOf))
    .filter((row): row is NonNullable<typeof row> => row != null);
  const unique = new Map<string, (typeof buildings)[number]>();
  for (const row of buildings) unique.set(row.officialBuildingKey, row);
  const deduped = [...unique.values()];
  const residential = deduped.filter((b) => b.residentialFlag);
  const recovery = deduped.length ? "RECOVERED" : "OFFICIAL_EMPTY";
  if (deduped.length) totals.recovered += 1;
  else totals.empty += 1;
  if (APPLY) {
    if (deduped.length) await upsertBuildings(db, deduped);
    await upsertCheckpoint(db, {
      complexId: target.complexId,
      parcelKey: target.parcelKey,
      pnu: target.hubPnu,
      priority: target.priority,
      titleStatus: deduped.length ? (title.fromCache ? "SKIP_CACHED" : "SUCCESS") : "EMPTY",
      buildingStatus: residential.length ? "EXACT" : deduped.length ? "PARTIAL" : "NO_SOURCE",
      geometryStatus: "NO_GEOMETRY",
      linkStatus: "NO_SOURCE",
      titleTotalCount: title.totalCount,
      residentialCount: residential.length,
      apiCalls: title.apiCalls,
      detail: `v2 ${target.recovery} main=${main.length} residential=${residential.length}`,
      titleRetryCount: 1,
      titleRecoveryStatus: recovery,
    });
  }
}

async function phaseTitleRetry(db: Client) {
  const rows = await db.execute(`
    SELECT c.complex_id, c.parcel_key, c.pnu, c.priority, c.title_retry_count, c.detail,
           m.lawd_cd, m.bjdong_cd, m.jibun, o.pnu AS ouac_pnu, p.pnu AS parcel_pnu
    FROM complex_building_checkpoint c
    JOIN apt_complex_master m ON m.complex_id=c.complex_id
    LEFT JOIN (
      SELECT complex_id, MIN(pnu) pnu FROM official_unit_area_cache WHERE pnu!='' GROUP BY complex_id
    ) o ON o.complex_id=c.complex_id
    LEFT JOIN complex_parcel_coordinates p ON p.complex_id=c.complex_id
    WHERE c.title_status='ERROR'
  `);
  const totals = { api: 0, recovered: 0, empty: 0, error: 0, skipped: 0 };
  let next = 0;
  const work = rows.rows.filter((r) => Number(r.title_retry_count ?? 0) < 3);
  totals.skipped = rows.rows.length - work.length;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= work.length || totals.api >= MAX_API) return;
      const r = work[i];
      const complexId = String(r.complex_id);
      let parcel = parcelFromParts(String(r.lawd_cd ?? ""), String(r.bjdong_cd ?? ""), String(r.jibun ?? ""));
      if (!parcel && r.ouac_pnu) parcel = parcelFromHubPnu(String(r.ouac_pnu)) ?? parcelFromCadastralPnu(String(r.ouac_pnu));
      if (!parcel && r.pnu) parcel = parcelFromHubPnu(String(r.pnu)) ?? parcelFromCadastralPnu(String(r.pnu));
      if (!parcel && r.parcel_pnu) parcel = parcelFromCadastralPnu(String(r.parcel_pnu));
      const retries = Number(r.title_retry_count ?? 0) + 1;
      if (!parcel) {
        totals.error += 1;
        if (APPLY) {
          await upsertCheckpoint(db, {
            complexId,
            parcelKey: String(r.parcel_key ?? ""),
            pnu: String(r.pnu ?? ""),
            priority: Number(r.priority ?? 9),
            titleStatus: "ERROR",
            buildingStatus: "NO_SOURCE",
            geometryStatus: "NO_GEOMETRY",
            linkStatus: "NO_SOURCE",
            detail: "IDENTITY_MISSING",
            titleRetryCount: retries,
            titleRecoveryStatus: "IDENTITY_MISSING",
          });
        }
        continue;
      }
      try {
        await processTitle(db, {
          complexId,
          parcel,
          parcelKey: parcelKey(parcel),
          hubPnu: hubPnu(parcel),
          priority: Number(r.priority ?? 9),
          recovery: "ERROR",
        }, totals);
      } catch (error) {
        totals.error += 1;
        const msg = error instanceof Error ? error.message : String(error);
        if (APPLY) {
          await upsertCheckpoint(db, {
            complexId,
            parcelKey: parcelKey(parcel),
            pnu: hubPnu(parcel),
            priority: Number(r.priority ?? 9),
            titleStatus: retries >= 3 ? "ERROR" : "ERROR",
            buildingStatus: "NO_SOURCE",
            geometryStatus: "NO_GEOMETRY",
            linkStatus: "NO_SOURCE",
            detail: msg.slice(0, 300),
            titleRetryCount: retries,
            titleRecoveryStatus: retries >= 3 ? "SOURCE_ERROR" : "SOURCE_ERROR",
          });
        }
      }
    }
  });
  await Promise.all(workers);
  return totals;
}

async function phaseNoParcel(db: Client) {
  const rows = await db.execute(`
    SELECT c.complex_id, c.priority, m.lawd_cd, m.bjdong_cd, m.jibun, p.pnu AS parcel_pnu, o.pnu AS ouac_pnu
    FROM complex_building_checkpoint c
    JOIN apt_complex_master m ON m.complex_id=c.complex_id
    LEFT JOIN complex_parcel_coordinates p ON p.complex_id=c.complex_id
    LEFT JOIN (
      SELECT complex_id, MIN(pnu) pnu FROM official_unit_area_cache WHERE pnu!='' GROUP BY complex_id
    ) o ON o.complex_id=c.complex_id
    WHERE c.title_status='NO_PARCEL'
      AND (
        (p.pnu IS NOT NULL AND p.pnu != '')
        OR (o.pnu IS NOT NULL AND o.pnu != '')
      )
  `);
  const totals = { api: 0, recovered: 0, empty: 0, error: 0, candidates: rows.rows.length };
  for (const r of rows.rows) {
    const parcel =
      (r.parcel_pnu ? parcelFromCadastralPnu(String(r.parcel_pnu)) : null) ||
      (r.ouac_pnu ? parcelFromHubPnu(String(r.ouac_pnu)) ?? parcelFromCadastralPnu(String(r.ouac_pnu)) : null);
    if (!parcel) continue;
    try {
      await processTitle(db, {
        complexId: String(r.complex_id),
        parcel,
        parcelKey: parcelKey(parcel),
        hubPnu: hubPnu(parcel),
        priority: Number(r.priority ?? 9),
        recovery: "NO_PARCEL_DELTA",
      }, totals);
    } catch {
      totals.error += 1;
    }
  }
  return totals;
}

async function measureApi(db: Client) {
  const timings: Record<string, {
    coldMs: number;
    liveMs: number;
    snapshotMs: number | null;
    bytes: number;
    buildings: number;
    displayedHousehold: number;
  }> = {};
  for (const id of PILOT_IDS) {
    const tCold = Date.now();
    await loadComplexBuildingsApiLive(db, id);
    const coldMs = Date.now() - tCold;
    const t0 = Date.now();
    const live = await loadComplexBuildingsApiLive(db, id);
    const liveMs = Date.now() - t0;
    if (APPLY && live) {
      await upsertApiSnapshot(db, id, live);
    }
    const t1 = Date.now();
    const snap = await loadComplexBuildingsApi(db, id);
    const snapshotMs = Date.now() - t1;
    const displayedHousehold = (live?.typeStats.rows ?? [])
      .filter((r) => r.uiSafe)
      .reduce((n, r) => n + (r.householdCount ?? 0), 0);
    timings[id] = {
      coldMs,
      liveMs,
      snapshotMs: snap ? snapshotMs : null,
      bytes: payloadBytes(live),
      buildings: live?.buildings.length ?? 0,
      displayedHousehold,
    };
  }
  return timings;
}

async function writeReport(db: Client, extras: Record<string, unknown>) {
  mkdirSync(OUT, { recursive: true });
  const q = async (sql: string) => (await db.execute(sql)).rows;
  const height = await q(`
    SELECT
      SUM(CASE WHEN height_status='OFFICIAL_HEIGHT' THEN 1 ELSE 0 END) official,
      SUM(CASE WHEN height_status='FLOOR_COUNT_ONLY' THEN 1 ELSE 0 END) floor_only,
      SUM(CASE WHEN height_status='HEIGHT_MISSING' OR height_status IS NULL THEN 1 ELSE 0 END) missing
    FROM complex_buildings WHERE residential_flag=1`);
  const three = await q(`
    SELECT
      SUM(CASE WHEN three_d_readiness='3D_EXACT' THEN 1 ELSE 0 END) exact,
      SUM(CASE WHEN three_d_readiness='3D_PARTIAL' THEN 1 ELSE 0 END) partial,
      SUM(CASE WHEN three_d_readiness='FOOTPRINT_ONLY' THEN 1 ELSE 0 END) footprint,
      SUM(CASE WHEN three_d_readiness='NO_GEOMETRY' OR three_d_readiness IS NULL THEN 1 ELSE 0 END) none
    FROM complex_buildings WHERE residential_flag=1`);
  const counts = await q(`
    SELECT count_status, SUM(ui_safe) ui_safe, COUNT(*) n, SUM(household_count) hh
    FROM unit_type_household_counts GROUP BY 1`);
  const exceed = await q(`SELECT SUM(displayed_exceeds_physical) n FROM complex_building_parity`);
  const links = await q(`
    SELECT COUNT(DISTINCT complex_id) complexes, COUNT(*) links,
           SUM(CASE WHEN status='EXACT' THEN 1 ELSE 0 END) exact
    FROM unit_type_building_links`);
  const resolution = await q(`
    SELECT COUNT(*) complexes,
           SUM(physical_units) physical_units,
           SUM(building_linked_units) building_linked,
           SUM(exact_variant_building) exact_variant_building,
           SUM(exact_single_building) exact_single_building,
           SUM(exclusive_group_only) exclusive_group_only,
           SUM(ambiguous_type) ambiguous_type,
           SUM(ambiguous_building) ambiguous_building,
           SUM(no_canonical_type) no_canonical_type,
           SUM(no_building_identity) no_building_identity,
           SUM(public_exact_links) public_exact_links
    FROM unit_building_resolution_stats`);
  const geom = await q(`
    SELECT COUNT(*) n,
           SUM(CASE WHEN geometry_status='EXACT_FOOTPRINT' THEN 1 ELSE 0 END) footprints
    FROM complex_building_geometry`);
  const title = await q(`SELECT title_status, title_recovery_status, COUNT(*) n FROM complex_building_checkpoint GROUP BY 1,2`);
  const inv = await q(`
    SELECT COUNT(DISTINCT complex_id) complexes,
           SUM(CASE WHEN residential_flag=1 THEN 1 ELSE 0 END) residential
    FROM complex_buildings`);
  const sido = await q(`
    SELECT m.sido, m.sido_code,
           SUM(CASE WHEN b.residential_flag=1 THEN 1 ELSE 0 END) residential,
           SUM(CASE WHEN g.geometry_status='EXACT_FOOTPRINT' THEN 1 ELSE 0 END) geometry,
           SUM(CASE WHEN b.three_d_readiness='3D_EXACT' THEN 1 ELSE 0 END) d3_exact,
           SUM(CASE WHEN b.three_d_readiness='3D_PARTIAL' THEN 1 ELSE 0 END) d3_partial,
           COUNT(DISTINCT l.complex_id) type_building
    FROM apt_complex_master m
    LEFT JOIN complex_buildings b ON b.complex_id=m.complex_id
    LEFT JOIN complex_building_geometry g ON g.building_id=b.building_id
    LEFT JOIN (SELECT DISTINCT complex_id FROM unit_type_building_links WHERE status='EXACT') l
      ON l.complex_id=m.complex_id
    GROUP BY 1,2`);
  const pilots = await q(`
    SELECT m.complex_id, m.apt_name,
           SUM(CASE WHEN b.residential_flag=1 THEN 1 ELSE 0 END) residential,
           SUM(CASE WHEN b.height_status='OFFICIAL_HEIGHT' THEN 1 ELSE 0 END) official_height,
           SUM(CASE WHEN b.height_status='FLOOR_COUNT_ONLY' THEN 1 ELSE 0 END) floor_only,
           SUM(CASE WHEN b.height_status='HEIGHT_MISSING' OR b.height_status IS NULL THEN 1 ELSE 0 END) height_missing,
           SUM(CASE WHEN g.geometry_status='EXACT_FOOTPRINT' THEN 1 ELSE 0 END) footprints,
           SUM(CASE WHEN b.three_d_readiness='3D_EXACT' THEN 1 ELSE 0 END) d3_exact,
           SUM(CASE WHEN b.three_d_readiness='3D_PARTIAL' THEN 1 ELSE 0 END) d3_partial,
           p.kapt_household_count, p.unit_household_count, p.building_household_sum,
           p.ui_safe_type_sum, p.physical_unit_count, p.displayed_exceeds_physical, p.parity_class,
           (SELECT COUNT(*) FROM unit_type_building_links l WHERE l.complex_id=m.complex_id AND l.status='EXACT') links
    FROM apt_complex_master m
    LEFT JOIN complex_buildings b ON b.complex_id=m.complex_id
    LEFT JOIN complex_building_geometry g ON g.building_id=b.building_id
    LEFT JOIN complex_building_parity p ON p.complex_id=m.complex_id
    WHERE m.complex_id IN (${PILOT_IDS.map((id) => `'${id}'`).join(",")})
    GROUP BY m.complex_id
    ORDER BY m.apt_name`);
  const report = {
    generatedAt: new Date().toISOString(),
    extras,
    national: { inventory: inv[0], height: height[0], threeD: three[0], counts, exceed, links: links[0], resolution: resolution[0], geometry: geom[0], title },
    sido: Object.fromEntries(
      sido.map((row) => [
        sidoBucket(row.sido == null ? null : String(row.sido), row.sido_code == null ? null : String(row.sido_code)),
        row,
      ]),
    ),
    pilots,
  };
  const path = join(OUT, "national-report-v2.json");
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log("wrote", path);
  return report;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const db = dbClient();
  const extras: Record<string, unknown> = { apply: APPLY, phase: PHASE };
  await phaseSchema(db);

  if (PHASE === "gis" || PHASE === "all") extras.gis = await phaseGisManifest(db);
  if (PHASE === "height" || PHASE === "all") extras.height = await phaseHeight(db);
  if (PHASE === "counts" || PHASE === "all") extras.counts = await phaseCounts(db);
  if (PHASE === "links" || PHASE === "all") extras.links = await phaseLinks(db);
  if (PHASE === "ingest" || PHASE === "all") {
    const artifact = findCompactArtifact();
    extras.ingest = artifact
      ? await ingestCompactUnitEvidence(db, artifact, APPLY)
      : { artifact: null, LOCAL_EXECUTION_REQUIRED: "YES" };
  }
  if (PHASE === "retry" || PHASE === "all") extras.retry = await phaseTitleRetry(db);
  if (PHASE === "noparcel" || PHASE === "all") extras.noparcel = await phaseNoParcel(db);
  if (PHASE === "report" || PHASE === "all") {
    extras.api = await measureApi(db);
    await writeReport(db, extras);
  }
  console.log(JSON.stringify(extras, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
