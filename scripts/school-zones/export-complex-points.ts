/**
 * 통학구역 판정용 단지 좌표 내보내기 — 읽기만 (DB 쓰기 없음).
 * 지도와 같은 좌표: complex_map_anchor 가 있으면 그것, 없으면 apt_complex_master.latitude/longitude.
 *
 *   npx tsx scripts/school-zones/export-complex-points.ts --sd=11,41 --out=C:/data/school/work/complex-points.json
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getDb } from "../../src/lib/db/client";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const sds = (arg("sd") ?? "11,41").split(",").map((s) => s.trim()).filter((s) => /^\d{2}$/.test(s));
  const out = arg("out");
  if (!sds.length || !out) throw new Error("--sd=11,41 --out=path 필요");
  const db = getDb();
  if (!db) throw new Error("DB 설정 없음 (.env.local)");

  const res = await db.execute({
    sql: `SELECT m.complex_id, m.apt_name, substr(m.lawd_cd, 1, 2) AS sd,
                 a.lat AS a_lat, a.lng AS a_lng, m.latitude, m.longitude
            FROM apt_complex_master m
            LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id
           WHERE substr(m.lawd_cd, 1, 2) IN (${sds.map(() => "?").join(",")})`,
    args: sds,
  });
  let noCoord = 0;
  const points: Array<{ complex_id: string; apt_name: string; sd: string; lat: number; lng: number; src: string }> = [];
  for (const r of res.rows) {
    const aLat = r.a_lat == null ? NaN : Number(r.a_lat);
    const aLng = r.a_lng == null ? NaN : Number(r.a_lng);
    const mLat = r.latitude == null ? NaN : Number(r.latitude);
    const mLng = r.longitude == null ? NaN : Number(r.longitude);
    const anchored = Number.isFinite(aLat) && Number.isFinite(aLng);
    const lat = anchored ? aLat : mLat;
    const lng = anchored ? aLng : mLng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      noCoord++;
      continue;
    }
    points.push({
      complex_id: String(r.complex_id),
      apt_name: String(r.apt_name ?? ""),
      sd: String(r.sd),
      lat,
      lng,
      src: anchored ? "complex_map_anchor" : "apt_complex_master",
    });
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(points));
  console.log(JSON.stringify({ sds, rows: res.rows.length, exported: points.length, noCoord, out }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
