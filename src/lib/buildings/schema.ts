import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";

const MIGRATION_DIR = "src/lib/db/migrations";
const BUILDING_MIGRATIONS = [
  "20260920_complex_buildings.sql",
  "20260921_building_geometry_3d.sql",
  "20260922_building_api_type_resolution.sql",
  "20260923_physical_household_holds.sql",
];

const EXTRA_COLUMNS: Array<{ table: string; column: string; sqlType: string }> = [
  { table: "complex_buildings", column: "height_m", sqlType: "REAL" },
  { table: "complex_buildings", column: "underground_floor_count", sqlType: "INTEGER" },
  { table: "complex_buildings", column: "structure_type", sqlType: "TEXT" },
  { table: "complex_buildings", column: "roof_type", sqlType: "TEXT" },
  { table: "complex_buildings", column: "arch_area", sqlType: "REAL" },
  { table: "complex_buildings", column: "tot_area", sqlType: "REAL" },
  { table: "complex_buildings", column: "height_status", sqlType: "TEXT" },
  { table: "complex_buildings", column: "three_d_readiness", sqlType: "TEXT" },
  { table: "complex_buildings", column: "physical_household_count", sqlType: "INTEGER" },
  { table: "complex_buildings", column: "physical_household_version", sqlType: "TEXT" },
  { table: "complex_building_geometry", column: "source_crs", sqlType: "TEXT" },
  { table: "complex_building_geometry", column: "canonical_crs", sqlType: "TEXT" },
  { table: "complex_building_geometry", column: "source_geometry_id", sqlType: "TEXT" },
  { table: "complex_building_geometry", column: "source_geometry_hash", sqlType: "TEXT" },
  { table: "complex_building_geometry", column: "bbox_min_lng", sqlType: "REAL" },
  { table: "complex_building_geometry", column: "bbox_min_lat", sqlType: "REAL" },
  { table: "complex_building_geometry", column: "bbox_max_lng", sqlType: "REAL" },
  { table: "complex_building_geometry", column: "bbox_max_lat", sqlType: "REAL" },
  { table: "complex_building_geometry", column: "footprint_original_geojson", sqlType: "TEXT" },
  { table: "complex_building_geometry", column: "footprint_display_geojson", sqlType: "TEXT" },
  { table: "complex_building_geometry", column: "display_simplify_tolerance_m", sqlType: "REAL" },
  { table: "complex_building_geometry", column: "repair_status", sqlType: "TEXT" },
  { table: "complex_building_geometry", column: "identity_status", sqlType: "TEXT" },
  { table: "complex_building_geometry", column: "area_m2", sqlType: "REAL" },
  { table: "complex_building_checkpoint", column: "title_retry_count", sqlType: "INTEGER" },
  { table: "complex_building_checkpoint", column: "title_recovery_status", sqlType: "TEXT" },
  { table: "complex_building_parity", column: "physical_unit_count", sqlType: "INTEGER" },
  { table: "complex_building_parity", column: "ui_safe_type_sum", sqlType: "INTEGER" },
  { table: "complex_building_parity", column: "exclusive_group_sum", sqlType: "INTEGER" },
  { table: "complex_building_parity", column: "displayed_exceeds_physical", sqlType: "INTEGER" },
];

async function execIgnore(db: Client, sql: string): Promise<void> {
  try {
    await db.execute(sql);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/duplicate column|already exists|duplicate index/i.test(msg)) return;
    throw error;
  }
}

async function ensureColumn(
  db: Client,
  table: string,
  column: string,
  sqlType: string,
): Promise<void> {
  const info = await db.execute(`PRAGMA table_info(${table})`);
  const exists = info.rows.some((row) => String(row.name) === column);
  if (exists) return;
  await execIgnore(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
}

function sqlChunks(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

export async function ensureBuildingSchema(db: Client): Promise<void> {
  const dir = join(process.cwd(), MIGRATION_DIR);
  const available = new Set(readdirSync(dir));
  for (const file of BUILDING_MIGRATIONS) {
    if (!available.has(file)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    for (const chunk of sqlChunks(sql)) {
      await execIgnore(db, chunk);
    }
  }
  for (const col of EXTRA_COLUMNS) {
    await ensureColumn(db, col.table, col.column, col.sqlType);
  }
  await execIgnore(
    db,
    `CREATE INDEX IF NOT EXISTS idx_cb_height ON complex_buildings (height_status)`,
  );
  await execIgnore(
    db,
    `CREATE INDEX IF NOT EXISTS idx_cb_3d ON complex_buildings (three_d_readiness)`,
  );
  await execIgnore(
    db,
    `CREATE INDEX IF NOT EXISTS idx_utbl_complex_status ON unit_type_building_links (complex_id, status)`,
  );
  await execIgnore(
    db,
    `CREATE INDEX IF NOT EXISTS idx_uthc_complex ON unit_type_household_counts (complex_id)`,
  );
  await execIgnore(
    db,
    `CREATE INDEX IF NOT EXISTS idx_cb_api ON complex_buildings (complex_id, residential_flag, status)`,
  );
}
