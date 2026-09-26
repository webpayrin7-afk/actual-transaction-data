import type { Map as MlMap } from "maplibre-gl";

/**
 * 단지를 고를 때 어느 쪽에서 볼지 — 지금 카메라 방향은 보지 않고, 단지를 가장 덜 가리는 방향.
 *
 * 방향마다(15°씩) 카메라가 놓일 쪽(보는 방향의 반대)의 건물 타일을 보고, 단지 가운데(높이의 절반)에서
 * 카메라로 올라가는 시선(기울기에 따른 오르막)보다 높이 솟은 만큼을 더해 '가림 점수'로 삼는다.
 * 여기에 '보기 좋음'을 더한다 — 동의 긴 면(앞·뒷면)이 보이게(좁은 옆면만 보이는 방향은 벌점),
 * 그중 남쪽에서 보는 쪽(아파트 앞면이 보통 남향)을 조금 더. 15°마다 돌려 본다.
 * 어느 쪽이든 많이 가리면 더 내려다보게(기울기를 줄여) 한다.
 */

const SECTOR_DEG = 28;
const REACH_M = 450;
/** 긴 면 대신 옆면을 볼 때 벌점 (가림 점수 단위: m) */
const SIDE_PENALTY = 40;
/** 북쪽에서(뒷면을) 볼 때 벌점 */
const BACK_PENALTY = 12;
const STEP_DEG = 15;

export type BestView = { bearing: number; pitch: number; score: number };

export function chooseBestView(
  map: MlMap,
  center: [number, number],
  heightM: number,
  isOwn: (lng: number, lat: number) => boolean,
  opts: { pitch: number; steepPitch: number; axisDeg?: number | null },
): BestView {
  const [clng, clat] = center;
  const kx = 111_320 * Math.cos((clat * Math.PI) / 180);
  // 둘레 건물 (단지 것 빼고): 단지 가운데에서의 방위·거리·높이
  const obstacles: Array<{ az: number; d: number; h: number }> = [];
  const seen = new Set<string>();
  for (const f of map.querySourceFeatures("buildings", { sourceLayer: "buildings" })) {
    const g = f.geometry;
    if (g.type !== "Polygon") continue;
    const ring = g.coordinates[0] as Array<[number, number]>;
    if (!ring || ring.length < 4) continue;
    let sx = 0;
    let sy = 0;
    const n = ring.length - 1;
    for (let i = 0; i < n; i++) {
      sx += ring[i]![0];
      sy += ring[i]![1];
    }
    const lng = sx / n;
    const lat = sy / n;
    const h = Number(f.properties?.h) || 0;
    if (h < 8) continue;
    const key = `${lng.toFixed(6)},${lat.toFixed(6)},${h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dx = (lng - clng) * kx;
    const dy = (lat - clat) * 111_320;
    const d = Math.hypot(dx, dy);
    if (d > REACH_M || d < 20) continue;
    if (isOwn(lng, lat)) continue;
    // 방위: 북 0°, 동 90°
    const az = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
    obstacles.push({ az, d, h });
  }

  const scoreFor = (bearing: number, pitch: number) => {
    // 카메라는 보는 방향의 반대쪽 (bearing 0 = 북쪽을 봄 → 카메라는 남쪽 180°)
    const camAz = (bearing + 180) % 360;
    const rise = Math.tan(((90 - pitch) * Math.PI) / 180); // 시선이 1m 멀어질 때 오르는 높이
    const eye = heightM * 0.5;
    let s = 0;
    for (const o of obstacles) {
      const diff = Math.abs(((o.az - camAz + 540) % 360) - 180);
      if (diff > SECTOR_DEG) continue;
      const over = o.h - (eye + rise * o.d);
      if (over > 0) s += over * (1 - diff / (SECTOR_DEG * 1.5));
    }
    return s;
  };

  const look = (b: number) => {
    const r = (b * Math.PI) / 180;
    // 긴 면 보기: 보는 방향이 동의 긴 축과 수직일수록 좋다 (축을 모르면 벌점 없음)
    const side = opts.axisDeg == null ? 0 : 1 - Math.abs(Math.sin(r - (opts.axisDeg * Math.PI) / 180));
    // 앞면(남향) 보기: 북쪽을 바라볼수록(카메라가 남쪽) 좋다
    const back = (1 - Math.cos(r)) / 2;
    return side * SIDE_PENALTY + back * BACK_PENALTY;
  };
  let best: BestView = { bearing: 0, pitch: opts.pitch, score: Infinity };
  for (let b = 0; b < 360; b += STEP_DEG) {
    const s = scoreFor(b, opts.pitch) + look(b);
    if (s < best.score) best = { bearing: b > 180 ? b - 360 : b, pitch: opts.pitch, score: s };
  }
  // 가장 나은 쪽도 많이 가리면 더 내려다보게
  const bestRaw = scoreFor((best.bearing + 360) % 360, opts.pitch);
  if (bestRaw > Math.max(30, heightM * 0.6)) best = { ...best, pitch: opts.steepPitch };
  return best;
}
