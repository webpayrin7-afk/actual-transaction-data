/**
 * A) 서울 건물 타일(v2)에 빠진 건물 — 읽기만.
 *  1) DB gis_buildings(서울, 캐시) 행마다 도형 안쪽 점을 z15 타일 건물이 덮는지
 *  2) 브이월드 SPBD 캐시(C:/data/fixes/gis-spbd/cache, 단지 ±700m) 서울 건물 중 타일에 없는 것 (현재 건물인데 빠진 것)
 *   npx tsx scripts/building-coverage/a-tiles.mts [tiles.pmtiles]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { openTiles, innerPoint, areaM2, type Pt } from "./geo.mjs";
const TILES = process.argv[2] ?? "C:/data/map3d/seoul-buildings-v2.pmtiles";
const t = openTiles(TILES);
const OUT = "data/building-coverage";
const band = (f: number | null) => (f == null ? "?" : f >= 30 ? "30+" : f >= 15 ? "15-29" : f >= 6 ? "6-14" : "1-5");
const resid = (u: unknown, n: unknown) => /공동주택|아파트/.test(String(u ?? "")) || /아파트/.test(String(n ?? ""));

// 1) gis_buildings
const gis = JSON.parse(readFileSync(`${OUT}/cache/gis.json`, "utf8")) as any[];
const g1: Record<string, { n: number; miss: number }> = {};
const gMissTall: any[] = [];
let i = 0;
for (const r of process.env.SKIP_GIS ? [] : gis) {
  if (++i % 20000 === 0) console.log("gis", i, "tiles cached", t.cacheSize());
  let rings: Pt[][]; try { rings = JSON.parse(r.rings); } catch { continue; }
  const p = innerPoint(rings); if (!p) continue;
  const f = await t.cover(p);
  const k = `${r.ct ?? "AL_D010"}|${resid(r.use_name, r.name) ? "주거" : "기타"}|${band(r.fl == null ? null : Number(r.fl))}`;
  (g1[k] ??= { n: 0, miss: 0 }).n++;
  if (!f) { g1[k].miss++; if (Number(r.fl) >= 15) gMissTall.push({ bld_key: r.bld_key, ct: r.ct, name: r.name, dong: r.dong_name, use: r.use_name, fl: r.fl, pk: r.bldrgst_pk, lat: r.lat, lng: r.lng }); }
}

// 2) SPBD 캐시 (서울만, bd_mgt_sn으로 중복 제거)
const dir = "C:/data/fixes/gis-spbd/cache";
const seen = new Set<string>();
const gisSpbd = new Set(gis.filter((r) => r.ct === "SPBD").map((r) => String(r.bld_key).replace(/^SPBD:/, "")));
const s1: Record<string, { n: number; miss: number; inDb: number }> = {};
const sMiss: any[] = [];
const files = readdirSync(dir);
let fi = 0;
for (const fn of files) {
  if (++fi % 500 === 0) console.log("spbd files", fi, "/", files.length, "seoul feats", seen.size);
  const txt = readFileSync(`${dir}/${fn}`, "utf8");
  if (!txt.includes("서울특별시")) continue;
  let arr: any[]; try { arr = JSON.parse(txt); } catch { continue; }
  if (!Array.isArray(arr)) continue;
  for (const x of arr) {
    if (!String(x.sig ?? "").startsWith("서울") || seen.has(x.bd_mgt_sn)) continue;
    seen.add(x.bd_mgt_sn);
    const rings = x.rings as Pt[][] | undefined; if (!rings?.[0]) continue;
    const a = areaM2(rings[0]!); if (a < 30) continue; // 아주 작은 부속 건물 제외
    const p = innerPoint(rings); if (!p) continue;
    const f = await t.cover(p);
    const fl = x.gro_flo_co == null ? null : Number(x.gro_flo_co);
    const k = band(fl);
    (s1[k] ??= { n: 0, miss: 0, inDb: 0 }).n++;
    if (gisSpbd.has(x.bd_mgt_sn)) s1[k].inDb++;
    if (!f) { s1[k].miss++; if ((fl ?? 0) >= 10) sMiss.push({ sn: x.bd_mgt_sn, name: x.buld_nm, dong: x.buld_nm_dc, fl, road: x.road, lat: x.lat, lng: x.lng, area: Math.round(a), inDb: gisSpbd.has(x.bd_mgt_sn) }); }
  }
}
sMiss.sort((a, b) => b.fl - a.fl);
const res = { tiles: TILES, gis: g1, gisMissingTall: gMissTall, spbdSeoulFeatures: seen.size, spbd: s1, spbdMissing10plus: sMiss };
writeFileSync(`${OUT}/a-tiles-result${process.env.SKIP_GIS ? "-spbd" : ""}.json`, JSON.stringify(res, null, 1));
console.table(Object.entries(g1).sort().map(([k, v]) => ({ k, ...v })));
console.table(Object.entries(s1).sort().map(([k, v]) => ({ k, ...v })));
console.log("gis tall missing", gMissTall.length, "spbd 10F+ missing", sMiss.length);
console.table(sMiss.slice(0, 40).map((x) => ({ name: x.name, dong: x.dong, fl: x.fl, road: x.road, inDb: x.inDb })));
