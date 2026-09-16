/**
 * Commerce census snapshot contract (SEMAS-derived).
 * U1: 잠실엘스 pilot fixture from Stage C3 — no runtime SEMAS CSV / DB.
 */

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

/** Compact density cell — no business identity / individual coords. */
export type CommerceDensityCell = {
  lat: number;
  lng: number;
  count: number;
};

export type CommerceDensity = {
  gridSizeM: number;
  /** p95 of cell counts — used for intensity scaling */
  p95Count: number;
  maxCellCount: number;
  cellCount: number;
  sumCellCount: number;
  cells: CommerceDensityCell[];
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
  /** Optional SEMAS P2 density overlay (U2+). */
  density?: CommerceDensity | null;
  sourceDate: string;
  computedAt: string;
  coordinateSource: string;
};

/**
 * Density circle visual scaling (deterministic; not location-tuned).
 * normalized = min(count / p95, 1)
 * strength = sqrt(normalized)
 * radiusM = 50 + strength * 70   → ~50–120m
 * fillOpacity = 0.10 + strength * 0.28
 */
export function commerceDensityCircleStyle(
  count: number,
  p95Count: number,
): { radiusM: number; fillOpacity: number; strokeOpacity: number } {
  const p95 = Math.max(1, p95Count);
  const normalized = Math.min(count / p95, 1);
  const strength = Math.sqrt(normalized);
  return {
    radiusM: 50 + strength * 70,
    fillOpacity: 0.1 + strength * 0.28,
    strokeOpacity: 0.08 + strength * 0.18,
  };
}

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

