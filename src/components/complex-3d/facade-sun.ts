/**
 * 외벽 일조 — 건물을 "외곽선을 위로 밀어 올린 기둥(프리즘)"으로 보고 햇빛 광선이 막히는지 계산한다.
 * 장면의 건물 모형도 외곽선을 그대로 밀어 올린 것이라, 삼각형마다 광선을 쏘는 것과 결과가 같고 훨씬 가볍다
 * (단지 전체 동 × 층 구간 × 하루 10분 간격을 휴대폰에서 계산할 수 있게).
 * 좌표: 단지 중심 기준 미터, x = 동쪽, y = 위, z = 남쪽.
 */

export type Prism = {
  id: string;
  /** 외곽선 외접원 (평면) */
  cx: number;
  cz: number;
  r: number;
  bot: number;
  top: number;
  /** 변 [ax, az, bx, bz, ...] */
  edges: Float64Array;
};

export function makePrism(id: string, rings: Array<Array<{ x: number; z: number }>>, bot: number, top: number): Prism | null {
  const seg: number[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const ring of rings) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[i + 1]!;
      seg.push(a.x, a.z, b.x, b.z);
      minX = Math.min(minX, a.x);
      maxX = Math.max(maxX, a.x);
      minZ = Math.min(minZ, a.z);
      maxZ = Math.max(maxZ, a.z);
    }
  }
  if (!seg.length) return null;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  return { id, cx, cz, r: Math.hypot(maxX - minX, maxZ - minZ) / 2 + 0.01, bot, top, edges: new Float64Array(seg) };
}

/**
 * 광선(원점 o, 방향 d — d.y > 0, 해 쪽)이 prisms 중 하나에 막히는지.
 * 기둥 옆면을 지나는 곳의 광선 높이가 지붕보다 낮으면 막힌 것 (바닥보다 낮으면 땅·언덕이 막은 것으로 본다).
 */
export function sunBlocked(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  prisms: Prism[],
  maxDist = 1500,
): boolean {
  const h = Math.hypot(dx, dz);
  if (h < 1e-6) return false;
  const ux = dx / h;
  const uz = dz / h;
  const slope = dy / h; // 수평 1m 갈 때 오르는 높이
  for (const p of prisms) {
    const vx = p.cx - ox;
    const vz = p.cz - oz;
    const along = vx * ux + vz * uz;
    if (along < -p.r || along - p.r > maxDist) continue;
    if (Math.abs(vx * uz - vz * ux) > p.r) continue;
    // 가장 가까운 지점에서도 이미 지붕보다 높으면 통과
    if (oy + slope * Math.max(0, along - p.r) > p.top) continue;
    const e = p.edges;
    for (let i = 0; i < e.length; i += 4) {
      const ax = e[i]!;
      const az = e[i + 1]!;
      const ex = e[i + 2]! - ax;
      const ez = e[i + 3]! - az;
      const den = ux * ez - uz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const wx = ax - ox;
      const wz = az - oz;
      const s = (wx * ez - wz * ex) / den;
      if (s <= 0.05 || s > maxDist) continue;
      const t = (wx * uz - wz * ux) / den;
      if (t < 0 || t > 1) continue;
      if (oy + slope * s <= p.top) return true;
    }
  }
  return false;
}

/** 원점에서 볼 때 앞쪽(법선 n 쪽 반평면)과 maxDist 안에 있는 기둥만 — 한 창 위치에서 여러 시각을 쏠 때 미리 거른다 */
export function prismsInFront(prisms: Prism[], ox: number, oz: number, nx: number, nz: number, maxDist = 1500): Prism[] {
  return prisms.filter((p) => {
    const vx = p.cx - ox;
    const vz = p.cz - oz;
    return vx * nx + vz * nz > -p.r && Math.hypot(vx, vz) - p.r < maxDist;
  });
}

/** 하루 해 드는 시간(시간) 구간 색 — 0~1, 1~2, …, 6시간 이상 (차가운 색 → 따뜻한 색) */
export const FACADE_SUN_COLORS = ["#3f4a68", "#5d5f9e", "#8c64a8", "#c0679a", "#e9785f", "#f5a742", "#f9d648"] as const;

export function facadeSunColor(hours: number): string {
  return FACADE_SUN_COLORS[Math.max(0, Math.min(6, Math.floor(hours)))]!;
}

/**
 * 수평 광선(원점 o, 평면 방향 u — 단위 벡터)이 처음 닿는 기둥까지 거리와 그 기둥 id.
 * 광선 높이 oy가 기둥 바닥~지붕 사이일 때만 닿는다 (장면의 건물 모형과 같은 결과). minDist 안은 무시.
 */
export function firstPrismHit(
  ox: number,
  oy: number,
  oz: number,
  ux: number,
  uz: number,
  prisms: Prism[],
  maxDist: number,
  minDist = 0.2,
): { d: number; id: string } | null {
  let best: { d: number; id: string } | null = null;
  for (const p of prisms) {
    if (oy < p.bot || oy > p.top) continue;
    const vx = p.cx - ox;
    const vz = p.cz - oz;
    const along = vx * ux + vz * uz;
    if (along < -p.r || along - p.r > (best?.d ?? maxDist)) continue;
    if (Math.abs(vx * uz - vz * ux) > p.r) continue;
    const e = p.edges;
    for (let i = 0; i < e.length; i += 4) {
      const ax = e[i]!;
      const az = e[i + 1]!;
      const ex = e[i + 2]! - ax;
      const ez = e[i + 3]! - az;
      const den = ux * ez - uz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const wx = ax - ox;
      const wz = az - oz;
      const s = (wx * ez - wz * ex) / den;
      if (s <= minDist || s > (best?.d ?? maxDist)) continue;
      const t = (wx * uz - wz * ux) / den;
      if (t < 0 || t > 1) continue;
      best = { d: s, id: p.id };
    }
  }
  return best;
}
