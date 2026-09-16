/**
 * Shared commerce presentation-category colors (Stage U4).
 * One map for map POI, stacked bar, % bars, TOP5, facility accents.
 * Muted palette — fits lab navy (#1e3a5f) + teal; avoid neon/high-chroma.
 */

import type { CommerceCompositionKey } from "@/lib/complex-detail/commerce-snapshot";

export const COMMERCE_CATEGORY_COLOR_KEYS = [
  "음식/외식",
  "쇼핑/소매",
  "생활서비스",
  "교육",
  "여가/체육",
  "의료/건강",
] as const satisfies readonly CommerceCompositionKey[];

export type CommerceCategoryColorKey =
  (typeof COMMERCE_CATEGORY_COLOR_KEYS)[number];

export type CommerceCategoryColor = {
  /** Solid fill for bars / accents */
  fill: string;
  /** Canvas / map POI (pre-multiplied-ish muted alpha) */
  mapFill: string;
  /** Soft track / icon wash */
  soft: string;
  /** CSS class-friendly solid (hex) — same as fill */
  hex: string;
};

/**
 * Fixed tokens — do not restyle per-screen.
 * Index order matches COMMERCE_CATEGORY_COLOR_KEYS / map-point categoryIdx.
 */
export const COMMERCE_CATEGORY_COLORS: Record<
  CommerceCategoryColorKey,
  CommerceCategoryColor
> = {
  "음식/외식": {
    hex: "#C47A5A",
    fill: "#C47A5A",
    mapFill: "rgba(196, 122, 90, 0.42)",
    soft: "rgba(196, 122, 90, 0.16)",
  },
  "쇼핑/소매": {
    hex: "#2F7A73",
    fill: "#2F7A73",
    mapFill: "rgba(47, 122, 115, 0.42)",
    soft: "rgba(47, 122, 115, 0.16)",
  },
  생활서비스: {
    hex: "#6B7F9A",
    fill: "#6B7F9A",
    mapFill: "rgba(107, 127, 154, 0.42)",
    soft: "rgba(107, 127, 154, 0.16)",
  },
  교육: {
    hex: "#B8954A",
    fill: "#B8954A",
    mapFill: "rgba(184, 149, 74, 0.42)",
    soft: "rgba(184, 149, 74, 0.16)",
  },
  "여가/체육": {
    hex: "#6A8F6E",
    fill: "#6A8F6E",
    mapFill: "rgba(106, 143, 110, 0.42)",
    soft: "rgba(106, 143, 110, 0.16)",
  },
  "의료/건강": {
    hex: "#A66D7C",
    fill: "#A66D7C",
    mapFill: "rgba(166, 109, 124, 0.42)",
    soft: "rgba(166, 109, 124, 0.16)",
  },
};

/** Stable index for compact map-point encoding (0..5). */
export const COMMERCE_CATEGORY_INDEX: Record<CommerceCategoryColorKey, number> =
  {
    "음식/외식": 0,
    "쇼핑/소매": 1,
    생활서비스: 2,
    교육: 3,
    "여가/체육": 4,
    "의료/건강": 5,
  };

export const COMMERCE_CATEGORY_BY_INDEX: CommerceCategoryColorKey[] = [
  "음식/외식",
  "쇼핑/소매",
  "생활서비스",
  "교육",
  "여가/체육",
  "의료/건강",
];

export function commerceCategoryColor(
  key: CommerceCompositionKey | string | null | undefined,
): CommerceCategoryColor {
  if (key && key in COMMERCE_CATEGORY_COLORS) {
    return COMMERCE_CATEGORY_COLORS[key as CommerceCategoryColorKey];
  }
  return {
    hex: "#64748b",
    fill: "#64748b",
    mapFill: "rgba(100, 116, 139, 0.35)",
    soft: "rgba(100, 116, 139, 0.14)",
  };
}

export function commerceCategoryColorByIndex(
  idx: number,
): CommerceCategoryColor {
  const key = COMMERCE_CATEGORY_BY_INDEX[idx];
  return commerceCategoryColor(key);
}

/**
 * SEMAS large-class code → presentation bucket (frozen C1B mapping).
 * Mirrors scripts/lib/commerce-semas-snapshot-transform.mjs presentationBucket.
 */
export function commercePresentationBucketFromLcls(
  lcls: string,
): CommerceCompositionKey {
  switch (lcls) {
    case "I2":
      return "음식/외식";
    case "G2":
      return "쇼핑/소매";
    case "S2":
      return "생활서비스";
    case "Q1":
      return "의료/건강";
    case "P1":
      return "교육";
    case "R1":
      return "여가/체육";
    default:
      return "기타";
  }
}

/**
 * SEMAS mid-class code → presentation bucket for TOP5 bars.
 * Prefers known mid codes; falls back via first letter family when needed.
 */
export function commercePresentationBucketFromMcls(
  mcls: string,
): CommerceCompositionKey {
  const m = mcls.trim();
  if (m.startsWith("I2")) return "음식/외식";
  if (m.startsWith("G2")) return "쇼핑/소매";
  if (m.startsWith("S2")) return "생활서비스";
  if (m.startsWith("Q1")) return "의료/건강";
  if (m.startsWith("P1")) return "교육";
  if (m.startsWith("R1")) return "여가/체육";
  // P105/P106 education mid codes under P1
  if (m.startsWith("P")) return "교육";
  return "기타";
}

/** Facility card → presentation category for subtle icon accent. */
export const COMMERCE_FACILITY_CATEGORY: Record<
  string,
  CommerceCategoryColorKey
> = {
  "병원/의원": "의료/건강",
  약국: "쇼핑/소매", // SEMAS G21501 under G2 소매
  편의점: "쇼핑/소매",
  "마트/슈퍼": "쇼핑/소매",
  카페: "음식/외식",
  음식점: "음식/외식",
  미용: "생활서비스",
  학원: "교육",
  체육: "여가/체육",
};
