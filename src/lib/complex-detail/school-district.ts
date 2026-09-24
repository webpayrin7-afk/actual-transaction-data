/**
 * School district product types + client-safe helpers (no fs).
 * Official membership ≠ 배정 확정.
 */

import { haversineMeters, type LatLng } from "@/lib/nearby-map/geo";

export const SCHOOL_DISTRICT_DEFAULT_VISIBLE = 3;

export type SchoolDistrictLevel = "middle" | "high";
export type SchoolDistrictConfidence = "CONFIRMED" | "DERIVED" | "UNCONFIRMED";

export type ProductDistrictSchool = {
  name: string;
  establishment: string;
  schoolCode: string | null;
  /** NEIS road address — client geocode when not already in nearby places. */
  roadAddress: string | null;
  distanceM: number | null;
  detailLinkable: boolean;
  /** Also present in nearby-school (radius) results. */
  isNearby: boolean;
};

export type ProductSchoolDistrict = {
  id: string;
  level: SchoolDistrictLevel;
  officialName: string;
  description: string;
  infoText: string;
  schoolYear: string | null;
  confidence: SchoolDistrictConfidence;
  memberCount: number;
  members: ProductDistrictSchool[];
  attributionLabel: string | null;
};

export type ProductSchoolDistrictsPayload = {
  middle: ProductSchoolDistrict | null;
  high: ProductSchoolDistrict | null;
  middleStatus: "CONFIRMED" | "HOLD_UNCONFIRMED" | "NOT_APPLICABLE";
  highStatus: "CONFIRMED" | "HOLD_UNCONFIRMED" | "NOT_APPLICABLE";
};

export function sortDistrictMembersByDistance(
  members: ProductDistrictSchool[],
): ProductDistrictSchool[] {
  return [...members].sort((a, b) => {
    if (a.distanceM == null && b.distanceM == null) {
      return a.name.localeCompare(b.name, "ko");
    }
    if (a.distanceM == null) return 1;
    if (b.distanceM == null) return -1;
    if (a.distanceM !== b.distanceM) return a.distanceM - b.distanceM;
    return a.name.localeCompare(b.name, "ko");
  });
}

/**
 * Attach distances from known place coords (nearby pipeline).
 * Marks isNearby when the school also appears in nearby places.
 * Does not invent coords; missing members keep distanceM null.
 */
export function attachDistancesToDistrictMembers(
  district: ProductSchoolDistrict,
  center: LatLng,
  places: Array<{
    schoolCode: string | null;
    name: string;
    lat: number;
    lng: number;
  }>,
): ProductSchoolDistrict {
  const byCode = new Map<string, { lat: number; lng: number }>();
  const byName = new Map<string, { lat: number; lng: number }>();
  for (const p of places) {
    if (p.schoolCode?.trim()) {
      byCode.set(p.schoolCode.trim(), { lat: p.lat, lng: p.lng });
    }
    byName.set(p.name.replace(/\s+/g, ""), { lat: p.lat, lng: p.lng });
  }

  const members = district.members.map((m) => {
    const hit =
      (m.schoolCode && byCode.get(m.schoolCode)) ||
      byName.get(m.name.replace(/\s+/g, "")) ||
      null;
    if (!hit) return m;
    return {
      ...m,
      distanceM: Math.round(haversineMeters(center, hit)),
      isNearby: true,
    };
  });

  return {
    ...district,
    members: sortDistrictMembersByDistance(members),
  };
}

/** Merge a geocoded coord into one member (district-only; isNearby unchanged). */
export function applyDistrictMemberCoordinate(
  member: ProductDistrictSchool,
  center: LatLng,
  coord: LatLng,
): ProductDistrictSchool {
  return {
    ...member,
    distanceM: Math.round(haversineMeters(center, coord)),
  };
}

export function formatDistrictDistance(m: number | null): string | null {
  if (m == null || !Number.isFinite(m)) return null;
  if (m < 1000) return `${m}m`;
  return `${(m / 1000).toFixed(1).replace(/\.0$/, "")}km`;
}
