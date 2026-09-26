/**
 * 단지 중심 좌표 + 동 건축물대장 키 CSV (build-gis-buildings.py 용). 읽기 전용.
 *   npx tsx scripts/building-3d/export-complex-points.ts C:/data/gis/complexes.csv C:/data/gis/complex-bld-keys.csv
 * 좌표: complex_map_anchor 우선, 없으면 apt_complex_master.
 * 키: mgm_bldrgst_pk 앞 5자리(기관코드) 제거 = GIS A19.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync } from "node:fs";
import { getDb } from "../../src/lib/db/client";

async function main() {
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  const pointsOut = process.argv[2];
  const keysOut = process.argv[3];
  if (!pointsOut || !keysOut) throw new Error("출력 경로 2개(complexes.csv, complex-bld-keys.csv)가 필요합니다.");

  const pts = await db.execute(`SELECT m.complex_id, COALESCE(a.lat, m.latitude) AS lat, COALESCE(a.lng, m.longitude) AS lng
    FROM apt_complex_master m LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id
    WHERE COALESCE(a.lat, m.latitude) IS NOT NULL`);
  writeFileSync(
    pointsOut,
    "complex_id,lat,lng\n" + pts.rows.map((r) => `${r.complex_id},${r.lat},${r.lng}`).join("\n") + "\n",
  );

  const keys = await db.execute(`SELECT cb.complex_id, m.lawd_cd, cb.mgm_bldrgst_pk, m.apt_name, cb.dong_label
    FROM complex_buildings cb
    JOIN apt_complex_master m ON m.complex_id = cb.complex_id
    WHERE cb.mgm_bldrgst_pk IS NOT NULL AND length(cb.mgm_bldrgst_pk) > 5`);
  const lines = ["complex_id,lawd_cd,bldrgst_pk,apt_name,dong_label"];
  for (const r of keys.rows) {
    const pk = String(r.mgm_bldrgst_pk);
    const suf = pk.slice(5);
    const apt = String(r.apt_name ?? "").replaceAll(",", " ");
    const dong = String(r.dong_label ?? "").replaceAll(",", " ");
    lines.push(`${r.complex_id},${r.lawd_cd},${suf},${apt},${dong}`);
  }
  writeFileSync(keysOut, lines.join("\n") + "\n");

  console.log(
    JSON.stringify({
      complexes: pts.rows.length,
      building_keys: keys.rows.length,
      points: pointsOut,
      keys: keysOut,
    }),
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
