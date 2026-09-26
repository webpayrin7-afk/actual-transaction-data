/**
 * 지도 가운데가 어느 시·군·구인지 — map_boundaries(국토지리정보원 행정경계, 구 단위) 점-다각형 판정.
 * 구 목록(코드·이름·중심점, 260여 줄)은 한 번 읽어 두고, 가운데에서 가까운 몇 곳의 경계만 읽어(코드별 기억) 안에 드는지 본다.
 * 읽기 전용. 경계 안에 없으면(바다·경계 틈) 가까운 중심점(15km 안)으로 대신한다.
 */
import type { Client } from "@libsql/client";
import { METRO_LABELS, metroFromLawdNationwide, type NationwideMetro } from "@/lib/constants/nationwide-lawd";

export type RegionAt = {
  /** 시·군·구 LAWD 5자리 (경계 코드 기준 — 광주·전남은 옛 코드) */
  lawdCd: string;
  /** 구 이름 (수원시 영통구 → 영통구) */
  name: string;
  metro: NationwideMetro;
  metroLabel: string;
};

type GuRow = { code: string; name: string; lat: number; lng: number };

const LIST_TTL_MS = 24 * 60 * 60 * 1000;
/** 경계를 확인할 가까운 구 개수 */
const CANDIDATES = 6;
const NEAREST_FALLBACK_KM = 15;
const RINGS_CACHE_MAX = 80;

let guList: { at: number; rows: GuRow[] } | null = null;
const ringsCache = new Map<string, number[][][]>();

async function readGuList(db: Client): Promise<GuRow[]> {
  if (guList && Date.now() - guList.at < LIST_TTL_MS) return guList.rows;
  const has = await db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='map_boundaries'");
  if (!has.rows.length) {
    guList = { at: Date.now(), rows: [] };
    return [];
  }
  const res = await db.execute("SELECT code, name, lat, lng FROM map_boundaries WHERE level = 'gu'");
  const all = res.rows
    .map((r) => ({ code: String(r.code).slice(0, 5), name: String(r.name ?? ""), lat: Number(r.lat), lng: Number(r.lng) }))
    .filter((r) => /^\d{5}$/.test(r.code) && Number.isFinite(r.lat) && Number.isFinite(r.lng));
  // 구가 있는 시(수원시 41110 ↔ 영통구 41117)는 겹치므로 구만 남긴다
  const rows = all.filter(
    (r) => !(r.code.endsWith("0") && all.some((o) => o.code !== r.code && o.code.slice(0, 4) === r.code.slice(0, 4))),
  );
  guList = { at: Date.now(), rows };
  return rows;
}

function km(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = (aLat - bLat) * 111.32;
  const dLng = (aLng - bLng) * 111.32 * Math.cos(((aLat + bLat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLng);
}

/** 짝홀 규칙 — 여러 고리(섬·구멍)를 한꺼번에 */
function inside(rings: number[][][], lat: number, lng: number): boolean {
  let hit = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi! > lat !== yj! > lat && lng < ((xj! - xi!) * (lat - yi!)) / (yj! - yi!) + xi!) hit = !hit;
    }
  }
  return hit;
}

async function readRings(db: Client, codes: string[]): Promise<Map<string, number[][][]>> {
  const out = new Map<string, number[][][]>();
  const missing = codes.filter((c) => {
    const hit = ringsCache.get(c);
    if (hit) out.set(c, hit);
    return !hit;
  });
  if (missing.length) {
    const res = await db.execute({
      sql: `SELECT code, rings FROM map_boundaries WHERE level = 'gu' AND code IN (${missing.map(() => "?").join(",")})`,
      args: missing.map((c) => `${c}00000`),
    });
    for (const r of res.rows) {
      const code = String(r.code).slice(0, 5);
      try {
        const rings = JSON.parse(String(r.rings)) as number[][][];
        out.set(code, rings);
        ringsCache.set(code, rings);
        if (ringsCache.size > RINGS_CACHE_MAX) ringsCache.delete(ringsCache.keys().next().value!);
      } catch {
        /* 깨진 경계는 건너뛴다 */
      }
    }
  }
  return out;
}

function toResult(row: GuRow): RegionAt {
  const metro = metroFromLawdNationwide(row.code);
  const name = row.name.split(/\s+/).pop() || row.name;
  return { lawdCd: row.code, name, metro, metroLabel: METRO_LABELS[metro] ?? "기타" };
}

export async function readRegionAt(db: Client, lat: number, lng: number): Promise<RegionAt | null> {
  const rows = await readGuList(db);
  if (!rows.length) return null;
  const near = rows
    .map((r) => ({ r, d: km(lat, lng, r.lat, r.lng) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, CANDIDATES);
  const rings = await readRings(
    db,
    near.map((n) => n.r.code),
  );
  for (const { r } of near) {
    const ring = rings.get(r.code);
    if (ring && inside(ring, lat, lng)) return toResult(r);
  }
  const first = near[0];
  return first && first.d <= NEAREST_FALLBACK_KM ? toResult(first.r) : null;
}
