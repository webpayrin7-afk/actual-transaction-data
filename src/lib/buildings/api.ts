import type { Client } from "@libsql/client";

export type ComplexBuildingApiResponse = {
  complexId: string;
  status: string;
  liveSourceCalls: 0;
  buildingInventory: {
    status: string;
    residentialCount: number;
    buildings: Array<{
      buildingId: string;
      dongLabel: string | null;
      dongLabelStatus?: string;
      householdCount: number | null;
      floors: number | null;
      heightM: number | null;
      heightStatus: string | null;
    }>;
  };
  geometry: {
    status: string;
    source: string | null;
    matchedCount: number;
  };
  threeDReadiness: {
    status: string;
    exact: number;
    partial: number;
    footprintOnly: number;
    noGeometry: number;
  };
  typeStats: {
    status: string;
    uiSafe: boolean;
    rows: Array<{
      unitTypeId: string;
      exclusiveCents: number;
      householdCount: number | null;
      countStatus: string;
      uiSafe: boolean;
    }>;
  };
  typeBuildingLinks: {
    status: string;
    count: number;
  };
  buildings: Array<{
    buildingId: string;
    dongLabel: string | null;
    householdCount: number | null;
    floors: number | null;
    lat: number | null;
    lng: number | null;
    footprint: unknown;
    unitTypes: Array<{
      unitTypeId: string;
      exclusiveArea: number | null;
      supplyArea: number | null;
      supplyPyeong: number | null;
      householdCount: number | null;
    }>;
  }>;
};

function assemble(
  complexId: string,
  cp: { building_status?: string; geometry_status?: string; link_status?: string } | undefined,
  buildingRows: Record<string, unknown>[],
  linkRows: Record<string, unknown>[],
  typeRows: Record<string, unknown>[],
): ComplexBuildingApiResponse {
  const status = String(cp?.building_status ?? "NO_SOURCE");
  const byBuilding = new Map<string, ComplexBuildingApiResponse["buildings"][number]["unitTypes"]>();
  for (const row of linkRows) {
    const id = String(row.building_id);
    const list = byBuilding.get(id) ?? [];
    list.push({
      unitTypeId: String(row.unit_type_id),
      exclusiveArea: row.exclusive_area == null ? null : Number(row.exclusive_area),
      supplyArea: row.supply_area == null ? null : Number(row.supply_area),
      supplyPyeong: row.supply_pyeong == null ? null : Number(row.supply_pyeong),
      householdCount: row.household_count == null ? null : Number(row.household_count),
    });
    byBuilding.set(id, list);
  }

  const mapped = buildingRows.map((row) => {
    const lat =
      row.representative_lat != null
        ? Number(row.representative_lat)
        : row.centroid_lat != null
          ? Number(row.centroid_lat)
          : null;
    const lng =
      row.representative_lng != null
        ? Number(row.representative_lng)
        : row.centroid_lng != null
          ? Number(row.centroid_lng)
          : null;
    let footprint: unknown = null;
    const raw = row.footprint_display_geojson || row.footprint_geojson;
    if (raw) {
      try {
        footprint = JSON.parse(String(raw));
      } catch {
        footprint = null;
      }
    }
    return {
      buildingId: String(row.building_id),
      dongLabel: row.dong_label == null ? null : String(row.dong_label),
      dongLabelStatus: row.dong_label_status == null ? undefined : String(row.dong_label_status),
      householdCount: row.household_count == null ? null : Number(row.household_count),
      floors: row.floor_count == null ? null : Number(row.floor_count),
      heightM: row.height_m == null ? null : Number(row.height_m),
      heightStatus: row.height_status == null ? null : String(row.height_status),
      threeD: row.three_d_readiness == null ? "NO_GEOMETRY" : String(row.three_d_readiness),
      lat,
      lng,
      footprint,
      geometryStatus: row.geometry_status == null ? "NO_GEOMETRY" : String(row.geometry_status),
      unitTypes: byBuilding.get(String(row.building_id)) ?? [],
    };
  });

  const geomMatched = mapped.filter((b) => b.geometryStatus === "EXACT_FOOTPRINT").length;
  const typeStatusRows = typeRows.map((row) => ({
    unitTypeId: String(row.unit_type_id),
    exclusiveCents: Number(row.exclusive_cents),
    householdCount: row.household_count == null ? null : Number(row.household_count),
    countStatus: String(row.count_status),
    uiSafe: Number(row.ui_safe) === 1,
  }));
  const anySafe = typeStatusRows.some((row) => row.uiSafe);
  const typeStatsStatus = typeStatusRows.length === 0
    ? "NO_SOURCE"
    : anySafe && !typeStatusRows.every((row) => row.uiSafe)
      ? "MIXED"
      : anySafe
        ? "UI_SAFE"
        : "NOT_UI_SAFE";

  return {
    complexId,
    status,
    liveSourceCalls: 0,
    buildingInventory: {
      status,
      residentialCount: mapped.length,
      buildings: mapped.map((b) => ({
        buildingId: b.buildingId,
        dongLabel: b.dongLabel,
        dongLabelStatus: b.dongLabelStatus,
        householdCount: b.householdCount,
        floors: b.floors,
        heightM: b.heightM,
        heightStatus: b.heightStatus,
      })),
    },
    geometry: {
      status: geomMatched > 0 ? "EXACT_FOOTPRINT" : String(cp?.geometry_status ?? "NO_GEOMETRY"),
      source: geomMatched > 0 ? "국토교통부_GIS건물통합정보" : null,
      matchedCount: geomMatched,
    },
    threeDReadiness: {
      status: geomMatched > 0 ? "PARTIAL" : "NO_GEOMETRY",
      exact: mapped.filter((b) => b.threeD === "3D_EXACT").length,
      partial: mapped.filter((b) => b.threeD === "3D_PARTIAL").length,
      footprintOnly: mapped.filter((b) => b.threeD === "FOOTPRINT_ONLY").length,
      noGeometry: mapped.filter((b) => b.threeD === "NO_GEOMETRY").length,
    },
    typeStats: {
      status: typeStatsStatus,
      uiSafe: typeStatsStatus === "UI_SAFE",
      rows: typeStatusRows,
    },
    typeBuildingLinks: {
      status: String(cp?.link_status ?? (linkRows.length ? "EXACT" : "NO_SOURCE")),
      count: linkRows.length,
    },
    buildings: mapped.map((b) => ({
      buildingId: b.buildingId,
      dongLabel: b.dongLabel,
      householdCount: b.householdCount,
      floors: b.floors,
      lat: b.lat,
      lng: b.lng,
      footprint: b.footprint,
      unitTypes: b.unitTypes,
    })),
  };
}

