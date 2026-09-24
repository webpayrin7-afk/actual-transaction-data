/**
 * Elementary attendance-zone product types (not schoolDistrict).
 * Official 통학구역 ≠ nearby-school proximity.
 */

import { haversineMeters, type LatLng } from "@/lib/nearby-map/geo";

export type AttendanceZoneConfidence = "CONFIRMED" | "DERIVED" | "UNCONFIRMED";
export type AttendanceZoneKind = "single" | "joint";

export type ProductAttendanceSchool = {
  name: string;
  establishment: string;
  schoolCode: string | null;
  roadAddress: string | null;
  distanceM: number | null;
  detailLinkable: boolean;
  isNearby: boolean;
};

export type ProductAttendanceZone = {
  id: string;
  type: "attendance_zone";
  officialName: string;
  zoneKind: AttendanceZoneKind;
  description: string;
  infoText: string;
  ctaLabel: string;
  schoolYear: string | null;
  baseDate: string | null;
  confidence: AttendanceZoneConfidence;
  designatedSchools: ProductAttendanceSchool[];
  attributionLabel: string | null;
};

export type ProductAttendanceZonePayload = {
  elementary: ProductAttendanceZone | null;
  elementaryStatus: "CONFIRMED" | "HOLD_UNCONFIRMED" | "NOT_APPLICABLE";
};

export function attachDistancesToAttendanceSchools(
  zone: ProductAttendanceZone,
  center: LatLng,
  places: Array<{
    schoolCode: string | null;
    name: string;
    lat: number;
    lng: number;
  }>,
): ProductAttendanceZone {
  const byCode = new Map<string, { lat: number; lng: number }>();
  const byName = new Map<string, { lat: number; lng: number }>();
  for (const p of places) {
    if (p.schoolCode?.trim()) {
      byCode.set(p.schoolCode.trim(), { lat: p.lat, lng: p.lng });
    }
    byName.set(p.name.replace(/\s+/g, ""), { lat: p.lat, lng: p.lng });
  }

  const designatedSchools = zone.designatedSchools.map((m) => {
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

  return { ...zone, designatedSchools };
}
