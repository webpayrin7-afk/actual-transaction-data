/**
 * 좌표가 새로 생긴 단지의 주변 학교(1.5km) 계산 — 없는 단지만 (complex_nearby_materialization 행이 없는 단지).
 * 학교 전국 러너(cursor/national-school-backfill-6d70, scripts/school-national-background-runner.ts)와 같은 계약:
 *   운영 중 학교(school_master status='operating'), 1500m 이내(반올림 m), 학교급별 거리순 rank(동률은 school_code),
 *   distance_basis = PARCEL_REPRESENTATIVE_POINT, coord_version = parcel-rep|lat7|lng7.
 * 이미 계산된 단지는 건드리지 않는다(좌표 버전이 달라도 여기서는 다시 만들지 않음 — 그건 학교 러너 몫).
 *
 *   npx tsx scripts/fixes/school-nearby-new-coords.mts           # 대상 수만
 *   npx tsx scripts/fixes/school-nearby-new-coords.mts --apply
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { getDb } from "../../src/lib/db/client";

const RADIUS_M = 1500;
const CELL = 0.02;
const APPLY = process.argv.includes("--apply");

type School = { code: string; level: string; lat: number; lng: number; asOf: string };

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

const coordVersion = (lat: number, lng: number) =>
  `parcel-rep|${(Math.round(lat * 1e7) / 1e7).toFixed(7)}|${(Math.round(lng * 1e7) / 1e7).toFixed(7)}`;

const db = getDb()!;
const targets = await db.execute(`
  SELECT c.complex_id, c.latitude, c.longitude
  FROM apt_complex_master c
  LEFT JOIN complex_nearby_materialization m ON m.complex_id = c.complex_id
  WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL AND m.complex_id IS NULL
    AND c.identity_status = 'IDENTITY-READY'`);
console.log(JSON.stringify({ targets: targets.rows.length }));
if (APPLY && targets.rows.length) {
  const schools = await db.execute(`
    SELECT school_code, school_level, lat, lng, source_as_of FROM school_master
    WHERE status = 'operating' AND lat IS NOT NULL AND lng IS NOT NULL`);
  const grid = new Map<string, School[]>();
  for (const r of schools.rows) {
    const s: School = { code: String(r.school_code), level: String(r.school_level), lat: Number(r.lat), lng: Number(r.lng), asOf: String(r.source_as_of) };
    const k = `${Math.floor(s.lat / CELL)}:${Math.floor(s.lng / CELL)}`;
    grid.set(k, [...(grid.get(k) ?? []), s]);
  }
  const at = new Date().toISOString();
  let links = 0;
  let ready = 0;
  let none = 0;
  for (const r of targets.rows) {
    const lat = Number(r.latitude);
    const lng = Number(r.longitude);
    if (!(lat >= 33 && lat <= 39.5 && lng >= 124 && lng <= 132.5)) continue;
    const gx = Math.floor(lat / CELL);
    const gy = Math.floor(lng / CELL);
    const byLevel = new Map<string, Array<School & { d: number }>>();
    for (let dx = -2; dx <= 2; dx++)
      for (let dy = -2; dy <= 2; dy++)
        for (const s of grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
          const d = Math.round(haversineMeters(lat, lng, s.lat, s.lng));
          if (d <= RADIUS_M) byLevel.set(s.level, [...(byLevel.get(s.level) ?? []), { ...s, d }]);
        }
    const stmts: Array<{ sql: string; args: Array<string | number> }> = [];
    let n = 0;
    for (const list of byLevel.values()) {
      list.sort((a, b) => a.d - b.d || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      list.forEach((s, i) => {
        n++;
        stmts.push({
          sql: `INSERT INTO complex_nearby_schools (
                  complex_id, school_code, distance_m, school_level, rank_by_distance,
                  source_as_of, distance_basis, classification
                ) VALUES (?, ?, ?, ?, ?, ?, 'PARCEL_REPRESENTATIVE_POINT', 'NEARBY_SCHOOL')
                ON CONFLICT(complex_id, school_code) DO NOTHING`,
          args: [String(r.complex_id), s.code, s.d, s.level, i + 1, s.asOf],
        });
      });
    }
    const status = n > 0 ? "READY" : "NO_SCHOOLS_WITHIN_RADIUS";
    stmts.push({
      sql: `INSERT OR IGNORE INTO complex_nearby_materialization (
              complex_id, coord_version, latitude, longitude, link_count, status, materialized_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [String(r.complex_id), coordVersion(lat, lng), lat, lng, n, status, at],
    });
    const out = await db.batch(stmts, "write");
    links += out.slice(0, -1).reduce((a, x) => a + x.rowsAffected, 0);
    if (status === "READY") ready++;
    else none++;
  }
  console.log(JSON.stringify({ materialized: ready + none, ready, noSchoolsWithinRadius: none, links }));
}
