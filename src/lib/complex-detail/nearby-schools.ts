/**
 * Nearby schools display helpers (인근 학교 — not catchment / assignment).
 * Reuses NEIS schoolInfo rows; distance from complexMapAnchor via haversine.
 */

import { haversineMeters, type LatLng } from "@/lib/nearby-map/geo";
import type { SchoolLevel } from "@/lib/complex-detail/neis";

export type SchoolLevelCode = "ELEMENTARY" | "MIDDLE" | "HIGH";

export type NearbySchoolPlace = {
  id: string;
  /** NEIS SD_SCHUL_CODE when available. */
  schoolCode: string | null;
  name: string;
  schoolLevel: SchoolLevelCode;
  level: SchoolLevel;
  establishment: string | null;
  address: string | null;
  /** Road-only address preferred for NAVER Geocode. */
  geocodeQuery: string | null;
  lat: number;
  lng: number;
  distanceM: number;
  coordSource: "NEIS" | "NAVER_GEOCODE";
  source: "NEIS";
};

export type NearbySchoolCategory = {
  level: SchoolLevel;
  schoolLevel: SchoolLevelCode;
  label: string;
  places: NearbySchoolPlace[];
};

export const SCHOOL_DISPLAY_MAX_METERS = 1500;
/** No per-level cap — show every school within SCHOOL_DISPLAY_MAX_METERS. */
export const SCHOOL_MAX_PER_LEVEL: number | null = null;
export const SCHOOL_CACHE_VERSION = "school-v2";

export const SCHOOL_LEVEL_ORDER: SchoolLevel[] = [
  "elementary",
  "middle",
  "high",
];

export const SCHOOL_LEVEL_LABEL: Record<SchoolLevel, string> = {
  elementary: "초등학교",
  middle: "중학교",
  high: "고등학교",
};

export const SCHOOL_LEVEL_BADGE: Record<SchoolLevelCode, string> = {
  ELEMENTARY: "초",
  MIDDLE: "중",
  HIGH: "고",
};

export function toSchoolLevelCode(level: SchoolLevel): SchoolLevelCode {
  if (level === "elementary") return "ELEMENTARY";
  if (level === "middle") return "MIDDLE";
  return "HIGH";
}

/**
 * Prefer road address for geocode (drop parenthetical detail that causes ambiguity).
 */
export function schoolGeocodeQuery(
  address: string | null | undefined,
  roadAddress?: string | null,
): string | null {
  const road = String(roadAddress ?? "").trim();
  if (road) return road.replace(/\s+/g, " ").trim();
  const raw = String(address ?? "").trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

/** Minimal school fields needed to build a display place. */
export type NearbySchoolSeed = {
  level: SchoolLevel;
  name: string;
  foundation: string | null;
  address: string | null;
  roadAddress?: string | null;
  schoolCode?: string | null;
};

export function buildNearbySchoolPlace(params: {
  school: NearbySchoolSeed;
  index: number;
  center: LatLng;
  lat: number;
  lng: number;
  coordSource: "NEIS" | "NAVER_GEOCODE";
}): NearbySchoolPlace | null {
  const { school, center, lat, lng, coordSource } = params;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const distanceM = Math.round(haversineMeters(center, { lat, lng }));
  if (!Number.isFinite(distanceM) || distanceM < 0) return null;
  const schoolLevel = toSchoolLevelCode(school.level);
  return {
    id: `school-${school.level}-${params.index}-${school.name}-${lat.toFixed(5)}-${lng.toFixed(5)}`,
    schoolCode: school.schoolCode ?? null,
    name: school.name,
    schoolLevel,
    level: school.level,
    establishment: school.foundation,
    address: school.address,
    geocodeQuery: schoolGeocodeQuery(school.address, school.roadAddress),
    lat,
    lng,
    distanceM,
    coordSource,
    source: "NEIS",
  };
}

/**
 * Keep ≤1.5km, sort distance ASC, all schools per level (no count cap).
 * Empty levels are omitted.
 */
export function selectDisplayedSchools(places: NearbySchoolPlace[]): {
  places: NearbySchoolPlace[];
  categories: NearbySchoolCategory[];
  overRadiusRemoved: number;
  displayed: number;
} {
  let overRadiusRemoved = 0;
  const within: NearbySchoolPlace[] = [];
  for (const p of places) {
    if (p.distanceM <= SCHOOL_DISPLAY_MAX_METERS) within.push(p);
    else overRadiusRemoved += 1;
  }

  const categories: NearbySchoolCategory[] = [];
  const placesOut: NearbySchoolPlace[] = [];

  for (const level of SCHOOL_LEVEL_ORDER) {
    let slice = within
      .filter((p) => p.level === level)
      .sort((a, b) => a.distanceM - b.distanceM);
    if (
      SCHOOL_MAX_PER_LEVEL != null &&
      Number.isFinite(SCHOOL_MAX_PER_LEVEL) &&
      SCHOOL_MAX_PER_LEVEL > 0
    ) {
      slice = slice.slice(0, SCHOOL_MAX_PER_LEVEL);
    }
    if (!slice.length) continue;
    categories.push({
      level,
      schoolLevel: toSchoolLevelCode(level),
      label: SCHOOL_LEVEL_LABEL[level],
      places: slice,
    });
    placesOut.push(...slice);
  }

  return {
    places: placesOut,
    categories,
    overRadiusRemoved,
    displayed: placesOut.length,
  };
}
