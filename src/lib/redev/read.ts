/**
 * 서울 정비사업 (재개발·재건축) — 읽기 전용.
 * 원천: 서울시 UPIS 의제처리구역(redev_zones, 2026-09) · 서울시 정비사업 추진현황(redev_projects, 2026-06-30 기준)
 * · 연결(redev_links: 사업↔구역 = 구역명 정확 일치 또는 지번 좌표가 들어간 구역 1개, 단지↔구역 = 단지 좌표가 구역 안).
 * 값은 원천 그대로. 표가 없으면 빈 결과.
 */
import type { Client } from "@libsql/client";

/** 정비사업 성격의 구역만 (토지구획정리·택지개발 같은 옛 개발지구는 뺀다) */
export const REDEV_ZONE_CATEGORIES = [
  "UQ1206", // 주택재건축사업
  "UQ1211", // 주거환경개선사업
  "UQ1212", // 주거환경관리사업
  "UQ1220", // 재개발사업구역
  "UQ1221", // 주택정비형 재개발구역
  "UQ1222", // 도시정비형 재개발구역
  "UQ1231", // 주택정비형 재개발지구
  "UQ1232", // 도시정비형 재개발지구
  "UQ1240", // 재건축사업구역
  "UQ1250", // 결합정비구역
  "UQ5110", // 주거지형재정비촉진지구
  "UQ5120", // 중심지형재정비촉진지구
  "UQ5140", // 존치정비구역
  "UQ6400", // 시장정비구역
] as const;

/** 사업 단계 (추진현황 표의 순서) */
export const REDEV_STAGES = ["구역지정", "추진위", "조합설립", "건축심의", "사업시행", "관리처분", "이주", "착공"] as const;
export type RedevStage = (typeof REDEV_STAGES)[number];

export type RedevProject = {
  code: string;
  gu: string;
  zoneName: string;
  projectType: string | null;
  /** "재건축" | "재개발" | 원천 유형 */
  kind: "재건축" | "재개발" | "기타";
  stage: string | null;
  stageIndex: number;
  publicPrivate: string | null;
  districtType: string | null;
  householdsBefore: number | null;
  householdsTotal: number | null;
  householdsSale: number | null;
  householdsRent: number | null;
  /** 단계별 날짜 (가장 최근 값 — 변경이 있으면 변경일) */
  dates: Array<{ stage: RedevStage; date: string | null }>;
  baseDate: string;
};

export type RedevZone = {
  zoneId: string;
  name: string;
  category: string | null;
  gu: string | null;
  noticeDate: string | null;
  lat: number;
  lng: number;
};

export type ComplexRedev = { zone: RedevZone; project: RedevProject | null };

const str = (v: unknown) => (v == null || v === "" ? null : String(v));
const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function kindOf(projectType: string | null): RedevProject["kind"] {
  if (!projectType) return "기타";
  if (projectType.includes("재건축")) return "재건축";
  if (projectType.includes("재개발")) return "재개발";
  return "기타";
}

function toProject(r: Record<string, unknown>): RedevProject {
  const stage = str(r.stage);
  const d = (a: unknown, b?: unknown) => str(b) ?? str(a);
  return {
    code: String(r.code),
    gu: String(r.gu),
    zoneName: String(r.zone_name),
    projectType: str(r.project_type),
    kind: kindOf(str(r.project_type)),
    stage,
    stageIndex: stage ? REDEV_STAGES.indexOf(stage as RedevStage) : -1,
    publicPrivate: str(r.public_private),
    districtType: str(r.district_type),
    householdsBefore: num(r.households_before),
    householdsTotal: num(r.households_total),
    householdsSale: num(r.households_sale),
    householdsRent: num(r.households_rent),
    dates: [
      { stage: "구역지정", date: d(r.zone_designated_first, r.zone_designated_last) },
      { stage: "추진위", date: str(r.committee_approved) },
      { stage: "조합설립", date: str(r.association_approved) },
      { stage: "건축심의", date: str(r.building_review) },
      { stage: "사업시행", date: d(r.project_approved_first, r.project_approved_last) },
      { stage: "관리처분", date: d(r.disposal_approved_first, r.disposal_approved_last) },
      { stage: "이주", date: str(r.relocation_start) },
      { stage: "착공", date: str(r.construction_start) },
    ],
    baseDate: String(r.base_date),
  };
}

