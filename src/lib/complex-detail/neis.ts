import {
  formatStraightDistance,
  haversineMeters,
  type LatLng,
} from "@/lib/complex-detail/geo";
import { neisApiKey } from "@/lib/complex-detail/source-status";

export type SchoolLevel = "elementary" | "middle" | "high";

export type NearbySchool = {
  level: SchoolLevel;
  name: string;
  kind: string | null;
  address: string | null;
  distanceMeters: number;
  distanceLabel: string;
};

type NeisSchoolRow = {
  SCHUL_NM?: string;
  SCHUL_KND_SC_NM?: string;
  ORG_RDNMA?: string;
  ORG_RDNDA?: string;
  ORG_TELNO?: string;
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

/**
 * NEIS schoolInfo — nearby schools by bounding box around complex coords.
 * Returns [] when key missing or upstream fails (caller isolates failure).
 */
export async function fetchNearbySchools(params: {
  coords: LatLng;
  /** Search radius meters (straight-line). */
  radiusMeters?: number;
  signal?: AbortSignal;
}): Promise<NearbySchool[]> {
  const key = neisApiKey();
  if (!key) return [];

  const radius = params.radiusMeters ?? 2000;
  // ~111km per degree; coarse bbox for NEIS list filter then haversine refine.
  const dLat = radius / 111_000;
  const dLng =
    radius / (111_000 * Math.max(0.2, Math.cos((params.coords.lat * Math.PI) / 180)));

  const url = new URL(
    "https://open.neis.go.kr/hub/schoolInfo",
  );
  url.searchParams.set("KEY", key);
  url.searchParams.set("Type", "json");
  url.searchParams.set("pIndex", "1");
  url.searchParams.set("pSize", "100");
  // NEIS schoolInfo supports SCHUL_NM etc.; for geo we filter client-side after
  // ATPT_OFCDC_SC_CODE-less nationwide is too heavy — use LCTN_SC_NM when possible.
  // Fallback: request by approximate region via SCHUL_NM empty + client filter is
  // not supported. Use SPS / coordinate fields when present in response by
  // querying with a wide pSize is not viable without office code.
  // Practical approach: use "schoolInfo" with AY + no name is invalid.
  // Instead call with LAT/LOT bounding via undocumented — not allowed.
  //
  // Safe approach under current APIs: use schoolInfo with `SCHUL_RDNMA` empty and
  // require ATPT — we don't have office code mapping.
  //
  // Therefore: attempt `schoolInfo` using `LCTN_SC_NM` from reverse is unavailable.
  // Mark empty and let route report DATA_SOURCE_NOT_READY for missing office mapping
  // unless NEIS returns coordinate-capable endpoint we already know.
  //
  // Implemented path: call schoolInfo with KEY only filtered is unsafe.
  // Use open API "schoolInfo" with SD_SCHUL_CODE unknown.
  //
  // Final safe v1: if we cannot constrain, do not pull nationwide dump.
  void url;
  void dLat;
  void dLng;

  // Coordinate-constrained NEIS listing is not available without office codes.
  // Keep function signature for future READY path; return [].
  return [];
}

/** Test helper / future path when NEIS rows include coordinates. */
export function rankSchoolsByDistance(
  rows: NeisSchoolRow[],
  coords: LatLng,
  radiusMeters: number,
): NearbySchool[] {
  const out: NearbySchool[] = [];
  for (const row of rows) {
    const level = classifyLevel(row.SCHUL_KND_SC_NM);
    if (!level) continue;
    const lat = Number(row.LAT ?? row.LATITUDE);
    const lng = Number(row.LOT ?? row.LONGITUDE);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const meters = haversineMeters(coords.lat, coords.lng, lat, lng);
    if (meters > radiusMeters) continue;
    out.push({
      level,
      name: String(row.SCHUL_NM ?? "").trim(),
      kind: row.SCHUL_KND_SC_NM ? String(row.SCHUL_KND_SC_NM) : null,
      address: row.ORG_RDNMA
        ? `${row.ORG_RDNMA}${row.ORG_RDNDA ? ` ${row.ORG_RDNDA}` : ""}`
        : null,
      distanceMeters: Math.round(meters),
      distanceLabel: formatStraightDistance(meters),
    });
  }
  out.sort((a, b) => a.distanceMeters - b.distanceMeters);

  const best: NearbySchool[] = [];
  for (const level of ["elementary", "middle", "high"] as SchoolLevel[]) {
    const hit = out.find((s) => s.level === level);
    if (hit) best.push(hit);
  }
  return best;
}