export async function loadComplexBuildingsApiLive(
  db: Client,
  complexId: string,
): Promise<ComplexBuildingApiResponse | null> {
  const [master, buildings, links, typeRows] = await Promise.all([
    db.execute({
      sql: `SELECT m.complex_id, c.building_status, c.geometry_status, c.link_status
            FROM apt_complex_master m
            LEFT JOIN complex_building_checkpoint c ON c.complex_id = m.complex_id
            WHERE m.complex_id = ?`,
      args: [complexId],
    }),
    db.execute({
      sql: `SELECT b.building_id, b.dong_label, b.dong_label_status, b.household_count, b.floor_count,
                   b.height_m, b.height_status, b.three_d_readiness, b.status,
                   g.representative_lat, g.representative_lng, g.centroid_lat, g.centroid_lng,
                   g.footprint_display_geojson, g.footprint_geojson, g.geometry_status
            FROM complex_buildings b
            LEFT JOIN complex_building_geometry g ON g.building_id = b.building_id
            WHERE b.complex_id = ? AND b.residential_flag = 1 AND b.status = 'EXACT'
            ORDER BY b.dong_label`,
      args: [complexId],
    }),
    db.execute({
      sql: `SELECT l.building_id, l.unit_type_id, l.household_count,
                   t.exclusive_area, t.supply_area, t.supply_pyeong
            FROM unit_type_building_links l
            LEFT JOIN apt_canonical_unit_types t ON t.unit_type_id = l.unit_type_id
            WHERE l.complex_id = ? AND l.status = 'EXACT'`,
      args: [complexId],
    }),
    db.execute({
      sql: `SELECT unit_type_id, exclusive_cents, household_count, count_status, ui_safe
            FROM unit_type_household_counts WHERE complex_id=?`,
      args: [complexId],
    }),
  ]);
  if (master.rows.length === 0) return null;
  return assemble(
    complexId,
    master.rows[0] as { building_status?: string; geometry_status?: string; link_status?: string },
    buildings.rows as Record<string, unknown>[],
    links.rows as Record<string, unknown>[],
    typeRows.rows as Record<string, unknown>[],
  );
}

export async function loadComplexBuildingsApi(
  db: Client,
  complexId: string,
  opts: { skipSnapshot?: boolean } = {},
): Promise<ComplexBuildingApiResponse | null> {
  if (!opts.skipSnapshot) {
    try {
      const snap = await db.execute({
        sql: `SELECT payload_json FROM complex_building_api_snapshot WHERE complex_id=?`,
        args: [complexId],
      });
      if (snap.rows[0]?.payload_json) {
        return JSON.parse(String(snap.rows[0].payload_json)) as ComplexBuildingApiResponse;
      }
    } catch {
      // Snapshot table may not exist yet; fall through to live reads.
    }
  }
  return loadComplexBuildingsApiLive(db, complexId);
}
