// 이름 붙인 점에서 v2 타일 z15 건물 확인
import { openTiles } from "./geo.mjs";
const t = openTiles(process.argv[2] ?? "C:/data/map3d/seoul-buildings-v2.pmtiles");
const pts: Array<[string, number, number]> = [
  ["래미안용산더센트럴 A동(SPBD)", 126.96676, 37.52885], ["래미안용산더센트럴 B동(SPBD)", 126.96716, 37.52941],
  ["용산푸르지오써밋(SPBD 13692)", 126.96527, 37.52715], ["용산푸르지오써밋 102동(SPBD)", 126.96538, 37.52744],
  ["파크타워 101동", 126.97049, 37.52489], ["파크타워 103동", 126.97135, 37.524], ["파크타워 106동", 126.97327, 37.52302],
  ["한강맨숀 31동(gis)", 126.97504, 37.51939], ["한강맨숀 18동(gis)", 126.97187, 37.51824],
];
for (const [n, lng, lat] of pts) { const f = await t.cover([lng, lat]); console.log(n, f ? `h=${f.h} a=${f.a}` : "NONE"); }
