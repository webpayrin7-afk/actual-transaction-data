/**
 * 두 건물 타일(z15)을 구역별로 비교 — 올리기 전 점검. 읽기만.
 *   npx tsx scripts/building-coverage/compare-tiles.mts C:/data/map3d/seoul-buildings-v2.pmtiles C:/data/map3d/seoul-buildings-v3.pmtiles
 * 구역마다: 건물 수(안쪽 점 기준) · 새로 생긴/없어진 수 · 없어진 10층(33m) 이상(= 새 쪽에서 그 자리를 80% 높이 이상이 덮지 않음, 회귀)
 *           · 새 파일 중복(서로의 안쪽 점을 품고 면적이 비슷한 두 도형)
 */
import { openTiles, innerPoint, inPoly, areaM2, tileXY, type Pt } from "./geo.mjs";
const [oldPath, newPath] = process.argv.slice(2);
if (!oldPath || !newPath) throw new Error("usage: compare-tiles.mts <old.pmtiles> <new.pmtiles>");
const AREAS: Array<[string, number, number, number, number]> = [
  // 이름, 서, 남, 동, 북
  ["잠실 롯데월드타워", 127.0985, 37.5095, 127.1075, 37.5160],
  ["용산 한강대로(래미안용산더센트럴·푸르지오써밋)", 126.9625, 37.5250, 126.9710, 37.5315],
  ["여의도", 126.9180, 37.5200, 126.9310, 37.5290],
  ["청량리 Sky-L65", 127.0410, 37.5760, 127.0500, 37.5815],
  ["고척아이파크", 126.8560, 37.4955, 126.8630, 37.5000],
  ["창신동(오래된 저층 밀집)", 127.0080, 37.5720, 127.0160, 37.5770],
];
type F = { h: number; a: number; polys: Pt[][][]; p: Pt; area: number };
async function load(path: string, w: number, s: number, e: number, n: number) {
  const t = openTiles(path);
  const a = tileXY(15, w, n), b = tileXY(15, e, s);
  const out: F[] = [];
  const seen = new Set<string>();
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) {
    for (const f of await t.features(15, x, y)) for (const pl of f.polys) {
      const p = innerPoint(pl);
      if (!p || p[0] < w || p[0] > e || p[1] < s || p[1] > n) continue;
      const q = tileXY(15, p[0], p[1]);
      if (q.x !== x || q.y !== y) continue; // 타일 경계 여유에 걸친 조각은 그 점이 있는 타일에서만
      const key = `${f.h}|${p[0].toFixed(6)}|${p[1].toFixed(6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ h: f.h, a: f.a, polys: [pl], p, area: areaM2(pl[0]!) });
    }
  }
  return out;
}
const covers = (fs: F[], p: Pt, minH = 0) => fs.find((f) => f.h >= minH && f.polys.some((pl) => inPoly(p, pl)));
const report: any[] = [];
for (const [name, w, s, e, n] of AREAS) {
  const A = await load(oldPath, w, s, e, n), B = await load(newPath, w, s, e, n);
  const added = B.filter((f) => !covers(A, f.p));
  const removed = A.filter((f) => !covers(B, f.p));
  const tallLost = A.filter((f) => f.h >= 33 && !covers(B, f.p, Math.floor(0.8 * f.h)))
    .map((f) => ({ h: f.h, a: f.a, lng: +f.p[0].toFixed(6), lat: +f.p[1].toFixed(6), m2: Math.round(f.area), nowH: covers(B, f.p)?.h ?? null }));
  let dup = 0;
  const dups: any[] = [];
  for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
    const x = B[i]!, y = B[j]!;
    const r = x.area / y.area;
    if (r < 0.7 || r > 1 / 0.7) continue;
    if (x.polys.some((pl) => inPoly(y.p, pl)) && y.polys.some((pl) => inPoly(x.p, pl))) { dup++; if (dups.length < 5) dups.push({ h: [x.h, y.h], lng: +x.p[0].toFixed(6), lat: +x.p[1].toFixed(6) }); }
  }
  const row = {
    area: name, old: A.length, new: B.length, added: added.length, removed: removed.length,
    addedTall10F: added.filter((f) => f.h >= 33).length, addedResidential: added.filter((f) => f.a === 1).length,
    tallLost: tallLost.length,
    removedBig: removed.filter((f) => f.area >= 500).map((f) => ({ h: f.h, a: f.a, m2: Math.round(f.area), lng: +f.p[0].toFixed(6), lat: +f.p[1].toFixed(6) })).slice(0, 8), dupNew: dup, tallLostList: tallLost.slice(0, 10), dupList: dups,
  };
  report.push(row);
  console.log(JSON.stringify(row));
}
