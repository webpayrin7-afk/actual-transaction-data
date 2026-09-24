import { DISTANCE_BASIS, NEARBY_CLASSIFICATION, NEARBY_RADIUS_M, haversineMeters } from "./parse";

export type NearbyDeltaAction = "reuse" | "materialize" | "rebuild" | "skip_no_coordinate";

export type NearbyReadState =
  | "NO_COORDINATE"
  | "NOT_MATERIALIZED"
  | "NO_SCHOOLS_WITHIN_RADIUS"
  | "READY";

const KOREA_LAT = { min: 33, max: 39.5 };
const KOREA_LNG = { min: 124, max: 132.5 };

/**
 * Canonical complex point already stored on apt_complex_master.
 * SCHOOL does not invent coordinates. A point is usable only when the
 * identity-ready parcel columns are inside Korea and not the 0,0 placeholder.
 */
export function isSafeParcelPoint(
  lat: number | null,
  lng: number | null,
  identityStatus: string | null,
): boolean {
  if (lat == null || lng == null) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  if (lat < KOREA_LAT.min || lat > KOREA_LAT.max) return false;
  if (lng < KOREA_LNG.min || lng > KOREA_LNG.max) return false;
  return identityStatus === "IDENTITY-READY";
}

/** Stable version so a later parcel-point change rebuilds only that complex. */
export function parcelCoordVersion(lat: number, lng: number): string {
  const latKey = (Math.round(lat * 1e7) / 1e7).toFixed(7);
  const lngKey = (Math.round(lng * 1e7) / 1e7).toFixed(7);
  return `parcel-rep|${latKey}|${lngKey}`;
}

export function nearbyDeltaAction(input: {
  safe: boolean;
  coordVersion: string | null;
  storedVersion: string | null;
  storedStatus: string | null;
}): NearbyDeltaAction {
  if (!input.safe || !input.coordVersion) return "skip_no_coordinate";
  if (!input.storedVersion || input.storedStatus === "BUILDING") return "materialize";
  if (input.storedVersion !== input.coordVersion) return "rebuild";
  return "reuse";
}

export function nearbyReadState(input: {
  safe: boolean;
  storedVersion: string | null;
  currentVersion: string | null;
  linkCount: number | null;
}): NearbyReadState {
  if (!input.safe || !input.currentVersion) return "NO_COORDINATE";
  if (!input.storedVersion || input.storedVersion !== input.currentVersion) return "NOT_MATERIALIZED";
  if ((input.linkCount ?? 0) <= 0) return "NO_SCHOOLS_WITHIN_RADIUS";
  return "READY";
}

export type NearbySchoolPoint = {
  code: string;
  level: string;
  lat: number;
  lng: number;
  sourceAsOf: string;
};

export type NearbyLink = NearbySchoolPoint & {
  distanceM: number;
  rank: number;
};

/**
 * Same contract as the national backfill: 1500m inclusive, rounded meters,
 * rank within level, school_code tie-break. All hits are kept.
 */
export function linksWithinRadius(
  origin: { lat: number; lng: number },
  schools: readonly NearbySchoolPoint[],
  radiusM = NEARBY_RADIUS_M,
): NearbyLink[] {
  const hits: Array<NearbySchoolPoint & { distanceM: number }> = [];
  for (const school of schools) {
    const distanceM = Math.round(haversineMeters(origin.lat, origin.lng, school.lat, school.lng));
    if (distanceM <= radiusM) hits.push({ ...school, distanceM });
  }
  const byLevel = new Map<string, Array<NearbySchoolPoint & { distanceM: number }>>();
  for (const hit of hits) {
    const list = byLevel.get(hit.level) ?? [];
    list.push(hit);
    byLevel.set(hit.level, list);
  }
  const links: NearbyLink[] = [];
  for (const list of byLevel.values()) {
    list.sort((a, b) => a.distanceM - b.distanceM || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    list.forEach((hit, index) => links.push({ ...hit, rank: index + 1 }));
  }
  return links;
}

export function buildSchoolGrid(schools: readonly NearbySchoolPoint[], cell = 0.02): Map<string, NearbySchoolPoint[]> {
  const grid = new Map<string, NearbySchoolPoint[]>();
  for (const school of schools) {
    const key = `${Math.floor(school.lat / cell)}:${Math.floor(school.lng / cell)}`;
    const list = grid.get(key);
    if (list) list.push(school);
    else grid.set(key, [school]);
  }
  return grid;
}

export function schoolsNearCell(
  grid: Map<string, NearbySchoolPoint[]>,
  lat: number,
  lng: number,
  cell = 0.02,
): NearbySchoolPoint[] {
  const gx = Math.floor(lat / cell);
  const gy = Math.floor(lng / cell);
  const out: NearbySchoolPoint[] = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const bucket = grid.get(`${gx + dx}:${gy + dy}`);
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}

export const NEARBY_DISTANCE_BASIS = DISTANCE_BASIS;
export const NEARBY_LINK_CLASSIFICATION = NEARBY_CLASSIFICATION;
