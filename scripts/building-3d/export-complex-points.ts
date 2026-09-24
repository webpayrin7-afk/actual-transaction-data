/**
 * 단지 중심 좌표 CSV (build-gis-buildings.py --near 용). 읽기 전용.
 *   npx tsx scripts/building-3d/export-complex-points.ts C:/data/gis/complexes.csv
 * 좌표: complex_map_anchor 우선, 없으면 apt_complex_master.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { writeFileSync } from "node:fs";
import { getDb } from "../../src/lib/db/client";

async function main() {
  const db = getDb();
  if (!db) throw new Error("DB가 설정되지 않았습니다.");
  const out = process.argv[2];
  if (!out) throw new Error("출력 경로가 필요합니다.");
  const res = await db.execute(`SELECT m.complex_id, COALESCE(a.lat, m.latitude) AS lat, COALESCE(a.lng, m.longitude) AS lng
    FROM apt_complex_master m LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id
    WHERE COALESCE(a.lat, m.latitude) IS NOT NULL`);
  writeFileSync(out, "complex_id,lat,lng\n" + res.rows.map((r) => `${r.complex_id},${r.lat},${r.lng}`).join("\n") + "\n");
  console.log(JSON.stringify({ complexes: res.rows.length, out }));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
