/**
 * Commerce tab v1 — NAVER Local Search POIs near a complex.
 * Mirrors nearby-living; not a commerce census / sales aggregation.
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

export type CommerceCategory =
  | "MART"
  | "CONVENIENCE"
  | "CAFE"
  | "RESTAURANT";

export type CommercePlace = {
  id: string;
  name: string;
  category: CommerceCategory;
  sourceCategory: string | null;
  address: string | null;
  roadAddress: string | null;
  /** Null when Local Search omitted usable coords — never invent 0m. */
  lat: number | null;
  lng: number | null;
  /** Null when coords unavailable — UI shows distance unavailable. */
  distanceM: number | null;
  source: "NAVER_LOCAL";
};

export const COMMERCE_CATEGORY_ORDER: CommerceCategory[] = [
  "MART",
  "CONVENIENCE",
  "CAFE",
  "RESTAURANT",
];

export const COMMERCE_CATEGORY_LABEL: Record<CommerceCategory, string> = {
  MART: "대형마트",
  CONVENIENCE: "편의점",
  CAFE: "카페",
  RESTAURANT: "음식점",
};

/** Display guard — not a census radius. */
export const COMMERCE_DISPLAY_MAX_METERS = 1500;

/** Max places shown per category in v1. */
export const COMMERCE_MAX_PER_CATEGORY = 2;

export type CommerceCategoryResult = {
  category: CommerceCategory;
  label: string;
  primaryQuery: string;
  fallbackQuery: string | null;
  usedFallback: boolean;
  apiCalls: number;
  rawCount: number;
  overRadiusRemoved: number;
  places: CommercePlace[];
  error?: string;
};

export type NearbyCommerceResult = {
  status: "READY" | "HOLD" | "EMPTY" | "ERROR";
  reason: string | null;
  source: "NAVER_LOCAL";
  cacheVersion: string;
  apiCallCount: number;
  duplicatesRemoved: number;
  overRadiusRemoved: number;
  categories: CommerceCategoryResult[];
  places: CommercePlace[];
};

function normalizeKey(p: {
  name: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  roadAddress: string | null;
}): string {
  const name = p.name.replace(/\s+/g, "").toLowerCase();
  const lat = p.lat != null ? p.lat.toFixed(5) : "noc";
  const lng = p.lng != null ? p.lng.toFixed(5) : "noc";
  const addr = (p.roadAddress || p.address || "")
    .replace(/\s+/g, "")
    .toLowerCase();
  return `${name}|${lat}|${lng}|${addr}`;
}

function itemToCandidate(
  item: NaverLocalSearchItem,
  category: CommerceCategory,
  center: LatLng,
  index: number,
): CommercePlace | null {
  const name = cleanNaverLocalTitle(item.title);
  if (!name) return null;
  const coords = parseNaverLocalCoords(item.mapx, item.mapy);
  const address = item.address?.trim() || null;
  const roadAddress = item.roadAddress?.trim() || null;

  if (!coords) {
    // Keep POI without inventing distance — list can show "거리 정보 없음".
    return {
      id: `commerce-${category}-${index}-${name}-nocords`,
      name,
      category,
      sourceCategory: item.category?.trim() || null,
      address,
      roadAddress,
      lat: null,
      lng: null,
      distanceM: null,
      source: "NAVER_LOCAL",
    };
  }

  const distanceM = Math.round(haversineMeters(center, coords));
  if (!Number.isFinite(distanceM) || distanceM < 0) return null;
  return {
    id: `commerce-${category}-${index}-${name}-${coords.lat.toFixed(5)}-${coords.lng.toFixed(5)}`,
    name,
    category,
    sourceCategory: item.category?.trim() || null,
    address,
    roadAddress,
    lat: coords.lat,
    lng: coords.lng,
    distanceM,
    source: "NAVER_LOCAL",
  };
}

function usableWithinDisplay(places: CommercePlace[]): {
  usable: CommercePlace[];
  overRadiusRemoved: number;
} {
  const usable: CommercePlace[] = [];
  let overRadiusRemoved = 0;
  for (const p of places) {
    // No coords: keep (distance unavailable). With coords: apply radius.
    if (p.distanceM == null) {
      usable.push(p);
    } else if (p.distanceM <= COMMERCE_DISPLAY_MAX_METERS) {
      usable.push(p);
    } else {
      overRadiusRemoved += 1;
    }
  }
  return { usable, overRadiusRemoved };
}

function sortCommercePlaces(a: CommercePlace, b: CommercePlace): number {
  // Known distances first (nearest), then distance-unavailable.
  if (a.distanceM == null && b.distanceM == null) return 0;
  if (a.distanceM == null) return 1;
  if (b.distanceM == null) return -1;
  return a.distanceM - b.distanceM;
}

async function searchCategory(params: {
  category: CommerceCategory;
  aptName: string;
  center: LatLng;
  sigungu: string | null;
  legalDong: string | null;
}): Promise<CommerceCategoryResult> {
  const label = COMMERCE_CATEGORY_LABEL[params.category];
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
    .filter((x): x is CommercePlace => !!x);

  let { usable, overRadiusRemoved } = usableWithinDisplay(candidates);

  // Fallback when nothing usable with distance, or only no-coord stubs.
  const hasDistance = usable.some((p) => p.distanceM != null);
  if (!hasDistance && fallbackQuery) {
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
        .filter((x): x is CommercePlace => !!x);
      const second = usableWithinDisplay(candidates);
      usable = second.usable;
      overRadiusRemoved += second.overRadiusRemoved;
    }
  }

  usable.sort(sortCommercePlaces);
  const places = usable.slice(0, COMMERCE_MAX_PER_CATEGORY);

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
 * Fetch commerce places for a complex (lazy commerce-tab path).
 * Max 4 primary Local Search calls; fallback only when primary unusable.
 */
export async function fetchNearbyCommercePlaces(params: {
  aptName: string;
  center: LatLng;
  sigungu?: string | null;
  legalDong?: string | null;
}): Promise<NearbyCommerceResult> {
  if (!isNaverLocalSearchConfigured()) {
    return {
      status: "HOLD",
      reason:
        "NAVER Local Search 인증이 없어 주변 상권 정보를 불러올 수 없습니다.",
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

  const categories: CommerceCategoryResult[] = [];
  let apiCallCount = 0;
  let overRadiusRemoved = 0;

  for (const category of COMMERCE_CATEGORY_ORDER) {
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
        label: COMMERCE_CATEGORY_LABEL[category],
        primaryQuery: `${aptName} ${COMMERCE_CATEGORY_LABEL[category]}`,
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
  const places: CommercePlace[] = [];
  for (const cat of categories) {
    const kept: CommercePlace[] = [];
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
