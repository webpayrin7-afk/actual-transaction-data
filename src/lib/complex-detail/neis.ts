import {
  formatStraightDistance,
  haversineMeters,
  type LatLng,
} from "@/lib/complex-detail/geo";
import {
  JAMSIL_ELS_NEARBY_DONGS,
  JAMSIL_ELS_NEARBY_GU,
  JAMSIL_ELS_NEIS_NAME_SEEDS,
  SEOUL_OFCDC_CODE,
  auditJamsilElsElementaryCatchment,
  isJamsilElsSchoolPilot,
  type CatchmentAudit,
} from "@/lib/complex-detail/jamsil-els-school-pilot";
import { neisApiKey } from "@/lib/complex-detail/source-status";

export type SchoolLevel = "elementary" | "middle" | "high";

/** Phase 8.1 status — never collapse API failure into "학교 없음". */
export type SchoolPilotStatus =
  | "API_ERROR"
  | "NO_RESULTS"
  | "CATCHMENT_UNVERIFIED"
  | "SUCCESS"
  | "PILOT_ONLY";

export type NearbySchool = {
  level: SchoolLevel;
  name: string;
  /** 공립 / 사립 (FOND_SC_NM). */
  foundation: string | null;
  /** 초등학교 등 (SCHUL_KND_SC_NM). */
  kind: string | null;
  address: string | null;
  /** Null when official school coordinates are unavailable. */
  distanceMeters: number | null;
  /** e.g. "직선거리 420m". Null when distance unknown. */
  distanceLabel: string | null;
  lat: number | null;
  lng: number | null;
};

export type SchoolPilotResult = {
  status: SchoolPilotStatus;
  reason: string;
  schools: NearbySchool[];
  catchment: CatchmentAudit;
  assignmentSupported: boolean;
  attribution: string;
  distanceBasis: string;
  dataAsOf: string;
  complexCoords: LatLng | null;
};

type NeisSchoolRow = {
  SD_SCHUL_CODE?: string;
  SCHUL_NM?: string;
  SCHUL_KND_SC_NM?: string;
  FOND_SC_NM?: string;
  ORG_RDNMA?: string;
  ORG_RDNDA?: string;
  LAT?: string;
  LATITUDE?: string;
  LOT?: string;
  LONGITUDE?: string;
};

const LEVEL_LABEL: Record<SchoolLevel, string> = {
  elementary: "초등학교",
  middle: "중학교",
  high: "고등학교",
};

const NEIS_SCHOOL_INFO = "https://open.neis.go.kr/hub/schoolInfo";

export function schoolLevelLabel(level: SchoolLevel): string {
  return LEVEL_LABEL[level];
}

function classifyLevel(kindNm: string | undefined): SchoolLevel | null {
  const k = kindNm ?? "";
  if (k.includes("초등")) return "elementary";
  if (k.includes("중학교") || k === "중") return "middle";
  if (k.includes("고등") || k.includes("고교")) return "high";
  return null;
}

function rowAddress(row: NeisSchoolRow): string {
  const a = String(row.ORG_RDNMA ?? "").trim();
  const b = String(row.ORG_RDNDA ?? "").trim();
  return [a, b].filter(Boolean).join(" ");
}

function isNearbyJamsilAddress(address: string): boolean {
  if (!address.includes(JAMSIL_ELS_NEARBY_GU)) return false;
  return (JAMSIL_ELS_NEARBY_DONGS as readonly string[]).some((d) =>
    address.includes(d),
  );
}

