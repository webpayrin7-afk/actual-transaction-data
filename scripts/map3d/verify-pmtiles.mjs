/**
 * 만든 건물 PMTiles 점검 — 머리글·메타데이터를 읽고 잠실 주변 타일을 풀어 본다. 쓰기 없음.
 *
 *   node scripts/map3d/verify-pmtiles.mjs public/map3d/seoul-buildings.pmtiles
 */
import { PMTiles } from "pmtiles";
import { openSync, readSync } from "node:fs";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";

const path = process.argv[2];
if (!path) throw new Error("usage: node scripts/map3d/verify-pmtiles.mjs <file.pmtiles>");
const fd = openSync(path, "r");
const source = {
  getKey: () => path,
  getBytes: async (offset, length) => {
    const b = Buffer.alloc(length);
    readSync(fd, b, 0, length, offset);
    return { data: b.buffer.slice(b.byteOffset, b.byteOffset + length) };
  },
};
const p = new PMTiles(source);
const h = await p.getHeader();
console.log(JSON.stringify({ ...h, etag: undefined }));
console.log(JSON.stringify(await p.getMetadata()));

const lon = 127.0806;
const lat = 37.5133; // 잠실
for (const z of [12, 13, 14, 15]) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  const t = await p.getZxy(z, x, y);
  if (!t) {
    console.log("missing", z, x, y);
    continue;
  }
  const buf = new Uint8Array(t.data);
  const layer = new VectorTile(new Pbf(buf)).layers.buildings;
  const f = layer.feature(0);
  const g = f.toGeoJSON(x, y, z).geometry;
  console.log(
    `z${z}/${x}/${y}`,
    `${(buf.length / 1024).toFixed(1)}KB`,
    `${layer.length} features`,
    JSON.stringify(f.properties),
    JSON.stringify(g.coordinates[0]?.[0] ?? g.coordinates[0]).slice(0, 60),
  );
}
