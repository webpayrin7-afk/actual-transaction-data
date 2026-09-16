/**
 * Commerce census snapshot contract (SEMAS-derived).
 * U1 census + U3 actual map points — 잠실엘스 pilot fixture.
 * No runtime SEMAS CSV / DB.
 */

import jamsilElsMapPointsJson from "@/lib/complex-detail/jamsil-els-commerce-map-points.json";

export type CommerceCompositionKey =
  | "음식/외식"
  | "쇼핑/소매"
  | "생활서비스"
  | "교육"
  | "여가/체육"
  | "의료/건강"
  | "기타";

export type CommerceCompositionBucket = {
  count: number;
  /** Share of P2 total, e.g. 42.14 */
  share: number;
};

export type CommerceTopCategory = {
  code: string;
  /** SEMAS source-native name */
  name: string;
  count: number;
};

export type CommerceFacilities = {
  "병원/의원": number;
  약국: number;
  편의점: number;
  "마트/슈퍼": number;
  카페: number;
  음식점: number;
  미용: number;
  학원: number;
  체육: number;
};

/**
 * Compact actual SEMAS P2 point cloud (U3).
 * meter-offset-int-v1: flattened [dxM, dyM, ...] from apartment origin.
 * No business identity.
 */
export type CommerceMapPoints = {
  originLat: number;
  originLng: number;
  encoding: "meter-offset-int-v1";
  pointCount: number;
  offsetsM: number[];
};

/**
 * Typed snapshot shape shared by pilot fixture and future API rows.
 * Size labels intentionally omitted (NOT READY).
 */
export type CommerceSnapshot = {
  complexId: string;
  complexName: string;
  source: "semas";
  sourcePeriod: string;
  /** Display period, e.g. "2026년 2분기" */
  sourcePeriodLabel: string;
  radiusM: number;
  distanceMetric: "straight-line";
  populationVersion: "daily_commerce_core_v1";
  populationRuleVersion: string;
  /** Source-native all — metadata only, never headline */
  p0Total: number;
  /** Daily commerce core — primary headline */
  p2Total: number;
  composition: Record<CommerceCompositionKey, CommerceCompositionBucket>;
  topCategories: CommerceTopCategory[];
  facilities: CommerceFacilities;
  /** Optional SEMAS P2 actual point cloud (U3+). */
  mapPoints?: CommerceMapPoints | null;
  sourceDate: string;
  computedAt: string;
  coordinateSource: string;
};

/** Display order for composition rows (exclude zero “기타”). */
export const COMMERCE_COMPOSITION_ORDER: CommerceCompositionKey[] = [
  "음식/외식",
  "쇼핑/소매",
  "생활서비스",
  "교육",
  "여가/체육",
  "의료/건강",
];

/** Facility grid order + UI labels (· separators). */
export const COMMERCE_FACILITY_ORDER: Array<{
  key: keyof CommerceFacilities;
  label: string;
}> = [
  { key: "병원/의원", label: "병원·의원" },
  { key: "약국", label: "약국" },
  { key: "편의점", label: "편의점" },
  { key: "마트/슈퍼", label: "마트·슈퍼" },
  { key: "카페", label: "카페" },
  { key: "음식점", label: "음식점" },
  { key: "미용", label: "미용" },
  { key: "학원", label: "학원" },
  { key: "체육", label: "체육" },
];

/**
 * Deterministic UI aliases for awkward SEMAS subcategory names.
 * Only when meaning is clear from C1B / facility cross-check.
 * I212 count (260) == facilities.카페 (260).
 * I210 “기타 간이” kept source-native (uncertain friendlier rewrite).
 */
export const COMMERCE_TOP_CATEGORY_UI_ALIAS: Record<string, string> = {
  I212: "카페·비알코올 음료",
};

export function commerceTopCategoryDisplayName(
  cat: CommerceTopCategory,
): string {
  return COMMERCE_TOP_CATEGORY_UI_ALIAS[cat.code] ?? cat.name;
}