function parseSchoolCoords(row: NeisSchoolRow): LatLng | null {
  const lat = Number(row.LAT ?? row.LATITUDE);
  const lng = Number(row.LOT ?? row.LONGITUDE);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

function formatDistanceLabel(meters: number): string {
  if (meters < 1000) return `직선거리 ${Math.round(meters)}m`;
  const km = meters / 1000;
  return `직선거리 ${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
}

function toNearbySchool(
  row: NeisSchoolRow,
  complex: LatLng | null,
): NearbySchool | null {
  const level = classifyLevel(row.SCHUL_KND_SC_NM);
  const name = String(row.SCHUL_NM ?? "").trim();
  if (!level || !name) return null;

  const schoolCoords = parseSchoolCoords(row);
  let distanceMeters: number | null = null;
  let distanceLabel: string | null = null;
  if (complex && schoolCoords) {
    distanceMeters = Math.round(
      haversineMeters(
        complex.lat,
        complex.lng,
        schoolCoords.lat,
        schoolCoords.lng,
      ),
    );
    distanceLabel = formatDistanceLabel(distanceMeters);
  }

  return {
    level,
    name,
    foundation: row.FOND_SC_NM ? String(row.FOND_SC_NM).trim() : null,
    kind: row.SCHUL_KND_SC_NM ? String(row.SCHUL_KND_SC_NM).trim() : null,
    address: rowAddress(row) || null,
    distanceMeters,
    distanceLabel,
    lat: schoolCoords?.lat ?? null,
    lng: schoolCoords?.lng ?? null,
  };
}

async function fetchNeisSchoolInfoPage(params: {
  key: string;
  schulNm: string;
  signal?: AbortSignal;
}): Promise<NeisSchoolRow[]> {
  const url = new URL(NEIS_SCHOOL_INFO);
  url.searchParams.set("KEY", params.key);
  url.searchParams.set("Type", "json");
  url.searchParams.set("pIndex", "1");
  url.searchParams.set("pSize", "100");
  url.searchParams.set("ATPT_OFCDC_SC_CODE", SEOUL_OFCDC_CODE);
  url.searchParams.set("SCHUL_NM", params.schulNm);

  const res = await fetch(url.toString(), {
    signal: params.signal,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`NEIS HTTP ${res.status}`);

  const json = (await res.json()) as {
    schoolInfo?: Array<
      | { head?: Array<{ RESULT?: { CODE?: string; MESSAGE?: string } }> }
      | { row?: NeisSchoolRow[] }
    >;
    RESULT?: { CODE?: string; MESSAGE?: string };
  };

  if (json.RESULT?.CODE && json.RESULT.CODE !== "INFO-000") {
    if (json.RESULT.CODE === "INFO-200") return [];
    throw new Error(json.RESULT.MESSAGE || json.RESULT.CODE);
  }

  const block = json.schoolInfo;
  if (!block || block.length < 2) return [];

  const head = block[0] as {
    head?: Array<{ RESULT?: { CODE?: string; MESSAGE?: string } }>;
  };
  const result = head.head?.find((h) => h.RESULT)?.RESULT;
  if (result?.CODE && result.CODE !== "INFO-000") {
    if (result.CODE === "INFO-200") return [];
    throw new Error(result.MESSAGE || result.CODE);
  }

  const body = block[1] as { row?: NeisSchoolRow[] };
  return body.row ?? [];
}

/**
 * Phase 8.1 — real NEIS schoolInfo for 잠실엘스 nearby dongs.
 * No placeholder empty success. No catchment claim. No DB writes.
 */
export async function fetchJamsilElsPilotSchools(params: {
  aptName: string;
  coords?: LatLng | null;
  signal?: AbortSignal;
}): Promise<SchoolPilotResult> {
  const catchment = auditJamsilElsElementaryCatchment();
  const dataAsOf = new Date().toISOString().slice(0, 10);
  const attribution = "NEIS 교육정보개방포털 schoolInfo";
  const distanceBasis =
    "직선거리(하버사인). NEIS schoolInfo에 학교 좌표가 없어 현재 거리 미표시. 도보시간·도보거리 추정 없음.";

  if (!isJamsilElsSchoolPilot(params.aptName)) {
    return {
      status: "PILOT_ONLY",
      reason: "학군 실데이터 연결은 잠실엘스 pilot만 지원합니다.",
      schools: [],
      catchment,
      assignmentSupported: false,
      attribution,
      distanceBasis,
      dataAsOf,
      complexCoords: params.coords ?? null,
    };
  }

  // Prefer env key; never log it. Empty KEY still works for public schoolInfo.
  const key = neisApiKey() ?? "";

  try {
    const merged = new Map<string, NeisSchoolRow>();
    for (const seed of JAMSIL_ELS_NEIS_NAME_SEEDS) {
      const rows = await fetchNeisSchoolInfoPage({
        key,
        schulNm: seed,
        signal: params.signal,
      });
      for (const row of rows) {
        const code = String(row.SD_SCHUL_CODE ?? "").trim();
        const name = String(row.SCHUL_NM ?? "").trim();
        const id = code || name;
        if (!id) continue;
        if (!isNearbyJamsilAddress(rowAddress(row))) continue;
        if (!classifyLevel(row.SCHUL_KND_SC_NM)) continue;
        merged.set(id, row);
      }
    }

    const schools = [...merged.values()]
      .map((row) => toNearbySchool(row, params.coords ?? null))
      .filter((s): s is NearbySchool => s != null)
      .sort((a, b) => {
        const order = { elementary: 0, middle: 1, high: 2 } as const;
        if (order[a.level] !== order[b.level]) {
          return order[a.level] - order[b.level];
        }
        if (a.distanceMeters != null && b.distanceMeters != null) {
          return a.distanceMeters - b.distanceMeters;
        }
        return a.name.localeCompare(b.name, "ko");
      });

    if (schools.length === 0) {
      return {
        status: "NO_RESULTS",
        reason:
          "NEIS 응답은 정상이나 송파구 잠실동·신천동 인근 초·중·고 결과가 없습니다.",
        schools: [],
        catchment,
        assignmentSupported: false,
        attribution,
        distanceBasis,
        dataAsOf,
        complexCoords: params.coords ?? null,
      };
    }

    const status: SchoolPilotStatus =
      catchment.decision === "VERIFIED" ? "SUCCESS" : "CATCHMENT_UNVERIFIED";

    return {
      status,
      reason:
        status === "CATCHMENT_UNVERIFIED"
          ? "인근 학교(NEIS)는 표시합니다. 공식 통학구역은 미검증이라 배정학교로 표시하지 않습니다."
          : "",
      schools,
      catchment,
      assignmentSupported: false,
      attribution,
      distanceBasis,
      dataAsOf,
      complexCoords: params.coords ?? null,
    };
  } catch {
    return {
      status: "API_ERROR",
      reason: "NEIS 학교정보 조회에 실패했습니다.",
      schools: [],
      catchment,
      assignmentSupported: false,
      attribution,
      distanceBasis,
      dataAsOf,
      complexCoords: params.coords ?? null,
    };
  }
}

/**
 * Legacy non-pilot stub — avoids unsafe nationwide dump.
 * Prefer fetchJamsilElsPilotSchools for Phase 8.1.
 */
export async function fetchNearbySchools(_params: {
  coords: LatLng;
  radiusMeters?: number;
  signal?: AbortSignal;
}): Promise<NearbySchool[]> {
  void _params;
  return [];
}

/** Test helper when NEIS rows include coordinates. */
export function rankSchoolsByDistance(
  rows: NeisSchoolRow[],
  coords: LatLng,
  radiusMeters: number,
): NearbySchool[] {
  const out: NearbySchool[] = [];
  for (const row of rows) {
    const school = toNearbySchool(row, coords);
    if (!school || school.distanceMeters == null) continue;
    if (school.distanceMeters > radiusMeters) continue;
    out.push(school);
  }
  out.sort(
    (a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity),
  );
  return out;
}

void formatStraightDistance;
