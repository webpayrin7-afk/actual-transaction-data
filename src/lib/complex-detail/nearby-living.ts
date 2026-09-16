/**
 * Living tab v1 — NAVER Local Search POIs near a complex.
 * Not a facility census / commerce aggregation.
 *
 * Pipeline: queries → merge → exact dedupe → semantic validate →
 * HOSPITAL parent/sub-facility collapse → type-specific radius →
 * nearest sort → return all valid (list cap is UI-only).
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
import { hospitalGeneralHospitalDistricts } from "@/lib/constants/seoul-sigungu-adjacency";

export type LivingCategory =
  | "MART"
  | "HOSPITAL"
  | "PHARMACY"
  | "CONVENIENCE"
  | "PARK";

export type LivingMedicalType = "GENERAL_MEDICAL" | "GENERAL_HOSPITAL";

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
  /** HOSPITAL only — sourceCategory 종합병원일 때만 GENERAL_HOSPITAL. */
  medicalType?: LivingMedicalType;
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

/** Per-category radius (post-filter). List initial visibility is UI-only (5). */
export const LIVING_CATEGORY_CONFIG: Record<
  LivingCategory,
  { radiusM: number; limit: number }
> = {
  HOSPITAL: { radiusM: 3000, limit: 50 },
  PHARMACY: { radiusM: 2000, limit: 50 },
  MART: { radiusM: 2000, limit: 50 },
  CONVENIENCE: { radiusM: 1500, limit: 50 },
  PARK: { radiusM: 2500, limit: 50 },
};

/** HOSPITAL: 의원/병원 vs 종합병원 radius (type after semantic). */
export const HOSPITAL_RADIUS_M = {
  GENERAL_MEDICAL: 3000,
  GENERAL_HOSPITAL: 5000,
} as const;

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
  rawCountC?: number;
  rawCountD?: number;
  extraQueries?: string[];
  semanticRejected?: number;
  /** HOSPITAL only — parent/sub-facility rows collapsed. */
  parentCollapsed?: number;
  overRadiusRemoved: number;
  places: LivingPlace[];
  error?: string;
};

/** Hospital Local Search budget: A+B medical + district 종합병원. */
const HOSPITAL_QUERY_BUDGET = 8;

/** Campus proximity for parent/child hospital pins (Asan ~135m). */
const HOSPITAL_CAMPUS_MAX_M = 200;

/** Child facility name suffixes — hospital tab only. */
const HOSPITAL_CHILD_SUFFIX_RE =
  /(?:\s*)(응급실|응급의료센터|응급센터|긴급진료실)\s*$/u;


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
      if (/약국/.test(cat) && !/병원|의원/.test(cat)) return false;
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

/** 종합병원 presentation — sourceCategory evidence only (never name heuristics). */
export function classifyHospitalPresentation(
  sourceCategory: string | null | undefined,
): LivingMedicalType {
  const cat = String(sourceCategory || "").trim();
  if (/종합병원/.test(cat)) return "GENERAL_HOSPITAL";
  return "GENERAL_MEDICAL";
}

function hospitalRadiusM(p: LivingPlace): number {
  if (p.medicalType === "GENERAL_HOSPITAL") {
    return HOSPITAL_RADIUS_M.GENERAL_HOSPITAL;
  }
  return HOSPITAL_RADIUS_M.GENERAL_MEDICAL;
}

function normalizeCampusAddress(addr: string | null | undefined): string {
  const raw = String(addr || "").replace(/\s+/g, "");
  if (!raw) return "";
  // Keep through 로/길 + street number when present.
  const road = raw.match(/^(.*?(?:로|길)\d+)/);
  if (road?.[1]) return road[1];
  // Jibun-style …동123-45
  const jibun = raw.match(/^(.*?동\d+(?:-\d+)?)/);
  if (jibun?.[1]) return jibun[1];
  return raw;
}

/** Infer parent hospital name from ER / sub-facility title. */
export function hospitalParentNameFromChild(name: string): string | null {
  const n = String(name || "").replace(/\s+/g, " ").trim();
  if (!n) return null;
  const m = n.match(HOSPITAL_CHILD_SUFFIX_RE);
  if (!m) return null;
  const parent = n.slice(0, m.index).trim();
  if (parent.length < 2) return null;
  // Require medical parent token — avoid collapsing unrelated POIs.
  if (!/(병원|의료원|센터)$/u.test(parent) && !/(병원|의료원)/u.test(parent)) {
    return null;
  }
  return parent;
}

function isHospitalChildFacility(p: LivingPlace): boolean {
  if (hospitalParentNameFromChild(p.name)) return true;
  const cat = String(p.sourceCategory || "");
  return /응급실/.test(cat) && /병원|의료/.test(cat);
}

