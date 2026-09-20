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

const PILOT = [
  "잠실엘스",
  "파크리오",
  "리센츠",
  "헬리오시티",
  "반포자이",
  "래미안퍼스티지",
  "은마",
  "도곡렉슬",
  "마포프레스티지자이",
  "포레나노원",
];

await q(
  "pilot masters exact",
  `SELECT complex_id, apt_name, lawd_cd, bjdong_cd, jibun, identity_status, latitude, longitude
   FROM apt_complex_master
   WHERE apt_name IN (${PILOT.map(() => "?").join(",")})
   ORDER BY apt_name`,
  PILOT,
);

await q(
  "hub parcel metas",
  `SELECT complex_id, source, source_key, substr(source_meta_json,1,1500) meta
   FROM apt_complex_source_links WHERE source='BUILDING_HUB_PARCEL'`,
);

await q(
  "kapt jamsil",
  `SELECT * FROM apt_complex_source_links
   WHERE source='KAPT' AND complex_id IN (
     SELECT complex_id FROM apt_complex_master WHERE apt_name IN (${PILOT.map(() => "?").join(",")})
   )`,
  PILOT,
);

await q(
  "ouac api complexes by sido",
  `SELECT m.sido, COUNT(DISTINCT o.complex_id) complexes, COUNT(*) rows
   FROM official_unit_area_cache o
   JOIN apt_complex_master m ON m.complex_id=o.complex_id
   WHERE o.source_provider='BldRgstHubService'
   GROUP BY 1 ORDER BY complexes DESC`,
);

await q(
  "pilot ouac",
  `SELECT m.apt_name, o.source_provider, COUNT(*) n,
          COUNT(DISTINCT o.dong) dongs,
          COUNT(DISTINCT o.source_unit_id) units
   FROM apt_complex_master m
   LEFT JOIN official_unit_area_cache o ON o.complex_id=m.complex_id
   WHERE m.apt_name IN (${PILOT.map(() => "?").join(",")})
   GROUP BY 1,2 ORDER BY 1,2`,
  PILOT,
);

await q(
  "jamsil dong list",
  `SELECT dong, COUNT(*) n, MIN(exclusive_area) min_ex, MAX(exclusive_area) max_ex
   FROM official_unit_area_cache
   WHERE complex_id=(SELECT complex_id FROM apt_complex_master WHERE apt_name='잠실엘스')
     AND source_provider='BldRgstHubService'
   GROUP BY 1 ORDER BY dong`,
);

await q(
  "jamsil type 84 buildings",
  `SELECT exclusive_area, COUNT(DISTINCT dong) dongs, COUNT(*) units
   FROM official_unit_area_cache
   WHERE complex_id=(SELECT complex_id FROM apt_complex_master WHERE apt_name='잠실엘스')
     AND source_provider='BldRgstHubService'
     AND exclusive_area IN (84.8, 84.88, 84.97)
   GROUP BY 1`,
);

await q(
  "profile pilots",
  `SELECT m.apt_name, p.household_count, p.building_count, p.main_purpose, p.source
   FROM apt_complex_master m
   LEFT JOIN apt_complex_profile p ON p.complex_id=m.complex_id
   WHERE m.apt_name IN (${PILOT.map(() => "?").join(",")})`,
  PILOT,
);

await q(
  "canonical household fill",
  `SELECT
     SUM(CASE WHEN household_count IS NOT NULL THEN 1 ELSE 0 END) with_hh,
     COUNT(*) n,
     COUNT(DISTINCT complex_id) complexes
   FROM apt_canonical_unit_types
   WHERE status='EXACT_SINGLE'`,
);

await q(
  "identity status",
  `SELECT identity_status, COUNT(*) n FROM apt_complex_master GROUP BY 1`,
);

await q(
  "pnu from ouac",
  `SELECT COUNT(DISTINCT complex_id) complexes, COUNT(DISTINCT pnu) pnus
   FROM official_unit_area_cache WHERE pnu != ''`,
);

await q(
  "checkpoint sample unresolved",
  `SELECT blocker_class, COUNT(*) FROM apt_unit_acquisition_manifest GROUP BY 1`,
);
