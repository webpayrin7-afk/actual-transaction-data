/**
 * 초등학교 통학구역 읽기 (서버 전용) — complex_elem_school_zones → elem_school_zones · elem_school_zone_schools.
 * 한 단지씩만 읽는다 (여러 단지를 한꺼번에 주는 길은 두지 않는다). DB 쓰기 없음.
 * 판정(단지 좌표 ∈ 통학구역 원본 도형)은 scripts/school-zones 에서 미리 해 둔 것.
 */

import type { Client } from "@libsql/client";
import { readRoutes } from "@/lib/complex-3d/walk-store";

export const ELEM_ZONE_SOURCE_LABEL = "한국지방교육행정연구재단·한국교육시설안전원 통학구역";
export const ELEM_ZONE_NOTE = "정확한 배정은 관할 교육지원청에 확인하세요";

export type ElemZoneSchool = {
  name: string;
  /** school_master.school_code — 학교명+시도 정확 일치일 때만 */
  schoolCode: string | null;
  establishment: string | null;
  roadAddress: string | null;
  /** 단지 기본 걷기 경로(complex_walk_routes)에 이 학교가 있을 때만 — 신호 대기 포함 분 */
  walkMin: number | null;
};

export type ElemZone = {
  zoneId: string;
  name: string;
  kind: "single" | "joint";
  /** 단지 동 넓이 중 이 구역에 든 비율 (동별 판정). 한 점 판정이면 null */
  share: number | null;
  schools: ElemZoneSchool[];
};

export type ComplexElemZones = {
  zones: ElemZone[];
  /** 통학구역 도형 기준일 (YYYY-MM-DD) */
  baseDate: string | null;
  /** 지도용 — geometry 를 청한 경우만 */
  geometry?: GeoJSON.FeatureCollection;
  bbox?: [number, number, number, number] | null;
};

function str(v: unknown): string | null {
  const s = v == null ? "" : String(v).trim();
  return s || null;
}

/** 이 단지 기본 걷기 경로의 학교별 분 (없으면 빈 Map) */
async function walkMinutesBySchool(db: Client, complexId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const p = await readRoutes(db, complexId, "walk");
  for (const d of p?.destinations ?? []) {
    if (d.kind !== "school" || !Number.isFinite(d.totalMin)) continue;
    out.set(d.name.replace(/\s+/g, ""), Math.max(1, Math.round(d.totalMin)));
  }
  return out;
}

/**
 * 단지의 통학구역. 계산 행이 없거나 테이블이 없으면 null.
 * 통학구역(single)을 먼저, 공동통학구역(joint)을 뒤에.
 */
export async function readComplexElemZones(
  db: Client,
  complexId: string,
  opts: { geometry?: boolean; walk?: boolean } = {},
): Promise<ComplexElemZones | null> {
  const id = complexId.trim();
  if (!id) return null;
  const read = (withShare: boolean) =>
    db.execute({
      sql: `SELECT z.zone_id, z.zone_name, z.zone_kind, z.base_date, z.bbox${opts.geometry ? ", z.geojson" : ""}${withShare ? ", c.share" : ""},
                     s.facility_school_id, s.school_name, s.school_code,
                     m.establishment_type, m.road_address
                FROM complex_elem_school_zones c
                JOIN elem_school_zones z ON z.zone_id = c.zone_id
                LEFT JOIN elem_school_zone_schools s ON s.zone_id = z.zone_id
                LEFT JOIN school_master m ON m.school_code = s.school_code
               WHERE c.complex_id = ?
               ORDER BY CASE z.zone_kind WHEN 'single' THEN 0 ELSE 1 END, ${withShare ? "c.share DESC, " : ""}z.zone_id, s.school_name`,
      args: [id],
    });
  let rows;
  try {
    rows = (await read(true).catch(() => read(false))).rows;
  } catch {
    return null; // 테이블이 아직 없는 환경
  }
  if (!rows.length) return null;

  const walk = opts.walk ? await walkMinutesBySchool(db, id).catch(() => new Map<string, number>()) : null;
  const byZone = new Map<string, ElemZone>();
  const geoms = new Map<string, { kind: string; geojson: string; bbox: string | null }>();
  let baseDate: string | null = null;
  for (const r of rows) {
    const zoneId = String(r.zone_id);
    let z = byZone.get(zoneId);
    if (!z) {
      z = {
        zoneId,
        name: String(r.zone_name),
        kind: String(r.zone_kind) === "joint" ? "joint" : "single",
        share: r.share != null && Number.isFinite(Number(r.share)) ? Number(r.share) : null,
        schools: [],
      };
      byZone.set(zoneId, z);
      baseDate ??= str(r.base_date);
      if (opts.geometry && r.geojson != null) {
        geoms.set(zoneId, { kind: z.kind, geojson: String(r.geojson), bbox: str(r.bbox) });
      }
    }
    const name = str(r.school_name);
    if (!name) continue;
    z.schools.push({
      name,
      schoolCode: str(r.school_code),
      establishment: str(r.establishment_type),
      roadAddress: str(r.road_address),
      walkMin: walk?.get(name.replace(/\s+/g, "")) ?? null,
    });
  }

  const out: ComplexElemZones = { zones: [...byZone.values()], baseDate };
  if (opts.geometry) {
    const features: GeoJSON.Feature[] = [];
    let bb: [number, number, number, number] | null = null;
    for (const [zoneId, g] of geoms) {
      try {
        features.push({
          type: "Feature",
          properties: { zoneId, kind: g.kind },
          geometry: JSON.parse(g.geojson) as GeoJSON.Geometry,
        });
        const b = g.bbox ? (JSON.parse(g.bbox) as number[]) : null;
        if (b && b.length === 4) {
          bb = bb
            ? [Math.min(bb[0], b[0]!), Math.min(bb[1], b[1]!), Math.max(bb[2], b[2]!), Math.max(bb[3], b[3]!)]
            : [b[0]!, b[1]!, b[2]!, b[3]!];
        }
      } catch {
        /* 깨진 도형은 뺀다 */
      }
    }
    out.geometry = { type: "FeatureCollection", features };
    out.bbox = bb;
  }
  return out;
}