function hospitalNamesCompatible(parentLike: string, childLike: string): boolean {
  const p = parentLike.replace(/\s+/g, "").toLowerCase();
  const c = childLike.replace(/\s+/g, "").toLowerCase();
  if (!p || !c) return false;
  if (p === c) return true;
  if (c.startsWith(p) || p.startsWith(c)) return true;
  const childParent = hospitalParentNameFromChild(childLike)
    ?.replace(/\s+/g, "")
    .toLowerCase();
  if (childParent && (childParent === p || p.startsWith(childParent) || childParent.startsWith(p))) {
    return true;
  }
  return false;
}

function sameHospitalCampus(a: LivingPlace, b: LivingPlace): boolean {
  const roadA = normalizeCampusAddress(a.roadAddress);
  const roadB = normalizeCampusAddress(b.roadAddress);
  if (roadA && roadB && roadA === roadB) return true;
  const addrA = normalizeCampusAddress(a.address);
  const addrB = normalizeCampusAddress(b.address);
  if (addrA && addrB && addrA === addrB) return true;
  const dist = haversineMeters(
    { lat: a.lat, lng: a.lng },
    { lat: b.lat, lng: b.lng },
  );
  return Number.isFinite(dist) && dist <= HOSPITAL_CAMPUS_MAX_M;
}

function hospitalRepresentativeScore(p: LivingPlace): number {
  let score = 0;
  if (p.medicalType === "GENERAL_HOSPITAL") score += 100;
  if (!isHospitalChildFacility(p)) score += 50;
  if (/종합병원/.test(String(p.sourceCategory || ""))) score += 20;
  // Prefer shorter canonical titles (본원 over 응급의료센터).
  score += Math.max(0, 40 - p.name.length);
  // Prefer nearer pin only as weak tie-break.
  score -= Math.min(p.distanceM, 5000) / 5000;
  return score;
}

/**
 * HOSPITAL-only: collapse parent hospital + ER/sub-facility when
 * parent-name compatible AND same campus (address or ~200m).
 * Does not merge unrelated clinics sharing a building.
 */
export function collapseHospitalParentFacilities(
  places: LivingPlace[],
): { places: LivingPlace[]; collapsed: number } {
  if (places.length < 2) return { places, collapsed: 0 };

  const kept = [...places];
  const remove = new Set<number>();
  let collapsed = 0;

  const pairEligible = (a: LivingPlace, b: LivingPlace): boolean => {
    if (!hospitalNamesCompatible(a.name, b.name)) return false;
    if (!sameHospitalCampus(a, b)) return false;
    const aChild = isHospitalChildFacility(a);
    const bChild = isHospitalChildFacility(b);
    if (aChild && bChild) {
      const pa = hospitalParentNameFromChild(a.name)?.replace(/\s+/g, "");
      const pb = hospitalParentNameFromChild(b.name)?.replace(/\s+/g, "");
      return !!pa && !!pb && pa === pb;
    }
    // Exactly one child, or explicit parent-of relation via suffix strip.
    if (aChild !== bChild) return true;
    const parentOfB = hospitalParentNameFromChild(b.name);
    const parentOfA = hospitalParentNameFromChild(a.name);
    if (parentOfB && hospitalNamesCompatible(a.name, parentOfB)) return true;
    if (parentOfA && hospitalNamesCompatible(b.name, parentOfA)) return true;
    return false;
  };

  for (let i = 0; i < kept.length; i++) {
    if (remove.has(i)) continue;
    for (let j = i + 1; j < kept.length; j++) {
      if (remove.has(j)) continue;
      const a = kept[i]!;
      const b = kept[j]!;
      if (!pairEligible(a, b)) continue;

      const preferA =
        hospitalRepresentativeScore(a) >= hospitalRepresentativeScore(b);
      const winner = preferA ? a : b;
      const loser = preferA ? b : a;
      const loserIdx = preferA ? j : i;

      // Inherit 종합병원 evidence onto the surviving row when available.
      if (
        loser.medicalType === "GENERAL_HOSPITAL" &&
        winner.medicalType !== "GENERAL_HOSPITAL"
      ) {
        winner.medicalType = "GENERAL_HOSPITAL";
        if (
          /종합병원/.test(String(loser.sourceCategory || "")) &&
          !/종합병원/.test(String(winner.sourceCategory || ""))
        ) {
          winner.sourceCategory = loser.sourceCategory;
        }
      }
      remove.add(loserIdx);
      collapsed += 1;
      if (loserIdx === i) break;
    }
  }

  return { places: kept.filter((_, idx) => !remove.has(idx)), collapsed };
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
    ...(category === "HOSPITAL"
      ? { medicalType: classifyHospitalPresentation(item.category) }
      : {}),
  };
}

