/**
 * Living tab v1 — NAVER Local Search POIs near a complex.
 * Not a facility census / commerce aggregation.
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

/** Display guard — not a census radius. */
export const LIVING_DISPLAY_MAX_METERS = 1500;

/** Max places shown per category in v1. */
export const LIVING_MAX_PER_CATEGORY = 2;

export type LivingCategoryResult = {
  category: LivingCategory;
  label: string;
  primaryQuery: string;
  fallbackQuery: string | null;
  usedFallback: boolean;
  apiCalls: number;
  rawCount: number;
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

function usableWithinDisplay(places: LivingPlace[]): {
  usable: LivingPlace[];
  overRadiusRemoved: number;
} {
  const usable: LivingPlace[] = [];
  let overRadiusRemoved = 0;
  for (const p of places) {
    if (p.distanceM <= LIVING_DISPLAY_MAX_METERS) usable.push(p);
    else overRadiusRemoved += 1;
  }
  return { usable, overRadiusRemoved };
}

async function searchCategory(params: {
  category: LivingCategory;
  aptName: string;
  center: LatLng;
  sigungu: string | null;
  legalDong: string | null;
}): Promise<LivingCategoryResult> {
  const label = LIVING_CATEGORY_LABEL[params.category];
  const primaryQuery = `${params.aptName} ${label}`.trim();
  const fallbackQuery =
    params.sigungu && params.legalDong
      ? `${params.sigungu} ${params.legalDong} ${label}`.trim()
      : null;

  let apiCalls = 0;
  let usedFallback = false;
  let raw: NaverLocalSearchItem[] = [];
  let error: string | undefined;

  const primary = await fetchNaverLocalSearch({
    query: primaryQuery,
    display: 5,
  });
  apiCalls += 1;
  if (!primary.ok) {
    error = primary.error;
  } else {
    raw = primary.items;
  }

  let candidates = raw
    .map((item, i) =>
      itemToCandidate(item, params.category, params.center, i),
    )
    .filter((x): x is LivingPlace => !!x);

  let { usable, overRadiusRemoved } = usableWithinDisplay(candidates);

  if (usable.length === 0 && fallbackQuery) {
    const fb = await fetchNaverLocalSearch({
      query: fallbackQuery,
      display: 5,
    });
    apiCalls += 1;
    usedFallback = true;
    if (!fb.ok && !error) error = fb.error;
    if (fb.ok) {
      raw = fb.items;
      candidates = fb.items
        .map((item, i) =>
          itemToCandidate(item, params.category, params.center, 100 + i),
        )
        .filter((x): x is LivingPlace => !!x);
      const second = usableWithinDisplay(candidates);
      usable = second.usable;
      overRadiusRemoved += second.overRadiusRemoved;
    }
  }

  usable.sort((a, b) => a.distanceM - b.distanceM);
  const places = usable.slice(0, LIVING_MAX_PER_CATEGORY);

  return {
    category: params.category,
    label,
    primaryQuery,
    fallbackQuery,
    usedFallback,
    apiCalls,
    rawCount: raw.length,
    overRadiusRemoved,
    places,
    error,
  };
}

/**
 * Fetch living places for a complex (lazy living-tab path).
 * Max 5 primary Local Search calls; fallback only when primary unusable.
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
      reason: "단지 위치 정보가 없어 생활시설을 조회할 수 없습니다.",
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
      reason: "현재 확인 가능한 주변 생활시설 정보가 없습니다.",
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
    reason: "현재 확인 가능한 주변 생활시설 정보가 없습니다.",
    source: "NAVER_LOCAL",
    cacheVersion: NAVER_LOCAL_CACHE_VERSION,
    apiCallCount,
    duplicatesRemoved,
    overRadiusRemoved,
    categories,
    places: [],
  };
}
