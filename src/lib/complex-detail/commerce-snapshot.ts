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
 * Compact actual SEMAS P2 point cloud (U3/U4).
 * meter-offset-int-v1: flattened [dxM, dyM, ...] from apartment origin.
 * U4: parallel categoryIdx[i] ∈ 0..5 → presentation bucket (see commerce-category-colors).
 * No business identity.
 */
export type CommerceMapPoints = {
  originLat: number;
  originLng: number;
  encoding: "meter-offset-int-v1";
  pointCount: number;
  offsetsM: number[];
  /** Parallel to points; presentation-bucket-idx-v1 (0..5). Optional for legacy. */
  categoryIdx?: number[];
  categoryEncoding?: "presentation-bucket-idx-v1";
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
  { key: "병원/의원", label: "의료기관" },
  { key: "약국", label: "약국" },
  { key: "편의점", label: "편의점" },
  { key: "마트/슈퍼", label: "마트·슈퍼" },
  { key: "카페", label: "카페" },
  { key: "음식점", label: "식음업소" },
  { key: "미용", label: "미용" },
  { key: "학원", label: "학원" },
  { key: "체육", label: "체육" },
];

/**
 * Deterministic UI aliases for awkward SEMAS subcategory names.
 * Only when meaning is clear from C1B / facility cross-check.
 * I212 “비알코올” → friendlier cafe label when present in TOP5.
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
  categoryIdx: Array.isArray(
    (jamsilElsMapPointsJson as { categoryIdx?: number[] }).categoryIdx,
  )
    ? ((jamsilElsMapPointsJson as { categoryIdx: number[] }).categoryIdx)
    : undefined,
  categoryEncoding: "presentation-bucket-idx-v1",
};

/**
 * Stage C4 center-corrected census + actual map points — 잠실엘스 ONLY.
 * Canonical center = product mapAnchor NAVER_GEOCODE (not legacy 37.5133/127.1028).
 * Metrics/points from stage-c4-jamsil-els-*-correction / map-points artifacts.
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
  p0Total: 3562,
  p2Total: 2745,
  composition: {
    "음식/외식": { count: 937, share: 34.13 },
    "쇼핑/소매": { count: 660, share: 24.04 },
    생활서비스: { count: 397, share: 14.46 },
    "의료/건강": { count: 211, share: 7.69 },
    교육: { count: 318, share: 11.58 },
    "여가/체육": { count: 222, share: 8.09 },
    기타: { count: 0, share: 0 },
  },
  topCategories: [
    { code: "I201", name: "한식", count: 325 },
    { code: "S207", name: "이용·미용", count: 299 },
    { code: "I210", name: "기타 간이", count: 231 },
    { code: "P106", name: "기타 교육", count: 210 },
    { code: "Q102", name: "의원", count: 200 },
  ],
  facilities: {
    "병원/의원": 205,
    약국: 51,
    편의점: 54,
    "마트/슈퍼": 35,
    카페: 116,
    음식점: 821,
    미용: 299,
    학원: 282,
    체육: 94,
  },
  mapPoints: jamsilElsMapPoints,
  sourceDate: "2026-06-30",
  computedAt: "2026-09-16T12:50:04.817Z",
  coordinateSource: "product_map_anchor_naver_geocode",
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
