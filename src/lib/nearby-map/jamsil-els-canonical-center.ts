/**
 * Single source of truth for 잠실엘스 map / commerce center (Stage C4).
 *
 * Captured from the product runtime path:
 *   resolveComplexMapAnchor → NAVER_GEOCODE
 * on Preview (주변생활), fiber mapAnchor.coordinate.
 *
 * Commerce aggregation, map-point origin, fitAnchor, complex marker,
 * and 1km reference circle must all use this center — not the legacy
 * pilot seed 37.5133 / 127.1028.
 *
 * Do not invent a second commerce-only center.
 */

export const JAMSIL_ELS_LEGACY_PILOT_CENTER = {
  lat: 37.5133,
  lng: 127.1028,
  coordinateSource: "c1_verified_pilot_center",
  note: "LEGACY_PILOT_CENTER_RESULT — superseded by C4 product mapAnchor",
} as const;

/** Product-resolved apartment center (NAVER_GEOCODE mapAnchor snapshot). */
export const JAMSIL_ELS_CANONICAL_CENTER = {
  complexId: "cx_4c63d9a100973c60",
  complexName: "잠실엘스",
  lat: 37.5133051,
  lng: 127.0815962,
  coordinateSource: "product_map_anchor_naver_geocode",
  anchorType: "NAVER_GEOCODE" as const,
  addressUsed: "서울특별시 송파구 올림픽로 99",
  /** Straight-line offset from legacy pilot seed, meters */
  /** Haversine vs legacy pilot seed (stage-c4 report). */
  legacyPilotOffsetM: 1870.2,
} as const;
