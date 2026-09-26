/**
 * 서울 3D 지도 건물 타일용 — DB gis_buildings의 도로명주소 건물(change_type='SPBD', 서울 lawd_cd 11*)을 GeoJSON으로 내보낸다. 읽기만.
 *
 *   npx tsx scripts/map3d/export_spbd_buildings.mts C:/data/map3d/seoul-spbd.geojson
 *
 * 높이: gis height_m → 단지 동(complex_buildings, 같은 건축물대장 번호) height_m → 층수(gis floors_above, 없으면 대장 floor_count)×3m.
 * 속성은 타일에 싣는 것만: h(높이 m), a(공동주택=1 — 이 행들은 모두 단지 동에 붙은 건물이라 1).
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { writeFileSync } from "node:fs";
import { getDb } from "../../src/lib/db/client";

const out = process.argv[2];
if (!out) throw new Error("usage: npx tsx scripts/map3d/export_spbd_buildings.mts <out.geojson>");
const db = getDb();
if (!db) throw new Error("DB 없음");

const gis = (
  await db.execute(
    `SELECT bld_key, bldrgst_pk, lawd_cd, name, dong_name, height_m, floors_above, rings
     FROM gis_buildings WHERE change_type = 'SPBD' AND lawd_cd LIKE '11%'`,
  )
).rows;

// 대장 번호로 단지 동 높이·층수 — read.ts linkedGisStatement와 같은 연결: 같은 시군구 단지의 동 중 substr(mgm_bldrgst_pk, 6) = bldrgst_pk
const want = new Set(gis.map((r) => `${r.lawd_cd}|${r.bldrgst_pk ?? ""}`));
const reg = new Map<string, { h: number | null; f: number | null }>();
const collisions = new Set<string>();
// 서울 단지 동을 한 번에 읽어 (substr IN 을 여러 번 돌리면 매번 전체를 훑는다) 필요한 것만 남긴다
const regRows = (
  await db.execute(
    `SELECT m.lawd_cd, substr(cb.mgm_bldrgst_pk, 6) AS pk, cb.height_m, cb.floor_count
     FROM complex_buildings cb JOIN apt_complex_master m ON m.complex_id = cb.complex_id
     WHERE m.lawd_cd LIKE '11%' AND length(cb.mgm_bldrgst_pk) > 5`,
  )
).rows;
for (const r of regRows) {
  const key = `${r.lawd_cd}|${r.pk}`;
  if (!want.has(key)) continue;
  if (reg.has(key)) collisions.add(key);
  reg.set(key, {
    h: r.height_m == null ? null : Number(r.height_m),
    f: r.floor_count == null ? null : Number(r.floor_count),
  });
}

const num = (v: unknown) => (v == null || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : Number(v));
const stats = { rows: gis.length, fromGisH: 0, fromRegH: 0, fromFloors: 0, fallback: 0, badRings: 0 };
const features = [];
for (const r of gis) {
  let rings: number[][][];
  try {
    rings = JSON.parse(String(r.rings));
  } catch {
    stats.badRings++;
    continue;
  }
  if (!Array.isArray(rings) || !rings.length || !Array.isArray(rings[0]) || rings[0].length < 4) {
    stats.badRings++;
    continue;
  }
  // 같은 시군구에 같은 번호 뒤쪽이 둘 이상(합쳐진 구)이면 어느 동인지 모르므로 대장 값을 쓰지 않고 SPBD 층수로
  const key = `${r.lawd_cd}|${r.bldrgst_pk ?? ""}`;
  const g = collisions.has(key) ? undefined : reg.get(key);
  let h = num(r.height_m);
  if (h != null && h < 700) stats.fromGisH++;
  else if ((h = num(g?.h)) != null && h < 700) stats.fromRegH++;
  else {
    // SPBD 지상층수 1은 고층 동에서 자리값일 수 있다 → 대장 층수가 더 크면 그것
    const f = Math.max(num(r.floors_above) ?? 0, num(g?.f) ?? 0);
    if (f > 0) {
      h = f * 3;
      stats.fromFloors++;
    } else {
      h = 3.5;
      stats.fallback++;
    }
  }
  features.push({
    type: "Feature",
    properties: { k: String(r.bld_key), h: Math.max(1, Math.round(h!)), a: 1, n: `${r.name ?? ""} ${r.dong_name ?? ""}`.trim() },
    geometry: { type: "Polygon", coordinates: rings },
  });
}
writeFileSync(out, JSON.stringify({ type: "FeatureCollection", features }));
console.log(JSON.stringify({ ...stats, regCollisions: collisions.size, features: features.length, out }));
