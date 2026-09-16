/**
 * Living tab v1 — NAVER Local Search POIs near a complex.
 * Not a facility census / commerce aggregation.
 *
 * Pipeline: query A+B → merge → dedupe → semantic validate →
 * category radius → nearest sort → display cap.
 */

import { haversineMeters, type LatLng } from "@/lib/nearby-map/geo";
import {
  cleanNaverLocalTitle,
  fetchNaverLocalSearch,
  isNaverLocalSearchConfigured,
  parseNaverLocalCoords,
  type NaverLocalSearchItem,
  NAVER_LOCAL_CACHE_VERSION,
} from "@/lib/complex-detail/naver-local-search";

export type LivingCategory =
  | "MART"
  | "HOSPITAL"
  | "PHARMACY"
  | "CONVENIENCE"
  | "PARK";

export type LivingPlace = {
  id: string;
  name: string;
  category: LivingCategory;
  sourceCategory: string | null;
  address: string | null;
  roadAddress: string | null;
  lat: number;
  lng: number;
  distanceM: number;
  source: "NAVER_LOCAL";
};

export const LIVING_CATEGORY_ORDER: LivingCategory[] = [
  "MART",
  "HOSPITAL",
  "PHARMACY",
  "CONVENIENCE",
  "PARK",
];

export const LIVING_CATEGORY_LABEL: Record<LivingCategory, string> = {
  MART: "마트",
  HOSPITAL: "병원",
  PHARMACY: "약국",
  CONVENIENCE: "편의점",
  PARK: "공원",
};

/** Per-category radius + display cap (post-filter). */
export const LIVING_CATEGORY_CONFIG: Record<
  LivingCategory,
  { radiusM: number; limit: number }
> = {
  HOSPITAL: { radiusM: 1500, limit: 5 },
  PHARMACY: { radiusM: 2000, limit: 5 },
  MART: { radiusM: 1500, limit: 5 },
  CONVENIENCE: { radiusM: 1500, limit: 5 },
  PARK: { radiusM: 1500, limit: 5 },
};

/** @deprecated Prefer LIVING_CATEGORY_CONFIG[cat].radiusM */
export const LIVING_DISPLAY_MAX_METERS = 1500;

/** @deprecated Prefer LIVING_CATEGORY_CONFIG[cat].limit */
export const LIVING_MAX_PER_CATEGORY = 5;

export type LivingCategoryResult = {
  category: LivingCategory;
  label: string;
  primaryQuery: string;
  fallbackQuery: string | null;
  /** True when secondary (dong) query was also called and merged. */
  usedFallback: boolean;
  apiCalls: number;
  rawCount: number;
  rawCountA?: number;
  rawCountB?: number;
  semanticRejected?: number;
  overRadiusRemoved: number;
  places: LivingPlace[];
  error?: string;
};

export type NearbyLivingResult = {
  status: "READY" | "HOLD" | "EMPTY" | "ERROR";
  reason: string | null;
  source: "NAVER_LOCAL";
  cacheVersion: string;
  apiCallCount: number;
  duplicatesRemoved: number;
  overRadiusRemoved: number;
  categories: LivingCategoryResult[];
  places: LivingPlace[];
};

function normalizeKey(p: {
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  roadAddress: string | null;
}): string {
  const name = p.name.replace(/\s+/g, "").toLowerCase();
  const lat = p.lat.toFixed(5);
  const lng = p.lng.toFixed(5);
  const addr = (p.roadAddress || p.address || "")
    .replace(/\s+/g, "")
    .toLowerCase();
  return `${name}|${lat}|${lng}|${addr}`;
}

/**
 * sourceCategory-first semantic gate.
 * Unknown / unsafe category → reject (quality > count).
 */
