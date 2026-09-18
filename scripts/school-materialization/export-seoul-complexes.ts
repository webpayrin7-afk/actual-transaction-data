/**
 * READ-ONLY export of Seoul complexes for school materialization dry-run.
 * Does not write to Production.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@libsql/client";
import { writeFileSync, mkdirSync } from "fs";
import { JAMSIL_ELS_CANONICAL_CENTER } from "../../src/lib/nearby-map/jamsil-els-canonical-center";

async function main() {
  const outDir = process.argv[2] || "/tmp/school-materialization-out";
  mkdirSync(outDir, { recursive: true });
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL as string,
    authToken: process.env.TURSO_AUTH_TOKEN as string,
  });
  const res = await db.execute(`
    SELECT complex_id, apt_name, sido, sigungu, lawd_cd, legal_dong_name, jibun,
           road_address, latitude, longitude, identity_status
    FROM apt_complex_master
    WHERE sido LIKE '%서울%' OR lawd_cd LIKE '11%'
    ORDER BY complex_id
  `);
  const rows = res.rows.map((r) => {
    const id = String(r.complex_id);
    let lat = r.latitude == null ? null : Number(r.latitude);
    let lng = r.longitude == null ? null : Number(r.longitude);
    let coordSource: string | null = null;
    if (
      id === JAMSIL_ELS_CANONICAL_CENTER.complexId &&
      (lat == null || lng == null)
    ) {
      lat = JAMSIL_ELS_CANONICAL_CENTER.lat;
      lng = JAMSIL_ELS_CANONICAL_CENTER.lng;
      coordSource = JAMSIL_ELS_CANONICAL_CENTER.coordinateSource;
    } else if (
      lat != null &&
      lng != null &&
      Number.isFinite(lat) &&
      Number.isFinite(lng)
    ) {
      coordSource = "apt_complex_master";
    }
    return {
      complex_id: id,
      apt_name: String(r.apt_name ?? ""),
      sido: r.sido == null ? null : String(r.sido),
      sigungu: r.sigungu == null ? null : String(r.sigungu),
      lawd_cd: r.lawd_cd == null ? null : String(r.lawd_cd),
      legal_dong_name:
        r.legal_dong_name == null ? null : String(r.legal_dong_name),
      jibun: r.jibun == null ? null : String(r.jibun),
      road_address: r.road_address == null ? null : String(r.road_address),
      lat,
      lng,
      coord_source: coordSource,
      identity_status:
        r.identity_status == null ? null : String(r.identity_status),
    };
  });
  const path = `${outDir}/seoul-complexes.json`;
  writeFileSync(path, JSON.stringify({ exportedAt: new Date().toISOString(), count: rows.length, complexes: rows }));
  console.log(JSON.stringify({ path, count: rows.length, withCoords: rows.filter((c) => c.lat != null).length }));
}
main();
