import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
async function q(label, sql, args=[]) {
  console.log('\n==', label);
  const r = await db.execute({sql, args});
  for (const row of r.rows) console.log(JSON.stringify(row));
}
await q('api ouac supply fields',
  `SELECT
     SUM(CASE WHEN residential_common_area IS NOT NULL THEN 1 ELSE 0 END) res_common,
     SUM(CASE WHEN explicit_supply_area IS NOT NULL THEN 1 ELSE 0 END) supply,
     SUM(CASE WHEN exclusive_area IS NOT NULL THEN 1 ELSE 0 END) excl,
     COUNT(*) n
   FROM official_unit_area_cache WHERE source_provider='BldRgstHubService'`);
await q('jamsil api unit sample fields',
  `SELECT dong, floor, ho, exclusive_area, residential_common_area, explicit_supply_area, source_building_id, provenance_json
   FROM official_unit_area_cache
   WHERE complex_id='cx_4c63d9a100973c60' AND source_provider='BldRgstHubService' LIMIT 3`);
await q('missing jibun but kapt or ouac',
  `SELECT
     SUM(CASE WHEN m.jibun IS NULL OR m.jibun='' OR m.bjdong_cd IS NULL OR m.bjdong_cd='' THEN 1 ELSE 0 END) missing_parcel,
     SUM(CASE WHEN (m.jibun IS NULL OR m.jibun='' OR m.bjdong_cd IS NULL OR m.bjdong_cd='') AND k.complex_id IS NOT NULL THEN 1 ELSE 0 END) missing_with_kapt,
     SUM(CASE WHEN (m.jibun IS NULL OR m.jibun='' OR m.bjdong_cd IS NULL OR m.bjdong_cd='') AND o.complex_id IS NOT NULL THEN 1 ELSE 0 END) missing_with_ouac
   FROM apt_complex_master m
   LEFT JOIN (SELECT DISTINCT complex_id FROM apt_complex_source_links WHERE source='KAPT') k ON k.complex_id=m.complex_id
   LEFT JOIN (SELECT DISTINCT complex_id FROM official_unit_area_cache WHERE pnu!='') o ON o.complex_id=m.complex_id`);
await q('canonical status with hh',
  `SELECT status,
          COUNT(*) types,
          COUNT(DISTINCT complex_id) complexes,
          SUM(CASE WHEN household_count IS NOT NULL THEN 1 ELSE 0 END) with_hh
   FROM apt_canonical_unit_types GROUP BY 1`);