const jamsilElsMapPoints: CommerceMapPoints = {
  originLat: jamsilElsMapPointsJson.origin.lat,
  originLng: jamsilElsMapPointsJson.origin.lng,
  encoding: "meter-offset-int-v1",
  pointCount: jamsilElsMapPointsJson.pointCount,
  offsetsM: jamsilElsMapPointsJson.offsetsM as number[],
};

/**
 * Stage C3 census + U3 actual map points — 잠실엘스 ONLY.
 * Census from stage-c3-derived-snapshot-pilot.json.
 * Points from stage-u3 / jamsil-els-commerce-map-points.json (4381 PASS).
 */
export const jamsilElsCommerceSnapshot: CommerceSnapshot = {
  complexId: "cx_4c63d9a100973c60",
  complexName: "잠실엘스",
  source: "semas",
  sourcePeriod: "2026Q2",
  sourcePeriodLabel: "2026년 2분기",
  radiusM: 1000,
  distanceMetric: "straight-line",
  populationVersion: "daily_commerce_core_v1",
  populationRuleVersion: "c1b_frozen_p2_v1",
  p0Total: 5904,
  p2Total: 4381,
  composition: {
    "음식/외식": { count: 1846, share: 42.14 },
    "쇼핑/소매": { count: 1249, share: 28.51 },
    생활서비스: { count: 508, share: 11.6 },
    "의료/건강": { count: 211, share: 4.82 },
    교육: { count: 317, share: 7.24 },
    "여가/체육": { count: 250, share: 5.71 },
    기타: { count: 0, share: 0 },
  },
  topCategories: [
    { code: "I201", name: "한식", count: 597 },
    { code: "G209", name: "섬유·의복·신발 소매", count: 504 },
    { code: "I210", name: "기타 간이", count: 329 },
    { code: "S207", name: "이용·미용", count: 320 },
    { code: "I212", name: "비알코올", count: 260 },
  ],
  facilities: {
    "병원/의원": 204,
    약국: 88,
    편의점: 106,
    "마트/슈퍼": 46,
    카페: 260,
    음식점: 1586,
    미용: 320,
    학원: 271,
    체육: 116,
  },
  mapPoints: jamsilElsMapPoints,
  sourceDate: "2026-06-30",
  computedAt: "2026-09-16T08:55:38.060Z",
  coordinateSource: "c1_verified_pilot_center",
};

const PILOT_BY_COMPLEX_ID = new Map<string, CommerceSnapshot>([
  [jamsilElsCommerceSnapshot.complexId, jamsilElsCommerceSnapshot],
]);

const PILOT_BY_NAME_NORM = new Map<string, CommerceSnapshot>([
  ["잠실엘스", jamsilElsCommerceSnapshot],
  ["잠실엘스아파트", jamsilElsCommerceSnapshot],
]);

function normalizeAptName(name: string): string {
  return name.replace(/\s+/g, "").replace(/아파트$/u, "").trim();
}

/**
 * Resolve commerce census snapshot for a complex.
 * U1/U3: 잠실엘스 fixture only — never clone to other complexes.
 */
export function getCommerceSnapshot(params: {
  complexId?: string | null;
  aptName?: string | null;
}): CommerceSnapshot | null {
  const id = params.complexId?.trim();
  if (id && PILOT_BY_COMPLEX_ID.has(id)) {
    return PILOT_BY_COMPLEX_ID.get(id)!;
  }
  const name = params.aptName?.trim();
  if (name) {
    const direct = PILOT_BY_NAME_NORM.get(name);
    if (direct) return direct;
    const norm = normalizeAptName(name);
    const byNorm = PILOT_BY_NAME_NORM.get(norm);
    if (byNorm) return byNorm;
  }
  return null;
}

export function formatCommerceCount(n: number): string {
  return n.toLocaleString("ko-KR");
}

export function formatCommerceShare(share: number): string {
  // Spec UI shows one decimal (42.1%) from C3 share (42.14).
  return `${share.toFixed(1)}%`;
}
