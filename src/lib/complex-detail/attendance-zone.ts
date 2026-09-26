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
  /** 단지 기본 걷기 경로에 이 학교가 있을 때만 (분) */
  walkMin?: number | null;
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
  /** 공동통학구역(여러 학교 중 선택) — 통학구역과 함께 들거나 공동통학구역에만 들 때 */
  jointSchools?: ProductAttendanceSchool[];
  /** 학교가 이어지지 않은 공동통학구역 이름 (원문) */
  jointZoneName?: string | null;
  /** 짧은 안내 — 기준일·교육지원청 확인 */
  note?: string | null;
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

  const attach = (m: ProductAttendanceSchool): ProductAttendanceSchool => {
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
  };

  return {
    ...zone,
    designatedSchools: zone.designatedSchools.map(attach),
    jointSchools: zone.jointSchools?.map(attach),
  };
}
