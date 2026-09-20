import type { Client } from "@libsql/client";
import type { BuildingRecord } from "./types";
import type { TypeBuildingLink } from "./type-links";
import type { TypeBuildingResolutionStats } from "./type-links";

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export type UpsertStats = {
  inserted: number;
  unchanged: number;
  skippedPositive: number;
  updatedFill: number;
};

function sameBuilding(a: Record<string, unknown>, b: BuildingRecord): boolean {
  return (
    String(a.complex_id) === b.complexId &&
    String(a.official_building_key) === b.officialBuildingKey &&
    String(a.mgm_bldrgst_pk ?? "") === String(b.mgmBldrgstPk ?? "") &&
    String(a.dong_label ?? "") === String(b.dongLabel ?? "") &&
    String(a.dong_label_status) === b.dongLabelStatus &&
    Number(a.residential_flag ?? 0) === (b.residentialFlag ? 1 : 0) &&
    Number(a.household_count ?? -1) === Number(b.householdCount ?? -1) &&
    Number(a.floor_count ?? -1) === Number(b.floorCount ?? -1) &&
    String(a.status) === b.status
  );
}

export async function upsertBuildings(
  db: Client,
  rows: BuildingRecord[],
): Promise<UpsertStats> {
  const stats: UpsertStats = { inserted: 0, unchanged: 0, skippedPositive: 0, updatedFill: 0 };
  if (rows.length === 0) return stats;
  const ts = nowIso();
  const complexId = rows[0].complexId;
  const existing = await db.execute({
    sql: `SELECT * FROM complex_buildings WHERE complex_id = ?`,
    args: [complexId],
  });
  const byId = new Map<string, Record<string, unknown>>();
  const byKey = new Map<string, Record<string, unknown>>();
  for (const cur of existing.rows as Record<string, unknown>[]) {
    byId.set(String(cur.building_id), cur);
    byKey.set(String(cur.official_building_key), cur);
  }
  const keys = rows.map((row) => row.officialBuildingKey);
  if (keys.length) {
    const others = await db.execute({
      sql: `SELECT official_building_key, complex_id FROM complex_buildings
            WHERE official_building_key IN (${keys.map(() => "?").join(",")})
              AND complex_id != ?`,
      args: [...keys, complexId],
    });
    const taken = new Set(others.rows.map((r) => String(r.official_building_key)));
    rows = rows.filter((row) => {
      if (!taken.has(row.officialBuildingKey)) return true;
      stats.skippedPositive += 1;
      return false;
    });
  }
  const inserts: { sql: string; args: unknown[] }[] = [];
  for (const row of rows) {
    const cur = byId.get(row.buildingId) ?? byKey.get(row.officialBuildingKey);
    if (cur) {
      if (sameBuilding(cur, row)) {
        stats.unchanged += 1;
        continue;
      }
      const curHh = cur.household_count == null ? null : Number(cur.household_count);
      if (curHh != null && row.householdCount != null && curHh !== row.householdCount) {
        stats.skippedPositive += 1;
        continue;
      }
      if (String(cur.status) === "EXACT" && row.status !== "EXACT") {
        stats.skippedPositive += 1;
        continue;
      }
      await db.execute({
        sql: `UPDATE complex_buildings SET
                dong_label = COALESCE(dong_label, ?),
                dong_label_status = CASE WHEN dong_label_status = 'EXACT_DONG_LABEL' THEN dong_label_status ELSE ? END,
                building_name = COALESCE(building_name, ?),
                main_usage = COALESCE(main_usage, ?),
                main_usage_code = COALESCE(main_usage_code, ?),
                household_count = COALESCE(household_count, ?),
                floor_count = COALESCE(floor_count, ?),
                height_m = COALESCE(height_m, ?),
                underground_floor_count = COALESCE(underground_floor_count, ?),
                structure_type = COALESCE(structure_type, ?),
                roof_type = COALESCE(roof_type, ?),
                arch_area = COALESCE(arch_area, ?),
                tot_area = COALESCE(tot_area, ?),
                height_status = COALESCE(height_status, ?),
                three_d_readiness = COALESCE(three_d_readiness, ?),
                updated_at = ?
              WHERE building_id = ?`,
        args: [
          row.dongLabel,
          row.dongLabelStatus,
          row.buildingName,
          row.mainUsage,
          row.mainUsageCode,
          row.householdCount,
          row.floorCount,
          row.heightM,
          row.undergroundFloorCount,
          row.structureType,
          row.roofType,
          row.archArea,
          row.totArea,
          row.heightStatus,
          row.threeDReadiness,
          ts,
          String(cur.building_id),
        ],
      });
      stats.updatedFill += 1;
      continue;
    }
    inserts.push({
      sql: `INSERT OR IGNORE INTO complex_buildings (
              building_id, complex_id, official_building_key, mgm_bldrgst_pk,
              dong_label, dong_label_status, building_name, main_usage, main_usage_code,
              main_atch_type, residential_flag, household_count, floor_count,
              height_m, underground_floor_count, structure_type, roof_type, arch_area, tot_area,
              height_status, three_d_readiness,
              source, source_key, source_as_of, status, provenance_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.buildingId,
        row.complexId,
        row.officialBuildingKey,
        row.mgmBldrgstPk,
        row.dongLabel,
        row.dongLabelStatus,
        row.buildingName,
        row.mainUsage,
        row.mainUsageCode,
        row.mainAtchType,
        row.residentialFlag ? 1 : 0,
        row.householdCount,
        row.floorCount,
        row.heightM,
        row.undergroundFloorCount,
        row.structureType,
        row.roofType,
        row.archArea,
        row.totArea,
        row.heightStatus,
        row.threeDReadiness,
        row.source,
        row.sourceKey,
        row.sourceAsOf,
        row.status,
        json({}),
        ts,
        ts,
      ],
    });
    stats.inserted += 1;
  }
  for (let i = 0; i < inserts.length; i += 40) {
    await db.batch(inserts.slice(i, i + 40) as never, "write");
  }
  return stats;
}

export async function upsertTypeStats(
  db: Client,
  rows: Array<{
    complexId: string;
    unitTypeId: string;
    householdCount: number | null;
    source: string;
    sourceAsOf: string;
    status: string;
  }>,
): Promise<UpsertStats> {
  const stats: UpsertStats = { inserted: 0, unchanged: 0, skippedPositive: 0, updatedFill: 0 };
  const ts = nowIso();
  for (const row of rows) {
    const existing = await db.execute({
      sql: `SELECT household_count, status, source FROM unit_type_stats WHERE complex_id=? AND unit_type_id=?`,
      args: [row.complexId, row.unitTypeId],
    });
    if (existing.rows.length > 0) {
      const cur = existing.rows[0];
      const curHh = cur.household_count == null ? null : Number(cur.household_count);
      if (curHh === row.householdCount && String(cur.status) === row.status) {
        stats.unchanged += 1;
        continue;
      }
      if (curHh != null && row.householdCount != null && curHh !== row.householdCount) {
        stats.skippedPositive += 1;
        continue;
      }
      stats.unchanged += 1;
      continue;
    }
    await db.execute({
      sql: `INSERT INTO unit_type_stats (
              complex_id, unit_type_id, household_count, source, source_as_of, status,
              provenance_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      args: [
        row.complexId,
        row.unitTypeId,
        row.householdCount,
        row.source,
        row.sourceAsOf,
        row.status,
        ts,
        ts,
      ],
    });
    stats.inserted += 1;
  }
  return stats;
}

export async function upsertTypeBuildingLinks(
  db: Client,
  complexId: string,
  links: TypeBuildingLink[],
): Promise<UpsertStats> {
  const stats: UpsertStats = { inserted: 0, unchanged: 0, skippedPositive: 0, updatedFill: 0 };
  const exact = links.filter((link) => link.status === "EXACT");
  if (exact.length === 0) return stats;
  const ts = nowIso();
  const existing = await db.execute({
    sql: `SELECT unit_type_id, building_id, household_count, status
          FROM unit_type_building_links WHERE complex_id=?`,
    args: [complexId],
  });
  const seen = new Map<string, { household_count: unknown; status: unknown }>();
  for (const row of existing.rows) {
    seen.set(`${row.unit_type_id}\t${row.building_id}`, {
      household_count: row.household_count,
      status: row.status,
    });
  }
  const inserts: { sql: string; args: unknown[] }[] = [];
  for (const link of exact) {
    const cur = seen.get(`${link.unitTypeId}\t${link.buildingId}`);
    if (cur) {
      const curHh = cur.household_count == null ? null : Number(cur.household_count);
      if (curHh === link.householdCount && String(cur.status) === link.status) {
        stats.unchanged += 1;
        continue;
      }
      if (curHh != null && curHh !== link.householdCount) {
        stats.skippedPositive += 1;
        continue;
      }
      stats.unchanged += 1;
      continue;
    }
    inserts.push({
      sql: `INSERT INTO unit_type_building_links (
              complex_id, unit_type_id, building_id, household_count, source, source_key,
              confidence, status, source_as_of, provenance_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        complexId,
        link.unitTypeId,
        link.buildingId,
        link.householdCount,
        link.source,
        link.sourceKey,
        link.confidence,
        link.status,
        link.sourceAsOf,
        json({ resolutionStatus: link.resolutionStatus }),
        ts,
        ts,
      ],
    });
    stats.inserted += 1;
  }
  for (let i = 0; i < inserts.length; i += 40) {
    await db.batch(inserts.slice(i, i + 40) as never, "write");
  }
  return stats;
}

export async function upsertParity(
  db: Client,
  row: {
    complexId: string;
    kaptHousehold: number | null;
    unitHousehold: number | null;
    typeHouseholdSum: number | null;
    buildingHouseholdSum: number | null;
    parityClass: string;
    detail: string;
    sourceAsOf: string;
    physicalUnitCount?: number | null;
    uiSafeTypeSum?: number | null;
    exclusiveGroupSum?: number | null;
    displayedExceedsPhysical?: boolean;
  },
): Promise<void> {
  const ts = nowIso();
  await db.execute({
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
      row.complexId,
      row.kaptHousehold,
      row.unitHousehold,
      row.typeHouseholdSum,
      row.buildingHouseholdSum,
      row.parityClass,
      row.detail,
      row.sourceAsOf,
      ts,
      row.physicalUnitCount ?? null,
      row.uiSafeTypeSum ?? null,
      row.exclusiveGroupSum ?? null,
      row.displayedExceedsPhysical ? 1 : 0,
    ],
  });
}

export async function upsertCheckpoint(
  db: Client,
  row: {
    complexId: string;
    parcelKey?: string;
    pnu?: string;
    priority?: number;
    titleStatus: string;
    buildingStatus: string;
    geometryStatus: string;
    linkStatus: string;
    titleTotalCount?: number;
    residentialCount?: number;
    apiCalls?: number;
    detail?: string;
    titleRetryCount?: number;
    titleRecoveryStatus?: string;
  },
): Promise<void> {
  const ts = nowIso();
  await db.execute({
    sql: `INSERT INTO complex_building_checkpoint (
            complex_id, parcel_key, pnu, priority, title_status, building_status,
            geometry_status, link_status, title_total_count, residential_count,
            api_calls, detail, title_retry_count, title_recovery_status, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(complex_id) DO UPDATE SET
            parcel_key=excluded.parcel_key,
            pnu=excluded.pnu,
            priority=excluded.priority,
            title_status=excluded.title_status,
            building_status=excluded.building_status,
            geometry_status=excluded.geometry_status,
            link_status=excluded.link_status,
            title_total_count=excluded.title_total_count,
            residential_count=excluded.residential_count,
            api_calls=excluded.api_calls,
            detail=excluded.detail,
            title_retry_count=COALESCE(excluded.title_retry_count, complex_building_checkpoint.title_retry_count),
            title_recovery_status=COALESCE(NULLIF(excluded.title_recovery_status, ''), complex_building_checkpoint.title_recovery_status),
            updated_at=excluded.updated_at`,
    args: [
      row.complexId,
      row.parcelKey ?? "",
      row.pnu ?? "",
      row.priority ?? 9,
      row.titleStatus,
      row.buildingStatus,
      row.geometryStatus,
      row.linkStatus,
      row.titleTotalCount ?? 0,
      row.residentialCount ?? 0,
      row.apiCalls ?? 0,
      row.detail ?? "",
      row.titleRetryCount ?? 0,
      row.titleRecoveryStatus ?? "",
      ts,
    ],
  });
}

export async function upsertHouseholdCounts(
  db: Client,
  complexId: string,
  types: Array<{
    unitTypeId: string;
    exclusiveCents: number;
    supplyCents: number | null;
    householdCount: number | null;
    countStatus: string;
    uiSafe: boolean;
    source: string;
    provenance: Record<string, unknown>;
  }>,
  groups: Array<{
    exclusiveCents: number;
    householdCount: number | null;
    variantCount: number;
    countStatus: string;
    source: string;
    provenance: Record<string, unknown>;
  }>,
  sourceAsOf: string,
): Promise<UpsertStats> {
  const stats: UpsertStats = { inserted: 0, unchanged: 0, skippedPositive: 0, updatedFill: 0 };
  const ts = nowIso();
  await db.execute({
    sql: `DELETE FROM unit_type_household_counts WHERE complex_id=?`,
    args: [complexId],
  });
  await db.execute({
    sql: `DELETE FROM unit_exclusive_group_counts WHERE complex_id=?`,
    args: [complexId],
  });
  const typeInserts = types.map((row) => ({
    sql: `INSERT INTO unit_type_household_counts (
            complex_id, unit_type_id, exclusive_cents, supply_cents, household_count,
            count_status, ui_safe, source, source_as_of, provenance_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      complexId,
      row.unitTypeId,
      row.exclusiveCents,
      row.supplyCents,
      row.householdCount,
      row.countStatus,
      row.uiSafe ? 1 : 0,
      row.source,
      sourceAsOf,
      json(row.provenance),
      ts,
      ts,
    ],
  }));
  for (let i = 0; i < typeInserts.length; i += 40) {
    await db.batch(typeInserts.slice(i, i + 40) as never, "write");
  }
  stats.inserted += types.length;
  const groupInserts = groups.map((row) => ({
    sql: `INSERT INTO unit_exclusive_group_counts (
            complex_id, exclusive_cents, household_count, variant_count, count_status,
            source, source_as_of, provenance_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      complexId,
      row.exclusiveCents,
      row.householdCount,
      row.variantCount,
      row.countStatus,
      row.source,
      sourceAsOf,
      json(row.provenance),
      ts,
    ],
  }));
  for (let i = 0; i < groupInserts.length; i += 40) {
    await db.batch(groupInserts.slice(i, i + 40) as never, "write");
  }
  return stats;
}

export async function upsertGeometryRow(
  db: Client,
  row: {
    buildingId: string;
    geometrySource: string;
    centroidLat: number | null;
    centroidLng: number | null;
    footprintGeojson: string | null;
    footprintOriginalGeojson: string | null;
    footprintDisplayGeojson: string | null;
    sourceObjectId: string | null;
    sourceGeometryId: string | null;
    sourceGeometryHash: string | null;
    sourceCrs: string | null;
    canonicalCrs: string;
    sourceVersion: string;
    sourceAsOf: string;
    geometryStatus: string;
    identityStatus: string;
    repairStatus: string;
    areaM2: number | null;
    bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number } | null;
    displaySimplifyToleranceM: number | null;
    provenance: Record<string, unknown>;
  },
): Promise<void> {
  const ts = nowIso();
  await db.execute({
    sql: `INSERT INTO complex_building_geometry (
            building_id, geometry_source, centroid_lat, centroid_lng,
            representative_lat, representative_lng, footprint_geojson,
            source_object_id, source_version, source_as_of, geometry_status,
            provenance_json, created_at, updated_at,
            source_crs, canonical_crs, source_geometry_id, source_geometry_hash,
            bbox_min_lng, bbox_min_lat, bbox_max_lng, bbox_max_lat,
            footprint_original_geojson, footprint_display_geojson,
            display_simplify_tolerance_m, repair_status, identity_status, area_m2
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(building_id) DO UPDATE SET
            geometry_source=excluded.geometry_source,
            centroid_lat=excluded.centroid_lat,
            centroid_lng=excluded.centroid_lng,
            representative_lat=excluded.representative_lat,
            representative_lng=excluded.representative_lng,
            footprint_geojson=excluded.footprint_geojson,
            source_object_id=excluded.source_object_id,
            source_version=excluded.source_version,
            source_as_of=excluded.source_as_of,
            geometry_status=excluded.geometry_status,
            provenance_json=excluded.provenance_json,
            source_crs=excluded.source_crs,
            canonical_crs=excluded.canonical_crs,
            source_geometry_id=excluded.source_geometry_id,
            source_geometry_hash=excluded.source_geometry_hash,
            bbox_min_lng=excluded.bbox_min_lng,
            bbox_min_lat=excluded.bbox_min_lat,
            bbox_max_lng=excluded.bbox_max_lng,
            bbox_max_lat=excluded.bbox_max_lat,
            footprint_original_geojson=excluded.footprint_original_geojson,
            footprint_display_geojson=excluded.footprint_display_geojson,
            display_simplify_tolerance_m=excluded.display_simplify_tolerance_m,
            repair_status=excluded.repair_status,
            identity_status=excluded.identity_status,
            area_m2=excluded.area_m2,
            updated_at=excluded.updated_at`,
    args: [
      row.buildingId,
      row.geometrySource,
      row.centroidLat,
      row.centroidLng,
      row.centroidLat,
      row.centroidLng,
      row.footprintGeojson,
      row.sourceObjectId,
      row.sourceVersion,
      row.sourceAsOf,
      row.geometryStatus,
      json(row.provenance),
      ts,
      ts,
      row.sourceCrs,
      row.canonicalCrs,
      row.sourceGeometryId,
      row.sourceGeometryHash,
      row.bbox?.minLng ?? null,
      row.bbox?.minLat ?? null,
      row.bbox?.maxLng ?? null,
      row.bbox?.maxLat ?? null,
      row.footprintOriginalGeojson,
      row.footprintDisplayGeojson,
      row.displaySimplifyToleranceM,
      row.repairStatus,
      row.identityStatus,
      row.areaM2,
    ],
  });
}

export async function upsertGisManifest(
  db: Client,
  row: {
    manifestId: string;
    sourceDataset: string;
    sourceVersion: string;
    sourceDate: string;
    checksum: string;
    crs: string;
    featureCount: number | null;
    validGeometryCount: number | null;
    licenseAttribution: string;
    wfsFallbackUsed: boolean;
    acquisitionStatus: string;
    localPath: string;
    detail: string;
  },
): Promise<void> {
  const ts = nowIso();
  await db.execute({
    sql: `INSERT INTO gis_building_source_manifest (
            manifest_id, source_dataset, source_version, source_date, checksum, crs,
            feature_count, valid_geometry_count, license_attribution, wfs_fallback_used,
            acquisition_status, local_path, detail, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(manifest_id) DO UPDATE SET
            source_version=excluded.source_version,
            checksum=excluded.checksum,
            crs=excluded.crs,
            feature_count=excluded.feature_count,
            valid_geometry_count=excluded.valid_geometry_count,
            acquisition_status=excluded.acquisition_status,
            local_path=excluded.local_path,
            detail=excluded.detail`,
    args: [
      row.manifestId,
      row.sourceDataset,
      row.sourceVersion,
      row.sourceDate,
      row.checksum,
      row.crs,
      row.featureCount,
      row.validGeometryCount,
      row.licenseAttribution,
      row.wfsFallbackUsed ? 1 : 0,
      row.acquisitionStatus,
      row.localPath,
      row.detail,
      ts,
    ],
  });
}

export async function upsertCompactExtractorSpec(
  db: Client,
  spec: {
    specId: string;
    required: boolean;
    artifactName: string;
    expectedSize: string;
    specJson: string;
  },
): Promise<void> {
  const ts = nowIso();
  await db.execute({
    sql: `INSERT INTO compact_extractor_spec (
            spec_id, required, artifact_name, expected_size, spec_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(spec_id) DO UPDATE SET
            required=excluded.required,
            artifact_name=excluded.artifact_name,
            expected_size=excluded.expected_size,
            spec_json=excluded.spec_json,
            updated_at=excluded.updated_at`,
    args: [spec.specId, spec.required ? 1 : 0, spec.artifactName, spec.expectedSize, spec.specJson, ts],
  });
}

export async function refreshThreeDReadiness(db: Client): Promise<void> {
  await db.execute(`
    UPDATE complex_buildings
    SET three_d_readiness = CASE
      WHEN EXISTS (
        SELECT 1 FROM complex_building_geometry g
        WHERE g.building_id = complex_buildings.building_id
          AND g.geometry_status = 'EXACT_FOOTPRINT'
      ) THEN CASE
        WHEN height_status = 'OFFICIAL_HEIGHT' THEN '3D_EXACT'
        WHEN height_status = 'FLOOR_COUNT_ONLY' THEN '3D_PARTIAL'
        ELSE 'FOOTPRINT_ONLY'
      END
      ELSE 'NO_GEOMETRY'
    END
    WHERE residential_flag = 1
  `);
}

export async function upsertResolutionStats(
  db: Client,
  complexId: string,
  stats: TypeBuildingResolutionStats,
  source: string,
  sourceAsOf: string,
): Promise<void> {
  const ts = nowIso();
  await db.execute({
    sql: `INSERT INTO unit_building_resolution_stats (
            complex_id, physical_units, building_linked_units,
            exact_variant_building, exact_single_building, exclusive_group_only,
            ambiguous_type, ambiguous_building, no_canonical_type, no_building_identity,
            public_exact_links, source, source_as_of, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(complex_id) DO UPDATE SET
            physical_units=excluded.physical_units,
            building_linked_units=excluded.building_linked_units,
            exact_variant_building=excluded.exact_variant_building,
            exact_single_building=excluded.exact_single_building,
            exclusive_group_only=excluded.exclusive_group_only,
            ambiguous_type=excluded.ambiguous_type,
            ambiguous_building=excluded.ambiguous_building,
            no_canonical_type=excluded.no_canonical_type,
            no_building_identity=excluded.no_building_identity,
            public_exact_links=excluded.public_exact_links,
            source=excluded.source,
            source_as_of=excluded.source_as_of,
            updated_at=excluded.updated_at`,
    args: [
      complexId,
      stats.physicalUnits,
      stats.buildingLinkedUnits,
      stats.exactVariantBuilding,
      stats.exactSingleBuilding,
      stats.exclusiveGroupOnly,
      stats.ambiguousType,
      stats.ambiguousBuilding,
      stats.noCanonicalType,
      stats.noBuildingIdentity,
      stats.publicExactLinks,
      source,
      sourceAsOf,
      ts,
    ],
  });
}

export async function upsertApiSnapshot(
  db: Client,
  complexId: string,
  payload: unknown,
): Promise<void> {
  const ts = nowIso();
  const payloadJson = JSON.stringify(payload ?? {});
  await db.execute({
    sql: `INSERT INTO complex_building_api_snapshot (
            complex_id, payload_json, payload_bytes, building_count, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(complex_id) DO UPDATE SET
            payload_json=excluded.payload_json,
            payload_bytes=excluded.payload_bytes,
            building_count=excluded.building_count,
            updated_at=excluded.updated_at`,
    args: [
      complexId,
      payloadJson,
      Buffer.byteLength(payloadJson, "utf8"),
      Array.isArray((payload as { buildings?: unknown[] } | null)?.buildings)
        ? (payload as { buildings: unknown[] }).buildings.length
        : 0,
      ts,
    ],
  });
}

