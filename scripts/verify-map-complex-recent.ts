/**
 * 지도 단지 스냅샷 검증 — 같은 화면을 스냅샷 경로와 거래 표 경로로 읽어 결과(JSON)가 같은지 본다. 읽기 전용.
 *
 *   npx tsx scripts/verify-map-complex-recent.ts                    # 20개 화면, 스냅샷 = 변경 번호가 같은 단지만(fresh)
 *   npx tsx scripts/verify-map-complex-recent.ts --snapshot=ignore-marks   # 번호를 보지 않고 저장 내용 그대로 비교
 *   npx tsx scripts/verify-map-complex-recent.ts --n=30 --seed=7
 *
 * ignore-marks 에서 다른 단지가 나오면, 그 단지 저장 내용이 지금 거래로 다시 만든 것과 같은지(낡은 행인지)도 알려 준다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../src/lib/db/client";
import { readMapComplexes, type MapAreaRange, type MapBBox, type MapDealKind } from "../src/lib/map/map-complexes";

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function main() {
  const db = getDb();
  if (!db) throw new Error("TURSO_DATABASE_URL 이 없습니다.");
  const n = Number(argValue("n", "20")) || 20;
  const mode = argValue("snapshot", "fresh") === "ignore-marks" ? "ignore-marks" : "fresh";
  const rand = rng(Number(argValue("seed", "1")) || 1);

  // 화면 중심 — 세대수 큰 단지 주변(마커가 많은 곳) + 무작위 단지
  const centers = await db.execute(
    `SELECT m.latitude AS lat, m.longitude AS lng, m.lawd_cd FROM apt_complex_master m
     WHERE m.latitude IS NOT NULL AND m.rowid % 97 = 0 ORDER BY m.rowid LIMIT 400`,
  );
  const areas: MapAreaRange[] = [
    { min: 0, max: 10_000 },
    { min: 0, max: 60 },
    { min: 60, max: 85.99 },
    { min: 86, max: 10_000 },
  ];
  let same = 0;
  let diff = 0;
  let markers = 0;
  for (let i = 0; i < n; i++) {
    const c = centers.rows[Math.floor(rand() * centers.rows.length)]!;
    const half = 0.01 + rand() * 0.04;
    const bbox: MapBBox = {
      swLat: Number(c.lat) - half,
      neLat: Number(c.lat) + half,
      swLng: Number(c.lng) - half * 1.2,
      neLng: Number(c.lng) + half * 1.2,
    };
    const area = areas[i % areas.length]!;
    const deal: MapDealKind = i % 3 === 2 ? "jeonse" : "trade";
    const snap = await readMapComplexes(db, bbox, area, deal, { snapshot: mode });
    const live = await readMapComplexes(db, bbox, area, deal, { snapshot: "off" });
    markers += live.complexes.length;
    const bad: string[] = [];
    if (snap.truncated !== live.truncated || snap.complexes.length !== live.complexes.length) bad.push("count");
    for (let j = 0; j < Math.min(snap.complexes.length, live.complexes.length); j++) {
      if (JSON.stringify(snap.complexes[j]) !== JSON.stringify(live.complexes[j])) bad.push(live.complexes[j]!.complexId);
    }
    const label = `#${i + 1} lawd=${c.lawd_cd} half=${half.toFixed(3)} area=${area.min}-${area.max} deal=${deal} markers=${live.complexes.length}`;
    if (bad.length) {
      diff += 1;
      console.log(`[verify] DIFF ${label} complexes=${bad.slice(0, 10).join(",")}`);
    } else {
      same += 1;
      console.log(`[verify] same ${label}`);
    }
  }
  console.log(`[verify] SUMMARY mode=${mode} viewports=${n} same=${same} diff=${diff} markers=${markers}`);
  if (diff) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
