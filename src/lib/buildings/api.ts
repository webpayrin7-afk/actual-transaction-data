import type { Client } from "@libsql/client";

export type ComplexBuildingApiResponse = {
  complexId: string;
  status: string;
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

export async function loadComplexBuildingsApi(
  db: Client,
  complexId: string,
): Promise<ComplexBuildingApiResponse | null> {
  const master = await db.execute({
    sql: `SELECT complex_id FROM apt_complex_master WHERE complex_id = ?`,
    args: [complexId],
  });
  if (master.rows.length === 0) return null;

  const checkpoint = await db.execute({
    sql: `SELECT building_status, geometry_status, link_status FROM complex_building_checkpoint WHERE complex_id=?`,
    args: [complexId],
  });
  const cp = checkpoint.rows[0] as
    | { building_status?: string; geometry_status?: string; link_status?: string }
    | undefined;
  const status = String(cp?.building_status ?? "NO_SOURCE");

  const buildings = await db.execute({
    sql: `SELECT b.building_id, b.dong_label, b.household_count, b.floor_count, b.status,
                 g.representative_lat, g.representative_lng, g.centroid_lat, g.centroid_lng,
                 g.footprint_geojson, g.geometry_status
          FROM complex_buildings b
          LEFT JOIN complex_building_geometry g ON g.building_id = b.building_id
          WHERE b.complex_id = ? AND b.residential_flag = 1 AND b.status = 'EXACT'
          ORDER BY b.dong_label`,
    args: [complexId],
  });

  const links = await db.execute({
    sql: `SELECT l.building_id, l.unit_type_id, l.household_count,
                 t.exclusive_area, t.supply_area, t.supply_pyeong
          FROM unit_type_building_links l
          LEFT JOIN apt_canonical_unit_types t ON t.unit_type_id = l.unit_type_id
          WHERE l.complex_id = ? AND l.status = 'EXACT'`,
    args: [complexId],
  });

  const byBuilding = new Map<string, ComplexBuildingApiResponse["buildings"][number]["unitTypes"]>();
  for (const row of links.rows) {
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

  return {
    complexId,
    status,
    buildings: buildings.rows.map((row) => {
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
      if (row.footprint_geojson) {
        try {
          footprint = JSON.parse(String(row.footprint_geojson));
        } catch {
          footprint = null;
        }
      }
      return {
        buildingId: String(row.building_id),
        dongLabel: row.dong_label == null ? null : String(row.dong_label),
        householdCount: row.household_count == null ? null : Number(row.household_count),
        floors: row.floor_count == null ? null : Number(row.floor_count),
        lat,
        lng,
        footprint,
        unitTypes: byBuilding.get(String(row.building_id)) ?? [],
      };
    }),
  };
}
