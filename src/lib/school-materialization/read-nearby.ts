/**
 * 인근 학교 읽기 — 미리 계산된 complex_nearby_schools + school_master (학교알리미).
 * idx_complex_nearby_level (complex_id, school_level, rank_by_distance) 한 번 조회.
 * 인근 학교일 뿐 배정/통학구역 판정 아님. DB 쓰기 없음.
 */

import { getDb } from "@/lib/db/client";
import type { SchoolLevel } from "@/lib/complex-detail/neis";
import { SCHOOL_DISPLAY_MAX_METERS } from "@/lib/complex-detail/nearby-schools";

export type MaterializedNearbySchool = {
  schoolCode: string;
  name: string;
  level: SchoolLevel;
  establishment: string | null;
  address: string | null;
  roadAddress: string | null;
  lat: number | null;
  lng: number | null;
  distanceMeters: number;
  rank: number;
};

export type MaterializedNearbySchools = {
  schools: MaterializedNearbySchool[];
  sourceAsOf: string | null;
  attribution: string | null;
};

const LEVELS = new Set<SchoolLevel>(["elementary", "middle", "high"]);

function str(v: unknown): string | null {
  const s = v == null ? "" : String(v).trim();
  return s || null;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 단지에 계산된 행이 없으면 null (DB 없음 포함). 폐교는 뺀다. */
export async function readMaterializedNearbySchools(
  complexId: string,
): Promise<MaterializedNearbySchools | null> {
  const id = complexId.trim();
  const db = getDb();
  if (!id || !db) return null;

  const res = await db.execute({
    sql: `SELECT n.school_level, n.school_code, n.distance_m, n.rank_by_distance, n.source_as_of,
                 s.school_name, s.establishment_type, s.address, s.road_address,
                 s.lat, s.lng, s.status, s.attribution
            FROM complex_nearby_schools n
            JOIN school_master s ON s.school_code = n.school_code
           WHERE n.complex_id = ? AND n.distance_m <= ?
           ORDER BY n.school_level, n.rank_by_distance`,
    args: [id, SCHOOL_DISPLAY_MAX_METERS],
  });
  if (!res.rows.length) return null;

  const schools: MaterializedNearbySchool[] = [];
  let sourceAsOf: string | null = null;
  let attribution: string | null = null;
  for (const r of res.rows) {
    const level = String(r.school_level) as SchoolLevel;
    if (!LEVELS.has(level) || str(r.status) === "closed") continue;
    const name = str(r.school_name);
    const distance = num(r.distance_m);
    if (!name || distance == null) continue;
    sourceAsOf ??= str(r.source_as_of);
    attribution ??= str(r.attribution);
    schools.push({
      schoolCode: String(r.school_code),
      name,
      level,
      establishment: str(r.establishment_type),
      address: str(r.address),
      roadAddress: str(r.road_address),
      lat: num(r.lat),
      lng: num(r.lng),
      distanceMeters: Math.round(distance),
      rank: num(r.rank_by_distance) ?? 0,
    });
  }
  return { schools, sourceAsOf, attribution };
}