export function isSemanticallyValidLivingPlace(
  category: LivingCategory,
  sourceCategory: string | null | undefined,
): boolean {
  const cat = String(sourceCategory || "").trim();
  if (!cat) return false;

  switch (category) {
    case "HOSPITAL": {
      if (/동물병원|수의/.test(cat)) return false;
      // Observed: 병원,의원>피부과 / 소아청소년과 / 치과 …
      return /병원|의원|의료/.test(cat);
    }
    case "PHARMACY": {
      // Observed: 건강,의료>약국
      return /약국/.test(cat) && !/동물|수의/.test(cat);
    }
    case "MART": {
      // Explicit: convenience never belongs in MART.
      if (/편의점/.test(cat)) return false;
      // Observed: 쇼핑,유통>슈퍼,마트 / 유기농산물마트
      // Do not expand to 백화점/쇼핑몰 in this stage.
      if (/백화점|쇼핑몰|쇼핑센터|아울렛|복합쇼핑/.test(cat)) return false;
      return /슈퍼|마트|대형마트|슈퍼마켓|식료품/.test(cat);
    }
    case "CONVENIENCE": {
      // Observed: 생활,편의>편의점 — brand name alone is insufficient.
      return /편의점/.test(cat);
    }
    case "PARK": {
      // Explicit: commercial venues (카페 등) even if title mentions 공원.
      if (/카페|디저트|음식|식당|베이커리|빵|술집|편의점|마트|병원|약국|호텔|숙박/.test(cat)) {
        return false;
      }
      // Observed: 여행,명소>시민공원 — also 공원/도시공원/근린공원/어린이공원.
      return /공원|시민공원|도시공원|근린공원|어린이공원|수변공원/.test(cat);
    }
    default:
      return false;
  }
}

function itemToCandidate(
  item: NaverLocalSearchItem,
  category: LivingCategory,
  center: LatLng,
  index: number,
): LivingPlace | null {
  const coords = parseNaverLocalCoords(item.mapx, item.mapy);
  if (!coords) return null;
  const name = cleanNaverLocalTitle(item.title);
  if (!name) return null;
  const distanceM = Math.round(haversineMeters(center, coords));
  if (!Number.isFinite(distanceM) || distanceM < 0) return null;
  return {
    id: `living-${category}-${index}-${name}-${coords.lat.toFixed(5)}-${coords.lng.toFixed(5)}`,
    name,
    category,
    sourceCategory: item.category?.trim() || null,
    address: item.address?.trim() || null,
    roadAddress: item.roadAddress?.trim() || null,
    lat: coords.lat,
    lng: coords.lng,
    distanceM,
    source: "NAVER_LOCAL",
  };
}

async function searchCategory(params: {
  category: LivingCategory;
  aptName: string;
  center: LatLng;
  sigungu: string | null;
  legalDong: string | null;
}): Promise<LivingCategoryResult> {
  const label = LIVING_CATEGORY_LABEL[params.category];
  const { radiusM, limit } = LIVING_CATEGORY_CONFIG[params.category];
  const primaryQuery = `${params.aptName} ${label}`.trim();
  const secondaryQuery =
    params.sigungu && params.legalDong
      ? `${params.sigungu} ${params.legalDong} ${label}`.trim()
      : null;

  let apiCalls = 0;
  let error: string | undefined;
  let itemsA: NaverLocalSearchItem[] = [];
  let itemsB: NaverLocalSearchItem[] = [];

  const primary = await fetchNaverLocalSearch({
    query: primaryQuery,
    display: 5,
  });
  apiCalls += 1;
  if (!primary.ok) {
    error = primary.error;
  } else {
    itemsA = primary.items;
  }

  // Always merge A+B when secondary identity is available (coverage fix).
  let usedSecondary = false;
  if (secondaryQuery) {
    const secondary = await fetchNaverLocalSearch({
      query: secondaryQuery,
      display: 5,
    });
    apiCalls += 1;
    usedSecondary = true;
    if (!secondary.ok && !error) error = secondary.error;
    if (secondary.ok) itemsB = secondary.items;
  }

  const mergedItems: Array<{ item: NaverLocalSearchItem; index: number }> = [
    ...itemsA.map((item, i) => ({ item, index: i })),
    ...itemsB.map((item, i) => ({ item, index: 100 + i })),
  ];

  const candidates = mergedItems
    .map(({ item, index }) =>
      itemToCandidate(item, params.category, params.center, index),
    )
    .filter((x): x is LivingPlace => !!x);

  // Per-category dedupe before semantic/radius (A∪B).
  const seenLocal = new Set<string>();
  const deduped: LivingPlace[] = [];
  for (const p of candidates) {
    const key = normalizeKey(p);
    if (seenLocal.has(key)) continue;
    seenLocal.add(key);
    deduped.push(p);
  }

  let semanticRejected = 0;
  const semanticOk: LivingPlace[] = [];
  for (const p of deduped) {
    if (isSemanticallyValidLivingPlace(params.category, p.sourceCategory)) {
      semanticOk.push(p);
    } else {
      semanticRejected += 1;
    }
  }

  let overRadiusRemoved = 0;
  const withinRadius: LivingPlace[] = [];
  for (const p of semanticOk) {
    if (p.distanceM <= radiusM) withinRadius.push(p);
    else overRadiusRemoved += 1;
  }

  withinRadius.sort((a, b) => a.distanceM - b.distanceM);
  const places = withinRadius.slice(0, limit);

  return {
    category: params.category,
    label,
    primaryQuery,
    fallbackQuery: secondaryQuery,
    usedFallback: usedSecondary,
    apiCalls,
    rawCount: itemsA.length + itemsB.length,
    rawCountA: itemsA.length,
    rawCountB: itemsB.length,
    semanticRejected,
    overRadiusRemoved,
    places,
    error,
  };
}

