/**
 * 서울 3D 커버리지 감사용 DB 읽기 (읽기만) → data/building-coverage/cache/*.json
 *   npx tsx scripts/building-coverage/pull.mts
 */
import { config } from "dotenv"; config({ path: ".env.local", quiet: true });
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { getDb } from "../../src/lib/db/client";
const db = getDb()!;
const OUT = "data/building-coverage/cache";
mkdirSync(OUT, { recursive: true });
const q = async (sql: string, args: any[] = []) => (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const save = (n: string, v: unknown) => writeFileSync(`${OUT}/${n}.json`, JSON.stringify(v));

if (!existsSync(`${OUT}/master.json`)) {
  const master = await q(`SELECT m.complex_id, m.apt_name, m.apt_name_norm, m.lawd_cd, m.legal_dong_name, m.bjdong_cd, m.jibun,
      COALESCE(a.lat, m.latitude) lat, COALESCE(a.lng, m.longitude) lng,
      p.household_count p_hh, p.building_count p_bc, p.approval_date p_appr, p.max_floor p_maxfl,
      c.pnu cp_pnu, c.title_total_count cp_titles, c.title_status cp_ts
    FROM apt_complex_master m LEFT JOIN complex_map_anchor a USING(complex_id)
    LEFT JOIN apt_complex_profile p USING(complex_id) LEFT JOIN complex_building_checkpoint c USING(complex_id)
    WHERE m.lawd_cd LIKE '11%'`);
  save("master", master); console.log("master", master.length);
  const cb = await q(`SELECT cb.complex_id, cb.building_id, cb.mgm_bldrgst_pk pk, cb.dong_label, cb.building_name, cb.main_usage, cb.residential_flag r, cb.household_count hh, cb.floor_count fl
    FROM complex_buildings cb JOIN apt_complex_master m USING(complex_id) WHERE m.lawd_cd LIKE '11%'`);
  save("cb", cb); console.log("cb", cb.length);
  const sb = await q(`SELECT complex_id, source, pnus, polys FROM complex_site_boundary`);
  save("site_boundary", sb); console.log("site_boundary", sb.length);
}
if (!existsSync(`${OUT}/gis.json`)) {
  const lawds = (await q(`SELECT DISTINCT lawd_cd FROM gis_buildings WHERE lawd_cd LIKE '11%'`)).map((r) => String(r.lawd_cd));
  const gis: any[] = [];
  for (const l of lawds) {
    const rows = await q(`SELECT bld_key, bldrgst_pk, pnu, lawd_cd, name, dong_name, use_name, floors_above fl, height_m h, approval_date appr, change_type ct, lat, lng, rings
      FROM gis_buildings WHERE lawd_cd = ?`, [l]);
    gis.push(...rows); console.log(l, rows.length);
  }
  save("gis", gis); console.log("gis", gis.length);
}
