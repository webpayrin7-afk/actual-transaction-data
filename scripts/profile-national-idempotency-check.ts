#!/usr/bin/env npx tsx
/**
 * Idempotency spot-check: decideFills with empty bags on filled profiles must yield 0 fills.
 */
import { decideFills, openDb, type ProfileSnap } from "./profile-national-lib";

async function main() {
  const db = openDb();
  const named = await db.execute({
    sql: `SELECT m.complex_id, m.apt_name,
            p.household_count, p.building_count, p.approval_date, p.max_floor,
            p.far_ratio, p.bcr_ratio, p.heating_type, p.parking_total, p.parking_per_household,
            p.source, p.source_version, p.raw_meta_json
          FROM apt_complex_master m
          JOIN apt_complex_profile p ON p.complex_id = m.complex_id
          WHERE m.apt_name LIKE '%잠실엘스%' OR m.apt_name LIKE '%시범한양%'
          LIMIT 10`,
    args: [],
  });
  const busan = await db.execute({
    sql: `SELECT m.complex_id, m.apt_name,
            p.household_count, p.building_count, p.approval_date, p.max_floor,
            p.far_ratio, p.bcr_ratio, p.heating_type, p.parking_total, p.parking_per_household,
            p.source, p.source_version, p.raw_meta_json
          FROM apt_complex_master m
          JOIN apt_complex_profile p ON p.complex_id = m.complex_id
          WHERE p.household_count IS NOT NULL AND p.building_count IS NOT NULL
            AND p.approval_date IS NOT NULL AND m.lawd_cd LIKE '26%'
          LIMIT 3`,
    args: [],
  });
  const gg = await db.execute({
    sql: `SELECT m.complex_id, m.apt_name,
            p.household_count, p.building_count, p.approval_date, p.max_floor,
            p.far_ratio, p.bcr_ratio, p.heating_type, p.parking_total, p.parking_per_household,
            p.source, p.source_version, p.raw_meta_json
          FROM apt_complex_master m
          JOIN apt_complex_profile p ON p.complex_id = m.complex_id
          WHERE p.household_count IS NOT NULL AND m.lawd_cd LIKE '41%'
          LIMIT 5`,
    args: [],
  });

  const all = [...named.rows, ...busan.rows, ...gg.rows];
  let wouldUpdate = 0;
  const details: unknown[] = [];
  for (const row of all) {
    const existing: ProfileSnap = {
      complex_id: String(row.complex_id),
      household_count: row.household_count as number | null,
      building_count: row.building_count as number | null,
      approval_date: row.approval_date as string | null,
      heating_type: row.heating_type as string | null,
      parking_total: row.parking_total as number | null,
      parking_per_household: row.parking_per_household as number | null,
      far_ratio: row.far_ratio as number | null,
      bcr_ratio: row.bcr_ratio as number | null,
      max_floor: row.max_floor as number | null,
      source: String(row.source || ""),
      source_version: String(row.source_version || ""),
      raw_meta_json: (row.raw_meta_json as string | null) ?? null,
    };
    const d = decideFills(existing, {});
    const fillKeys = Object.keys(d.fills);
    wouldUpdate += fillKeys.length;
    details.push({
      id: row.complex_id,
      name: row.apt_name,
      empty_bags_fills: fillKeys,
      conflicts: d.conflicts,
      ambiguous: d.ambiguous,
    });
  }

  const out = {
    samples: all.length,
    would_insert: 0,
    would_update: wouldUpdate,
    would_delete: 0,
    details,
  };
  console.log(JSON.stringify(out, null, 2));
  if (wouldUpdate !== 0) {
    console.error("IDEMPOTENCY_FAIL");
    process.exit(1);
  }
  console.log("IDEMPOTENCY_PASS insert=0 update=0 delete=0");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
