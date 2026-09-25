/**
 * Read-only: export complex centers for the commerce materializer.
 *
 * Priority:
 *   1. complex_map_anchor (NAVER geocode anchor)          → coordinate_source = "complex_map_anchor"
 *   2. apt_complex_master.latitude/longitude (parcel rep.) → coordinate_source = "apt_complex_master"
 * Complexes with neither are listed as NO_COORDINATE and get no snapshot rows.
 *
 * Usage: ENV_FILE=../../.env.local npx tsx scripts/commerce/export-commerce-centers.ts <out.json>
 */
import { config } from "dotenv";
import { createClient } from "@libsql/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

config({ path: process.env.ENV_FILE ?? ".env.local", quiet: true });

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error("usage: export-commerce-centers.ts <out.json>");
  const url = process.env.TURSO_DATABASE_URL?.trim();
  if (!url) throw new Error("TURSO_DATABASE_URL missing");
  const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN?.trim() });

  const rs = await db.execute(`
    SELECT m.complex_id AS complex_id,
           a.lat AS a_lat, a.lng AS a_lng,
           m.latitude AS m_lat, m.longitude AS m_lng
    FROM apt_complex_master m
    LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id
    ORDER BY m.complex_id
  `);
  const orphan = await db.execute(`
    SELECT COUNT(*) AS n FROM complex_map_anchor a
    WHERE NOT EXISTS (SELECT 1 FROM apt_complex_master m WHERE m.complex_id = a.complex_id)
  `);

  const centers: Array<{ complex_id: string; lat: number; lng: number; coordinate_source: string }> = [];
  const noCoordinate: string[] = [];
  let anchor = 0;
  let master = 0;
  for (const r of rs.rows) {
    const id = String(r.complex_id);
    const aLat = r.a_lat == null ? null : Number(r.a_lat);
    const aLng = r.a_lng == null ? null : Number(r.a_lng);
    const mLat = r.m_lat == null ? null : Number(r.m_lat);
    const mLng = r.m_lng == null ? null : Number(r.m_lng);
    if (aLat != null && aLng != null && Number.isFinite(aLat) && Number.isFinite(aLng)) {
      centers.push({ complex_id: id, lat: aLat, lng: aLng, coordinate_source: "complex_map_anchor" });
      anchor += 1;
    } else if (mLat != null && mLng != null && Number.isFinite(mLat) && Number.isFinite(mLng)) {
      centers.push({ complex_id: id, lat: mLat, lng: mLng, coordinate_source: "apt_complex_master" });
      master += 1;
    } else {
      noCoordinate.push(id);
    }
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({
      exportedAt: new Date().toISOString(),
      masterRows: rs.rows.length,
      anchorOrphans: Number(orphan.rows[0].n),
      counts: { anchor, master, noCoordinate: noCoordinate.length },
      centers,
      noCoordinate,
    }),
  );
  console.log(
    JSON.stringify({
      masterRows: rs.rows.length,
      fromAnchor: anchor,
      fromMaster: master,
      noCoordinate: noCoordinate.length,
      anchorRowsWithoutMaster: Number(orphan.rows[0].n),
    }),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
