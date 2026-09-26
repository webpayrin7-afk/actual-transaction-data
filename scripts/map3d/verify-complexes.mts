/**
 * 새 건물 타일에 단지 동(DB gis_buildings SPBD 도형)이 들어갔는지 — 동마다 도형 안쪽 점이 들어 있는 타일 건물을 z14·z15에서 찾는다. 읽기만.
 *
 *   npx tsx scripts/map3d/verify-complexes.mts C:/data/map3d/seoul-buildings-v2.pmtiles 래미안웰스트림 헬리오시티 …
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { openSync, readSync } from "node:fs";
import { PMTiles } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { getDb } from "../../src/lib/db/client";

const [path, ...names] = process.argv.slice(2);
if (!path || !names.length) throw new Error("usage: verify-complexes.mts <file.pmtiles> <단지명>...");
const db = getDb();
if (!db) throw new Error("DB 없음");

const fd = openSync(path, "r");
const p = new PMTiles({
  getKey: () => path,
  getBytes: async (offset: number, length: number) => {
    const b = Buffer.alloc(length);
    readSync(fd, b, 0, length, offset);
    return { data: b.buffer.slice(b.byteOffset, b.byteOffset + length) as ArrayBuffer };
  },
});

type Pt = [number, number];
const tileCache = new Map<string, Array<{ h: number; polys: Pt[][][] }>>();
async function tileFeatures(z: number, x: number, y: number) {
  const k = `${z}/${x}/${y}`;
  if (tileCache.has(k)) return tileCache.get(k)!;
  const t = await p.getZxy(z, x, y);
  const out: Array<{ h: number; polys: Pt[][][] }> = [];
  if (t) {
    const layer = new VectorTile(new Pbf(new Uint8Array(t.data))).layers.buildings;
    for (let i = 0; i < (layer?.length ?? 0); i++) {
      const f = layer!.feature(i);
      const g = f.toGeoJSON(x, y, z).geometry as { type: string; coordinates: unknown };
      const polys = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as Pt[][][];
      out.push({ h: Number(f.properties.h), polys });
    }
  }
  tileCache.set(k, out);
  return out;
}
function inRing(pt: Pt, ring: Pt[]) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function tileXY(z: number, lng: number, lat: number) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return [Math.floor(((lng + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)] as const;
}
/** 고리 안쪽 점 — 무게중심이 안이면 그것, 아니면 가로선 중점 */
function inside(ring: Pt[]): Pt {
  const c: Pt = [ring.reduce((s, q) => s + q[0], 0) / ring.length, ring.reduce((s, q) => s + q[1], 0) / ring.length];
  if (inRing(c, ring)) return c;
  const xs: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > c[1] !== yj > c[1]) xs.push(((xj - xi) * (c[1] - yi)) / (yj - yi) + xi);
  }
  xs.sort((a, b) => a - b);
  return [(xs[0]! + xs[1]!) / 2, c[1]];
}

const results = [];
for (const name of names) {
  const cx = (
    await db.execute({
      sql: `SELECT complex_id, apt_name, lawd_cd FROM apt_complex_master WHERE lawd_cd LIKE '11%' AND replace(apt_name, ' ', '') LIKE ?`,
      args: [`%${name}%`],
    })
  ).rows;
  for (const c of cx) {
    const rows = (
      await db.execute({
        sql: `SELECT bld_key, height_m, rings FROM gis_buildings
              WHERE change_type = 'SPBD' AND lawd_cd = ? AND bldrgst_pk IN (
                SELECT substr(mgm_bldrgst_pk, 6) FROM complex_buildings WHERE complex_id = ? AND length(mgm_bldrgst_pk) > 5)`,
        args: [c.lawd_cd, c.complex_id],
      })
    ).rows;
    const byZoom: Record<number, number> = {};
    const hs: number[] = [];
    let stacked = 0;
    for (const z of [14, 15]) {
      let found = 0;
      for (const r of rows) {
        const rings = JSON.parse(String(r.rings)) as Pt[][];
        const pt = inside(rings[0]!);
        const [x, y] = tileXY(z, pt[0], pt[1]);
        const feats = await tileFeatures(z, x, y);
        const hits = feats.filter((f) => f.polys.some((poly) => inRing(pt, poly[0]!) && !poly.slice(1).some((h) => inRing(pt, h))));
        const hit = hits[0];
        if (z === 15 && hits.length > 1) stacked++; // 같은 자리에 건물이 둘 이상 (옛 건물이 안 빠졌거나 겹침)
        if (hit) {
          found++;
          if (z === 15) hs.push(hit.h);
        }
      }
      byZoom[z] = found;
    }
    results.push({
      name: String(c.apt_name),
      complex_id: String(c.complex_id),
      spbd: rows.length,
      found_z14: byZoom[14],
      found_z15: byZoom[15],
      stacked_z15: stacked,
      h_range_z15: hs.length ? [Math.min(...hs), Math.max(...hs)] : null,
    });
  }
}
console.log(JSON.stringify(results, null, 1));
