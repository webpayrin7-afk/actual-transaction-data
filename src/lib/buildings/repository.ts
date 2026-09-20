import type { Client } from "@libsql/client";
import type { BuildingRecord } from "./types";
import type { TypeBuildingLink } from "./type-links";

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
          ts,
          String(cur.building_id),
        ],
      });
      stats.updatedFill += 1;
      continue;
    }
    inserts.push({
      sql: `INSERT INTO complex_buildings (
              building_id, complex_id, official_building_key, mgm_bldrgst_pk,
              dong_label, dong_label_status, building_name, main_usage, main_usage_code,
              main_atch_type, residential_flag, household_count, floor_count,
              source, source_key, source_as_of, status, provenance_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
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
  },
): Promise<void> {
  const ts = nowIso();
  await db.execute({
    sql: `INSERT INTO complex_building_parity (
            complex_id, kapt_household_count, unit_household_count, type_household_sum,
            building_household_sum, parity_class, detail, source_as_of, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(complex_id) DO UPDATE SET
            kapt_household_count=excluded.kapt_household_count,
            unit_household_count=excluded.unit_household_count,
            type_household_sum=excluded.type_household_sum,
            building_household_sum=excluded.building_household_sum,
            parity_class=excluded.parity_class,
            detail=excluded.detail,
            source_as_of=excluded.source_as_of,
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
  },
): Promise<void> {
  const ts = nowIso();
  await db.execute({
    sql: `INSERT INTO complex_building_checkpoint (
            complex_id, parcel_key, pnu, priority, title_status, building_status,
            geometry_status, link_status, title_total_count, residential_count,
            api_calls, detail, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      ts,
    ],
  });
}
