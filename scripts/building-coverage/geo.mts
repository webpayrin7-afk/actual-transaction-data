import { openSync, readSync } from "node:fs";
import { PMTiles } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
export type Pt = [number, number];
export function inRing(pt: Pt, ring: Pt[]) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!; const [xj, yj] = ring[j]!;
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
export function inPoly(pt: Pt, poly: Pt[][]) { return !!poly[0] && inRing(pt, poly[0]) && !poly.slice(1).some((h) => inRing(pt, h)); }
export function ringArea(r: Pt[]) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] + r[i]![0]) * (r[j]![1] - r[i]![1]); return a / 2; }
/** 도형 안쪽 점 — 면적 중심이 안이면 그것, 아니면 가운데 가로선의 첫 구간 중점 */
export function innerPoint(rings: Pt[][]): Pt | null {
  const r = rings[0]; if (!r || r.length < 4) return null;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const f = r[j]![0] * r[i]![1] - r[i]![0] * r[j]![1]; a += f; cx += (r[j]![0] + r[i]![0]) * f; cy += (r[j]![1] + r[i]![1]) * f; }
  if (a !== 0) { const c: Pt = [cx / (3 * a), cy / (3 * a)]; if (inPoly(c, rings)) return c; }
  let y0 = Infinity, y1 = -Infinity; for (const [, y] of r) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const y = (y0 + y1) / 2; const xs: number[] = [];
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i]!; const [xj, yj] = r[j]!; if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi)); }
  xs.sort((p, q) => p - q); return xs.length >= 2 ? [(xs[0]! + xs[1]!) / 2, y] : null;
}
export function areaM2(r: Pt[]) { const lat = r[0]![1] * Math.PI / 180; return Math.abs(ringArea(r)) * 111320 * 111320 * Math.cos(lat); }
export function haversine(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000, d = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(d(bLat - aLat) / 2) ** 2 + Math.cos(d(aLat)) * Math.cos(d(bLat)) * Math.sin(d(bLng - aLng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function tileXY(z: number, lng: number, lat: number) {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return { x: Math.floor(((lng + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n) };
}
export function openTiles(path: string) {
  const fd = openSync(path, "r");
  const p = new PMTiles({ getKey: () => path, getBytes: async (o: number, l: number) => { const b = Buffer.alloc(l); readSync(fd, b, 0, l, o); return { data: b.buffer.slice(b.byteOffset, b.byteOffset + l) as ArrayBuffer }; } });
  const cache = new Map<string, Array<{ h: number; a: number; polys: Pt[][][] }>>();
  async function features(z: number, x: number, y: number) {
    const k = `${z}/${x}/${y}`; const hit = cache.get(k); if (hit) return hit;
    const t = await p.getZxy(z, x, y); const out: Array<{ h: number; a: number; polys: Pt[][][] }> = [];
    if (t) { const layer = new VectorTile(new Pbf(new Uint8Array(t.data))).layers.buildings;
      for (let i = 0; i < (layer?.length ?? 0); i++) { const f = layer!.feature(i); const g = f.toGeoJSON(x, y, z).geometry as any;
        out.push({ h: Number(f.properties.h), a: Number(f.properties.a ?? 0), polys: g.type === "Polygon" ? [g.coordinates] : g.coordinates }); } }
    cache.set(k, out); return out;
  }
  /** z15 타일에서 이 점을 덮는 건물 (없으면 null) */
  async function cover(pt: Pt) {
    const { x, y } = tileXY(15, pt[0], pt[1]);
    for (const f of await features(15, x, y)) if (f.polys.some((pl) => inPoly(pt, pl))) return f;
    return null;
  }
  return { features, cover, cacheSize: () => cache.size };
}