async function searchCategory(params: {
  category: LivingCategory;
  aptName: string;
  center: LatLng;
  sigungu: string | null;
  legalDong: string | null;
  nearbyDongs?: string[] | null;
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
  let itemsC: NaverLocalSearchItem[] = [];
  let itemsD: NaverLocalSearchItem[] = [];
  const extraHospitalItems: NaverLocalSearchItem[] = [];
  const extraQueries: string[] = [];

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

  // HOSPITAL: A+B keep general medical; district 종합병원 for current+adjacent.
  // Remove weak legalDong/nearby-dong 종합병원 fan-out.
  if (params.category === "HOSPITAL") {
    const districts = hospitalGeneralHospitalDistricts(params.sigungu);
    for (const district of districts) {
      if (apiCalls >= HOSPITAL_QUERY_BUDGET) break;
      const q = `${district} 종합병원`.trim();
      if (!q || extraQueries.includes(q)) continue;
      extraQueries.push(q);
      const extra = await fetchNaverLocalSearch({ query: q, display: 5 });
      apiCalls += 1;
      if (!extra.ok && !error) error = extra.error;
      if (extra.ok) {
        if (itemsC.length === 0) itemsC = extra.items;
        else extraHospitalItems.push(...extra.items);
      }
    }
  }

  // MART C/D: 하나로마트 + 대형마트 (max 4 sources).
  if (params.category === "MART" && params.sigungu && params.legalDong) {
    const qC = `${params.sigungu} ${params.legalDong} 하나로마트`.trim();
    const qD = `${params.sigungu} ${params.legalDong} 대형마트`.trim();
    extraQueries.push(qC, qD);
    const extraC = await fetchNaverLocalSearch({ query: qC, display: 5 });
    apiCalls += 1;
    if (!extraC.ok && !error) error = extraC.error;
    if (extraC.ok) itemsC = extraC.items;
    const extraD = await fetchNaverLocalSearch({ query: qD, display: 5 });
    apiCalls += 1;
    if (!extraD.ok && !error) error = extraD.error;
    if (extraD.ok) itemsD = extraD.items;
  }

  const mergedItems: Array<{ item: NaverLocalSearchItem; index: number }> = [
    ...itemsA.map((item, i) => ({ item, index: i })),
    ...itemsB.map((item, i) => ({ item, index: 100 + i })),
    ...itemsC.map((item, i) => ({ item, index: 200 + i })),
    ...itemsD.map((item, i) => ({ item, index: 300 + i })),
    ...extraHospitalItems.map((item, i) => ({ item, index: 400 + i })),
  ];

  const candidates = mergedItems
    .map(({ item, index }) =>
      itemToCandidate(item, params.category, params.center, index),
    )
    .filter((x): x is LivingPlace => !!x);

  // Per-category exact dedupe before semantic/radius.
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

  let parentCollapsed = 0;
  let afterCollapse = semanticOk;
  if (params.category === "HOSPITAL") {
    const collapsed = collapseHospitalParentFacilities(semanticOk);
    afterCollapse = collapsed.places;
    parentCollapsed = collapsed.collapsed;
  }

  let overRadiusRemoved = 0;
  const withinRadius: LivingPlace[] = [];
  for (const p of afterCollapse) {
    const maxM =
      params.category === "HOSPITAL" ? hospitalRadiusM(p) : radiusM;
    if (p.distanceM <= maxM) withinRadius.push(p);
    else overRadiusRemoved += 1;
  }

  withinRadius.sort((a, b) => a.distanceM - b.distanceM);
  // Return all radius-valid POIs. Initial list visibility (5) is UI-only so
  // map markers can show the full valid set.
  const places = withinRadius.slice(0, limit);

  return {
    category: params.category,
    label,
    primaryQuery,
    fallbackQuery: secondaryQuery,
    usedFallback: usedSecondary,
    apiCalls,
    rawCount:
      itemsA.length +
      itemsB.length +
      itemsC.length +
      itemsD.length +
      extraHospitalItems.length,
    rawCountA: itemsA.length,
    rawCountB: itemsB.length,
    rawCountC: itemsC.length,
    rawCountD: itemsD.length + extraHospitalItems.length,
    extraQueries,
    semanticRejected,
    parentCollapsed,
    overRadiusRemoved,
    places,
    error,
  };
}

/**
 * Fetch living places for a complex (lazy living-tab path).
 * Max Local Search: HOSPITAL ≤8 + MART 4 + others 2 each.
 */
export async function fetchNearbyLivingPlaces(params: {
  aptName: string;
  center: LatLng;
  sigungu?: string | null;
  legalDong?: string | null;
  /** @deprecated Hospital coverage uses Seoul adjacency districts, not dongs. */
  nearbyDongs?: string[] | null;
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
        nearbyDongs: params.nearbyDongs ?? null,
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
