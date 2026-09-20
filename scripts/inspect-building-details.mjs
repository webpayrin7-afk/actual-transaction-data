import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function q(label, sql, args = []) {
  console.log(`\n===== ${label} =====`);
  const res = await db.execute({ sql, args });
  for (const row of res.rows) console.log(JSON.stringify(row));
  return res;
}

await q("master pragma", `PRAGMA table_info(apt_complex_master)`);
await q("source_links pragma", `PRAGMA table_info(apt_complex_source_links)`);
await q("ouac pragma", `PRAGMA table_info(official_unit_area_cache)`);
await q("profile pragma", `PRAGMA table_info(apt_complex_profile)`);
await q("canonical pragma", `PRAGMA table_info(apt_canonical_unit_types)`);
await q("enrichment pragma", `PRAGMA table_info(apt_complex_enrichment_state)`);

await q(
  "jamsil master",
  `SELECT * FROM apt_complex_master WHERE apt_name LIKE '%잠실엘스%' OR apt_name LIKE '%파크리오%' OR apt_name LIKE '%리센츠%' OR apt_name LIKE '%헬리오시티%' OR apt_name LIKE '%반포자이%' OR apt_name LIKE '%래미안퍼스티지%' OR apt_name LIKE '%은마%' OR apt_name LIKE '%도곡렉슬%' OR apt_name LIKE '%마포프레스티지자이%' OR apt_name LIKE '%포레나노원%'`,
);

await q(
  "ouac jamsil sample",
  `SELECT source_provider, source_dataset, source_building_id, dong, floor, ho, exclusive_area, source_unit_id, pnu, source_key
   FROM official_unit_area_cache
   WHERE complex_id = (SELECT complex_id FROM apt_complex_master WHERE apt_name LIKE '%잠실엘스%' LIMIT 1)
   LIMIT 15`,
);

await q(
  "ouac jamsil stats",
  `SELECT source_provider, COUNT(*) n,
          COUNT(DISTINCT source_building_id) buildings,
          COUNT(DISTINCT dong) dongs,
          COUNT(DISTINCT source_unit_id) units,
          COUNT(DISTINCT ho) hos
   FROM official_unit_area_cache
   WHERE complex_id = (SELECT complex_id FROM apt_complex_master WHERE apt_name LIKE '%잠실엘스%' LIMIT 1)
   GROUP BY 1`,
);

await q(
  "ouac bulk sample",
  `SELECT source_provider, source_dataset, source_building_id, dong, floor, ho, exclusive_area, residential_common_area, explicit_supply_area, source_unit_id, pnu, provenance_json
   FROM official_unit_area_cache
   WHERE source_provider='BuildingHubBulk'
   LIMIT 8`,
);

await q(
  "ouac api sample",
  `SELECT source_provider, source_building_id, dong, floor, ho, exclusive_area, source_unit_id, pnu
   FROM official_unit_area_cache
   WHERE source_provider='BldRgstHubService'
   LIMIT 8`,
);

await q(
  "ouac bulk grain",
  `SELECT
     AVG(cnt) avg_rows,
     MIN(cnt) min_rows,
     MAX(cnt) max_rows
   FROM (
     SELECT complex_id, COUNT(*) cnt
     FROM official_unit_area_cache
     WHERE source_provider='BuildingHubBulk'
     GROUP BY complex_id
   )`,
);

await q(
  "ouac api grain",
  `SELECT
     AVG(cnt) avg_rows,
     MIN(cnt) min_rows,
     MAX(cnt) max_rows,
     COUNT(*) complexes
   FROM (
     SELECT complex_id, COUNT(*) cnt
     FROM official_unit_area_cache
     WHERE source_provider='BldRgstHubService'
     GROUP BY complex_id
   )`,
);

await q(
  "ouac dong fill",
  `SELECT source_provider,
          SUM(CASE WHEN dong IS NOT NULL AND dong != '' THEN 1 ELSE 0 END) with_dong,
          SUM(CASE WHEN source_building_id IS NOT NULL AND source_building_id != '' THEN 1 ELSE 0 END) with_bldg,
          SUM(CASE WHEN ho IS NOT NULL AND ho != '' THEN 1 ELSE 0 END) with_ho,
          COUNT(*) n
   FROM official_unit_area_cache GROUP BY 1`,
);

await q(
  "source links sample",
  `SELECT * FROM apt_complex_source_links LIMIT 8`,
);

await q(
  "source links counts",
  `SELECT source, COUNT(*) n, COUNT(DISTINCT complex_id) complexes FROM apt_complex_source_links GROUP BY 1`,
);

await q(
  "master coords",
  `SELECT
     SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END) with_coords,
     SUM(CASE WHEN jibun IS NOT NULL AND jibun != '' THEN 1 ELSE 0 END) with_jibun,
     COUNT(*) n
   FROM apt_complex_master`,
);

await q(
  "canonical jamsil 84",
  `SELECT unit_type_id, exclusive_area, supply_area, household_count, status, source, confidence
   FROM apt_canonical_unit_types
   WHERE complex_id = (SELECT complex_id FROM apt_complex_master WHERE apt_name LIKE '%잠실엘스%' LIMIT 1)
     AND exclusive_area BETWEEN 84 AND 86
   ORDER BY exclusive_area, supply_area`,
);
