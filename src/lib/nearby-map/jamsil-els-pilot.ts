/**
 * Phase 8.1 pilot identity — 잠실엘스 only.
 * Coordinate must come from official GIS / master / verified geocode — never invent.
 */

export const JAMSIL_ELS_MAP_PILOT = {
  /** Warehouse identity from apt_complex_master */
  complexId: "cx_4c63d9a100973c60",
  /** Product / pilot key */
  complexKey: "jamsil-els",
  displayName: "잠실엘스",
  /** K-apt code from Phase 71c fee probe (not a NAVER place id) */
  kaptCode: "A13822004",
  roadAddress: "서울특별시 송파구 올림픽로 99",
  jibunAddress: "서울특별시 송파구 잠실동 19",
  ofcdcCode: "B10",
  nearbyDongs: ["잠실동", "신천동"] as const,
  nearbyGu: "송파구",
  neisNameSeeds: ["잠일", "잠실", "신천", "서울잠실"] as const,
  radiusM: {
    school: 2500,
    transit: 1500,
    living: 1200,
    medical: 2000,
  },
} as const;

/**
 * Nearby ≠ assigned. Pilot now has confirmed high/middle districts + elem zone
 * for 잠실엘스 only; still never treat nearest school as assignment by itself.
 */
export const SCHOOL_CATCHMENT_AUDIT = {
  nearbySchoolClass: "NEARBY_SCHOOL" as const,
  assignedSchoolClass: "ASSIGNED_SCHOOL" as const,
  districtUnverifiedClass: "SCHOOL_DISTRICT_UNVERIFIED" as const,
  assignedSchoolVerified: false,
  schoolDistrictVerified: true,
  note: "인근 학교는 거리·위치 기준 NEARBY_SCHOOL입니다. 잠실엘스 pilot은 공식 통학구역·학교군 메타데이터를 별도 제공합니다.",
};