/**
 * Fetch living places for a complex (lazy living-tab path).
 * Max 10 Local Search calls (5 categories × A+B).
 */
export async function fetchNearbyLivingPlaces(params: {
  aptName: string;
  center: LatLng;
  sigungu?: string | null;
  legalDong?: string | null;
}): Promise<NearbyLivingResult> {
  if (!isNaverLocalSearchConfigured()) {
    return {
      status: "HOLD",
      reason:
        "NAVER Local Search 인증이 없어 주변 생활시설을 불러올 수 없습니다.",
      source: "NAVER_LOCAL",
      cacheVersion: NAVER_LOCAL_CACHE_VERSION,
      apiCallCount: 0,
      duplicatesRemoved: 0,
      overRadiusRemoved: 0,
      categories: [],
      places: [],
    };
  }

  const aptName = params.aptName.trim();
  if (
    !aptName ||
    !Number.isFinite(params.center.lat) ||
    !Number.isFinite(params.center.lng)
  ) {
    return {
      status: "ERROR",
      reason: "주변 정보를 불러오지 못했어요",
      source: "NAVER_LOCAL",
      cacheVersion: NAVER_LOCAL_CACHE_VERSION,
      apiCallCount: 0,
      duplicatesRemoved: 0,
      overRadiusRemoved: 0,
      categories: [],
      places: [],
    };
  }

  const categories: LivingCategoryResult[] = [];
  let apiCallCount = 0;
  let overRadiusRemoved = 0;

  for (const category of LIVING_CATEGORY_ORDER) {
    try {
      const result = await searchCategory({
        category,
        aptName,
        center: params.center,
        sigungu: params.sigungu?.trim() || null,
        legalDong: params.legalDong?.trim() || null,
      });
      categories.push(result);
      apiCallCount += result.apiCalls;
      overRadiusRemoved += result.overRadiusRemoved;
    } catch (e) {
      categories.push({
        category,
        label: LIVING_CATEGORY_LABEL[category],
        primaryQuery: `${aptName} ${LIVING_CATEGORY_LABEL[category]}`,
        fallbackQuery: null,
        usedFallback: false,
        apiCalls: 0,
        rawCount: 0,
        overRadiusRemoved: 0,
        places: [],
        error: e instanceof Error ? e.message : "category failed",
      });
    }
  }

  // Cross-category dedupe (same POI must not appear under two chips).
  const seen = new Set<string>();
  let duplicatesRemoved = 0;
  const places: LivingPlace[] = [];
  for (const cat of categories) {
    const kept: LivingPlace[] = [];
    for (const p of cat.places) {
      const key = normalizeKey(p);
      if (seen.has(key)) {
        duplicatesRemoved += 1;
        continue;
      }
      seen.add(key);
      kept.push(p);
      places.push(p);
    }
    cat.places = kept;
  }

  const anySuccess = categories.some((c) => c.places.length > 0);
  const allHardFail =
    categories.every((c) => c.error && c.places.length === 0) &&
    apiCallCount > 0 &&
    !anySuccess;

  if (anySuccess) {
    return {
      status: "READY",
      reason: null,
      source: "NAVER_LOCAL",
      cacheVersion: NAVER_LOCAL_CACHE_VERSION,
      apiCallCount,
      duplicatesRemoved,
      overRadiusRemoved,
      categories,
      places,
    };
  }

  if (allHardFail) {
    return {
      status: "ERROR",
      reason: "주변 정보를 불러오지 못했어요",
      source: "NAVER_LOCAL",
      cacheVersion: NAVER_LOCAL_CACHE_VERSION,
      apiCallCount,
      duplicatesRemoved,
      overRadiusRemoved,
      categories,
      places: [],
    };
  }

  return {
    status: "EMPTY",
    reason: "주변 정보를 찾지 못했어요",
    source: "NAVER_LOCAL",
    cacheVersion: NAVER_LOCAL_CACHE_VERSION,
    apiCallCount,
    duplicatesRemoved,
    overRadiusRemoved,
    categories,
    places: [],
  };
}
