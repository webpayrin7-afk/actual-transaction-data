/**
 * 지도 '구·동 상세' 버튼과 함께 그리는 지역 표시 — 그 구·동 아파트 단지 좌표를 감싼 볼록 다각형.
 * 행정 경계가 아니라 "단지가 모여 있는 범위"다 (경계 데이터 없음). 읽기 전용, 좌표는 map anchor 우선.
 */
import type { Client } from "@libsql/client";
import { hasAnchorTable } from "@/lib/map/map-complexes";

export type LatLng = { lat: number; lng: number };

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: LatLng[] }>();

/** 단지 마커가 선 위에 걸치지 않게 중심에서 바깥으로 넓히는 거리 (m) */
const PAD_M = 120;

function cross(o: LatLng, a: LatLng, b: LatLng): number {
  return (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng);
}

/** Andrew monotone chain — 반시계 방향 볼록 껍질 */
export function convexHull(points: LatLng[]): LatLng[] {
  const p = [...points].sort((a, b) => a.lng - b.lng || a.lat - b.lat);
  if (p.length < 3) return p;
  const lower: LatLng[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: LatLng[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** 껍질을 중심에서 PAD_M만큼 바깥으로 민다 (점이 1~2개면 작은 원 모양 8각형) */
function pad(hull: LatLng[]): LatLng[] {
  const c = {
    lat: hull.reduce((s, p) => s + p.lat, 0) / hull.length,
    lng: hull.reduce((s, p) => s + p.lng, 0) / hull.length,
  };
  const mLat = 111_320;
  const mLng = 111_320 * Math.cos((c.lat * Math.PI) / 180);
  if (hull.length < 3) {
    const r = PAD_M * 2;
    return Array.from({ length: 8 }, (_, i) => {
      const t = (i / 8) * 2 * Math.PI;
      return { lat: c.lat + (r * Math.sin(t)) / mLat, lng: c.lng + (r * Math.cos(t)) / mLng };
    });
  }
  return hull.map((p) => {
    const dy = (p.lat - c.lat) * mLat;
    const dx = (p.lng - c.lng) * mLng;
    const d = Math.hypot(dx, dy) || 1;
    const k = (d + PAD_M) / d;
    return { lat: c.lat + (dy * k) / mLat, lng: c.lng + (dx * k) / mLng };
  });
}

export async function readRegionShape(db: Client, lawd: string, dong: string | null): Promise<LatLng[]> {
  const key = `${lawd}|${dong ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const anchored = await hasAnchorTable(db);
  const lat = anchored ? "COALESCE(a.lat, m.latitude)" : "m.latitude";
  const lng = anchored ? "COALESCE(a.lng, m.longitude)" : "m.longitude";
  const res = await db.execute({
    sql: `SELECT ${lat} AS lat, ${lng} AS lng
          FROM apt_complex_master m
          ${anchored ? "LEFT JOIN complex_map_anchor a ON a.complex_id = m.complex_id" : ""}
          WHERE m.lawd_cd = ? ${dong ? "AND m.legal_dong_name = ?" : ""}
            AND ${lat} IS NOT NULL AND ${lng} IS NOT NULL`,
    args: dong ? [lawd, dong] : [lawd],
  });
  const points = res.rows
    .map((r) => ({ lat: Number(r.lat), lng: Number(r.lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const value = points.length ? pad(convexHull(points)) : [];
  cache.set(key, { at: Date.now(), value });
  return value;
}
