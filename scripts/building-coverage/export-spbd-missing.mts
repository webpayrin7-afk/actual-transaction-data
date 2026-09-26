/**
 * A) 서울 건물 타일 v3 시험용 — 브이월드 SPBD 캐시 합본(spbd-index.mts) 중 v2 타일에 없는 건물을 GeoJSON으로.
 *    DB 쓰기·네트워크 없음. 기존 DB SPBD(export_spbd_buildings.mts 결과)와 합쳐 build_buildings_pmtiles.py --spbd 에 준다.
 *   npx tsx scripts/building-coverage/export-spbd-missing.mts C:/data/map3d/seoul-buildings-v2.pmtiles C:/data/map3d/seoul-spbd.geojson C:/data/map3d/seoul-spbd-plus.geojson
 * 규칙: 도형 안쪽 점을 v2 z15 건물이 덮지 않음(10층 이상인데 덮은 v2 건물이 절반 높이 미만이면 덮지 않은 것으로) · 30㎡ 이상 · DB SPBD에 이미 있는 건물 아님.
 * a(공동주택 색): SPBD엔 용도가 없어 — 이름에 아파트/맨션/APT · 5층 이상이면서 동 표기가 "101동"처럼 숫자 동
 *   · 500m 안 서울 단지 이름(4자 이상)을 담으면 1, 아니면 0(회색).
 *   빌드 스크립트는 옛 AL_D010 도형(30% 겹침)이 공동주택이면 1로 올린다.
 * 높이: 지상층수 2층 이상 → 층수×3.3m (AL_D010 층수 규칙과 같음), 1층·없음 → 3.5m (SPBD 1층은 고층의 자리값일 수 있어 낮게 둠 — 과대 표시 방지).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { openTiles, innerPoint, areaM2, haversine, type Pt } from "./geo.mjs";
const [tilesPath, baseGeo, out] = process.argv.slice(2);
if (!tilesPath || !baseGeo || !out) throw new Error("usage: export-spbd-missing.mts <v2.pmtiles> <seoul-spbd.geojson> <out.geojson>");
const t = openTiles(tilesPath);
const base = JSON.parse(readFileSync(baseGeo, "utf8"));
const inDb = new Set<string>(base.features.map((f: any) => String(f.properties.k ?? "").replace(/^SPBD:/, "")));
const all = JSON.parse(readFileSync("data/building-coverage/cache/spbd-seoul.json", "utf8")) as any[];
const norm = (x: string) => x.toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
const master = (JSON.parse(readFileSync("data/building-coverage/cache/master.json", "utf8")) as any[])
  .map((m) => ({ n: norm(String(m.apt_name ?? "")), lat: Number(m.lat), lng: Number(m.lng) }))
  .filter((m) => m.n.length >= 4 && /[가-힣a-z]/.test(m.n) && Number.isFinite(m.lat));
function residential(name: string, dc: string, fl: number, lat: number, lng: number) {
  if (/아파트|맨션|맨숀|apt/i.test(name)) return true;
  if (fl >= 5 && /^제?\d{1,4}동$/.test(dc.replace(/\s/g, ""))) return true;
  const n = norm(name);
  return n.length >= 4 && master.some((m) => Math.abs(m.lat - lat) < 0.005 && haversine(lat, lng, m.lat, m.lng) <= 500 && n.includes(m.n));
}
const stats = { seoul: all.length, inDb: 0, small: 0, covered: 0, added: 0, byFloors: {} as Record<string, number>, tall15: 0, residential: 0, overLow: 0 };
const feats: any[] = [];
for (const f of all) {
  if (inDb.has(f.bd_mgt_sn)) { stats.inDb++; continue; }
  const rings = f.rings as Pt[][];
  if (!rings?.[0] || rings[0].length < 4) continue;
  if (areaM2(rings[0]) < 30) { stats.small++; continue; }
  const p = innerPoint(rings);
  if (!p) continue;
  const fl = Number(f.gro_flo_co) || 0;
  const h = fl >= 2 ? Math.round(fl * 3.3) : 3.5;
  const c = await t.cover(p);
  // 덮여 있어도 10층 이상 SPBD 자리에 절반 높이도 안 되는 v2 건물(철거된 옛 저층·단지 상가 도형)만 있으면 더한다
  if (c && !(fl >= 10 && c.h < 0.5 * h)) { stats.covered++; continue; }
  if (c) stats.overLow++;
  const band = fl >= 30 ? "30+" : fl >= 15 ? "15-29" : fl >= 6 ? "6-14" : fl >= 2 ? "2-5" : "1/없음";
  stats.byFloors[band] = (stats.byFloors[band] ?? 0) + 1;
  if (fl >= 15) stats.tall15++;
  const name = `${f.buld_nm ?? ""} ${f.buld_nm_dc ?? ""}`.trim();
  const a = residential(String(f.buld_nm ?? ""), String(f.buld_nm_dc ?? ""), fl, p[1], p[0]) ? 1 : 0;
  stats.residential += a;
  feats.push({ type: "Feature", properties: { k: `SPBD:${f.bd_mgt_sn}`, h, a, n: name }, geometry: { type: "Polygon", coordinates: rings } });
  stats.added++;
}
writeFileSync(out, JSON.stringify({ type: "FeatureCollection", features: [...base.features, ...feats] }));
console.log(JSON.stringify({ ...stats, baseFeatures: base.features.length, total: base.features.length + feats.length, out }, null, 1));