/**
 * Stage C3 golden fixture + U2 density — 잠실엘스 ONLY.
 * Census numbers from stage-c3-derived-snapshot-pilot.json (exact match PASS).
 * Density cells from stage-u2-jamsil-els-density.json (sum=4381 PASS).
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
  density: {
    gridSizeM: 150,
    p95Count: 122,
    maxCellCount: 307,
    cellCount: 106,
    sumCellCount: 4381,
    cells: [
      {
        lat: 37.511279,
        lng: 127.098553,
        count: 307
      },
      {
        lat: 37.513974,
        lng: 127.103649,
        count: 260
      },
      {
        lat: 37.516669,
        lng: 127.098553,
        count: 227
      },
      {
        lat: 37.513974,
        lng: 127.108746,
        count: 212
      },
      {
        lat: 37.511279,
        lng: 127.100252,
        count: 169
      },
      {
        lat: 37.520711,
        lng: 127.105348,
        count: 122
      },
      {
        lat: 37.515321,
        lng: 127.108746,
        count: 119
      },
      {
        lat: 37.515321,
        lng: 127.110444,
        count: 113
      },
      {
        lat: 37.516669,
        lng: 127.112143,
        count: 97
      },
      {
        lat: 37.512626,
        lng: 127.108746,
        count: 96
      },
      {
        lat: 37.512626,
        lng: 127.093457,
        count: 91
      },
      {
        lat: 37.518016,
        lng: 127.103649,
        count: 90
      },
      {
        lat: 37.513974,
        lng: 127.101951,
        count: 81
      },
      {
        lat: 37.509931,
        lng: 127.108746,
        count: 77
      },
      {
        lat: 37.509931,
        lng: 127.110444,
        count: 72
      },
      {
        lat: 37.512626,
        lng: 127.112143,
        count: 70
      },
      {
        lat: 37.505889,
        lng: 127.098553,
        count: 67
      },
      {
        lat: 37.505889,
        lng: 127.107047,
        count: 67
      },
      {
        lat: 37.512626,
        lng: 127.110444,
        count: 65
      },
      {
        lat: 37.513974,
        lng: 127.100252,
        count: 65
      },
      {
        lat: 37.513974,
        lng: 127.110444,
        count: 65
      },
      {
        lat: 37.508584,
        lng: 127.105348,
        count: 64
      },
      {
        lat: 37.513974,
        lng: 127.107047,
        count: 64
      },
      {
        lat: 37.507236,
        lng: 127.107047,
        count: 63
      },
      {
        lat: 37.507236,
        lng: 127.108746,
        count: 62
      },
      {
        lat: 37.505889,
        lng: 127.096854,
        count: 59
      },
      {
        lat: 37.507236,
        lng: 127.105348,
        count: 59
      },
      {
        lat: 37.511279,
        lng: 127.108746,
        count: 59
      },
      {
        lat: 37.505889,
        lng: 127.105348,
        count: 58
      },
      {
        lat: 37.516669,
        lng: 127.103649,
        count: 55
      },
      {
        lat: 37.508584,
        lng: 127.110444,
        count: 53
      },
      {
        lat: 37.518016,
        lng: 127.101951,
        count: 50
      },
      {
        lat: 37.507236,
        lng: 127.103649,
        count: 49
      },
      {
        lat: 37.515321,
        lng: 127.113842,
        count: 49
      },
      {
        lat: 37.511279,
        lng: 127.093457,
        count: 46
      },
      {
        lat: 37.515321,
        lng: 127.107047,
        count: 46
      },
      {
        lat: 37.511279,
        lng: 127.112143,
        count: 45
      },
      {
        lat: 37.509931,
        lng: 127.112143,
        count: 44
      },
      {
        lat: 37.515321,
        lng: 127.100252,
        count: 44
      },
      {
        lat: 37.508584,
        lng: 127.107047,
        count: 42
      },
      {
        lat: 37.505889,
        lng: 127.108746,
        count: 39
      },
      {
        lat: 37.505889,
        lng: 127.103649,
        count: 38
      },
      {
        lat: 37.515321,
        lng: 127.103649,
        count: 36
      },
      {
        lat: 37.515321,
        lng: 127.112143,
        count: 35
      },
      {
        lat: 37.507236,
        lng: 127.100252,
        count: 32
      },
      {
        lat: 37.508584,
        lng: 127.112143,
        count: 32
      },
      {
        lat: 37.512626,
        lng: 127.113842,
        count: 32
      },
      {
        lat: 37.516669,
        lng: 127.101951,
        count: 30
      },
      {
        lat: 37.516669,
        lng: 127.110444,
        count: 30
      },
      {
        lat: 37.511279,
        lng: 127.113842,
        count: 29
      },
      {
        lat: 37.504541,
        lng: 127.105348,
        count: 28
      },
      {
        lat: 37.505889,
        lng: 127.100252,
        count: 28
      },
      {
        lat: 37.515321,
        lng: 127.101951,
        count: 28
      },
      {
        lat: 37.516669,
        lng: 127.113842,
        count: 28
      },
      {
        lat: 37.511279,
        lng: 127.107047,
        count: 27
      },
      {
        lat: 37.516669,
        lng: 127.107047,
        count: 27
      },
      {
        lat: 37.509931,
        lng: 127.105348,
        count: 25
      },
      {
        lat: 37.511279,
        lng: 127.110444,
        count: 21
      },
      {
        lat: 37.519364,
        lng: 127.108746,
        count: 21
      },
      {
        lat: 37.505889,
        lng: 127.101951,
        count: 20
      },
      {
        lat: 37.509931,
        lng: 127.107047,
        count: 20
      },
      {
        lat: 37.507236,
        lng: 127.101951,
        count: 19
      },
      {
        lat: 37.518016,
        lng: 127.100252,
        count: 18
      },
      {
        lat: 37.519364,
        lng: 127.098553,
        count: 15
      },
      {
        lat: 37.504541,
        lng: 127.098553,
        count: 14
      },
      {
        lat: 37.504541,
        lng: 127.101951,
        count: 14
      },
      {
        lat: 37.508584,
        lng: 127.103649,
        count: 14
      },
      {
        lat: 37.507236,
        lng: 127.110444,
        count: 13
      },
      {
        lat: 37.515321,
        lng: 127.098553,
        count: 13
      },
      {
        lat: 37.520711,
        lng: 127.103649,
        count: 10
      },
      {
        lat: 37.509931,
        lng: 127.113842,
        count: 9
      },
      {
        lat: 37.516669,
        lng: 127.105348,
        count: 7
      },
      {
        lat: 37.511279,
        lng: 127.095156,
        count: 6
      },
      {
        lat: 37.515321,
        lng: 127.105348,
        count: 6
      },
      {
        lat: 37.516669,
        lng: 127.108746,
        count: 6
      },
      {
        lat: 37.505889,
        lng: 127.095156,
        count: 5
      },
      {
        lat: 37.513974,
        lng: 127.112143,
        count: 5
      },
      {
        lat: 37.518016,
        lng: 127.105348,
        count: 5
      },
      {
        lat: 37.508584,
        lng: 127.108746,
        count: 4
      },
      {
        lat: 37.513974,
        lng: 127.105348,
        count: 4
      },
      {
        lat: 37.516669,
        lng: 127.093457,
        count: 4
      },
      {
        lat: 37.516669,
        lng: 127.100252,
        count: 4
      },
      {
        lat: 37.518016,
        lng: 127.098553,
        count: 4
      },
      {
        lat: 37.519364,
        lng: 127.101951,
        count: 3
      },
      {
        lat: 37.504541,
        lng: 127.103649,
        count: 2
      },
      {
        lat: 37.504541,
        lng: 127.107047,
        count: 2
      },
      {
        lat: 37.511279,
        lng: 127.101951,
        count: 2
      },
      {
        lat: 37.518016,
        lng: 127.107047,
        count: 2
      },
      {
        lat: 37.518016,
        lng: 127.112143,
        count: 2
      },
      {
        lat: 37.519364,
        lng: 127.100252,
        count: 2
      },
      {
        lat: 37.519364,
        lng: 127.103649,
        count: 2
      },
      {
        lat: 37.520711,
        lng: 127.100252,
        count: 2
      },
      {
        lat: 37.507236,
        lng: 127.095156,
        count: 1
      },
      {
        lat: 37.507236,
        lng: 127.098553,
        count: 1
      },
      {
        lat: 37.507236,
        lng: 127.112143,
        count: 1
      },
      {
        lat: 37.509931,
        lng: 127.100252,
        count: 1
      },
      {
        lat: 37.511279,
        lng: 127.091758,
        count: 1
      },
      {
        lat: 37.511279,
        lng: 127.103649,
        count: 1
      },
      {
        lat: 37.512626,
        lng: 127.098553,
        count: 1
      },
      {
        lat: 37.512626,
        lng: 127.100252,
        count: 1
      },
      {
        lat: 37.513974,
        lng: 127.095156,
        count: 1
      },
      {
        lat: 37.513974,
        lng: 127.098553,
        count: 1
      },
      {
        lat: 37.519364,
        lng: 127.095156,
        count: 1
      },
      {
        lat: 37.519364,
        lng: 127.096854,
        count: 1
      },
      {
        lat: 37.520711,
        lng: 127.101951,
        count: 1
      },
      {
        lat: 37.522059,
        lng: 127.105348,
        count: 1
      }
    ]
  },
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
 * U1: 잠실엘스 fixture only — never clone to other complexes.
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