function toZone(r: Record<string, unknown>): RedevZone {
  return {
    zoneId: String(r.zone_id),
    name: String(r.name),
    category: str(r.category_name),
    gu: str(r.gu),
    noticeDate: str(r.notice_date),
    lat: Number(r.lat),
    lng: Number(r.lng),
  };
}

const CAT_SQL = REDEV_ZONE_CATEGORIES.map((c) => `'${c}'`).join(",");

/** 단지가 들어간 정비 구역과 (있으면) 사업 단계. 사업 단계가 있는 것이 앞. */
export async function readComplexRedev(db: Client, complexId: string): Promise<ComplexRedev[]> {
  try {
    const res = await db.execute({
      sql: `SELECT z.zone_id, z.name, z.category_name, z.gu, z.notice_date, z.lat, z.lng, p.*
            FROM redev_links l
            JOIN redev_zones z ON z.zone_id = l.zone_id AND z.category_code IN (${CAT_SQL})
            LEFT JOIN redev_links pl ON pl.kind = 'project_zone' AND pl.zone_id = z.zone_id
            LEFT JOIN redev_projects p ON p.code = pl.ref_id
            WHERE l.kind = 'complex_zone' AND l.ref_id = ?`,
      args: [complexId],
    });
    const out: ComplexRedev[] = res.rows.map((r) => {
      const row = r as unknown as Record<string, unknown>;
      return { zone: toZone(row), project: row.code != null ? toProject(row) : null };
    });
    return out.sort((a, b) => Number(!!b.project) - Number(!!a.project));
  } catch {
    return [];
  }
}

export type RedevZoneShape = RedevZone & {
  rings: Array<Array<[number, number]>>;
  project: Pick<RedevProject, "code" | "kind" | "stage" | "stageIndex" | "projectType" | "householdsTotal" | "zoneName"> | null;
};

/** 지도 영역 안 정비 구역 (대표점 기준, 최대 400) */
export async function readRedevZonesInBbox(
  db: Client,
  bbox: { swLat: number; swLng: number; neLat: number; neLng: number },
): Promise<RedevZoneShape[]> {
  try {
    const res = await db.execute({
      sql: `SELECT z.zone_id, z.name, z.category_name, z.gu, z.notice_date, z.lat, z.lng, z.rings,
                   p.code, p.zone_name, p.project_type, p.stage, p.households_total
            FROM redev_zones z
            LEFT JOIN redev_links pl ON pl.kind = 'project_zone' AND pl.zone_id = z.zone_id
            LEFT JOIN redev_projects p ON p.code = pl.ref_id
            WHERE z.category_code IN (${CAT_SQL})
              AND z.lat BETWEEN ? AND ? AND z.lng BETWEEN ? AND ?
            LIMIT 400`,
      args: [bbox.swLat - 0.01, bbox.neLat + 0.01, bbox.swLng - 0.01, bbox.neLng + 0.01],
    });
    const seen = new Set<string>();
    const out: RedevZoneShape[] = [];
    for (const r of res.rows) {
      const row = r as unknown as Record<string, unknown>;
      const id = String(row.zone_id);
      if (seen.has(id)) continue;
      seen.add(id);
      let rings: Array<Array<[number, number]>> = [];
      try {
        const parsed = JSON.parse(String(row.rings)) as unknown;
        // [[[lng,lat],…],…] 또는 멀티폴리곤 [[[[lng,lat]]]] 모두 받는다
        const flat = (x: unknown): Array<Array<[number, number]>> =>
          Array.isArray(x) && Array.isArray(x[0]) && typeof (x[0] as unknown[])[0] === "number"
            ? [x as Array<[number, number]>]
            : Array.isArray(x)
              ? (x as unknown[]).flatMap(flat)
              : [];
        rings = flat(parsed).filter((ring) => ring.length >= 3);
      } catch {
        rings = [];
      }
      const stage = str(row.stage);
      out.push({
        ...toZone(row),
        rings,
        project:
          row.code != null
            ? {
                code: String(row.code),
                zoneName: String(row.zone_name),
                projectType: str(row.project_type),
                kind: kindOf(str(row.project_type)),
                stage,
                stageIndex: stage ? REDEV_STAGES.indexOf(stage as RedevStage) : -1,
                householdsTotal: num(row.households_total),
              }
            : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}
